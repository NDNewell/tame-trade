// src/exchange/exchangeClient.ts

import { pro as ccxtpro, Exchange, Market, Order } from 'ccxt';
import ccxt from 'ccxt';
import ora, { spinners } from 'ora';
import { ConfigManager } from '../config/configManager.js';
import { ErrorEvent, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { exchangeParams } from './exchangeParams.js';
import { parse } from 'path';
import readline from 'readline';
import https from 'https';
import {
  calculatePositionRisk,
  PositionRiskResult,
  ProtectiveStopTranche,
} from '../trading/positionRisk.js';
import { describeExchangeError, isMissingOrderError } from '../utils/exchangeErrors.js';
import { NotificationManager } from '../utils/notificationManager.js';
import { NType } from '../utils/notificationManager.js';

// Define a more flexible Position interface to handle ccxt's types
interface Position {
  symbol: string;
  contracts?: number | undefined;
  notional?: number | undefined;
  side: string | any; // Use any to accommodate ccxt's Str type
  entryPrice?: number;
}

interface StopOrder extends Order {
  stopPrice: number;
  stopDirection: 'Rising' | 'Falling';
  trigger: 'ByLastPrice' | 'ByMarkPrice' | 'ByIndexPrice';
  pegOffsetValueRp: number;
  pegOffsetProportionRr: number;
}

export class ExchangeClient {
  private static instance: ExchangeClient | null = null;
  private availableMarkets: Record<string, Market> | null = null;
  private supportedExchanges: string[] | null = null;
  exchange: Exchange | null = null;
  exchangeManager: ConfigManager;
  private ws: WebSocket | null = null;
  private eventEmitter: EventEmitter;
  private chaseLimitOrderActive: boolean = false;
  private fatFingerLimit: number | undefined = undefined;
  private confirmThreshold: number | undefined = undefined;
  // The order the chase is currently working. It changes whenever a move is
  // done as cancel/replace, so 'cancel chase' has to read it from here rather
  // than remember the id the chase started with — otherwise it cancels an order
  // that is already gone and leaves the live one resting.
  private currentChaseOrderId: string | undefined = undefined;
  private tickerStreams = new Map<
    string,
    { price: number | undefined; at: number; running: boolean }
  >();
  /**
   * Mark, index and funding come from one call, cached: funding moves every few
   * hours and index barely differs second to second, so refetching them on every
   * two-second repaint would spend the rate limit on values that haven't changed.
   */
  private fundingCache = new Map<
    string,
    { at: number; mark?: number; index?: number; funding?: number }
  >();
  /** Looked up once per session; it does not change while connected. */
  private accountLabel: string | undefined;
  private equityCache: { at: number; currency: string; equity?: number } | undefined;
  private accountLookupDone = false;
  /** The market being followed, so account lookups know which wallet to ask for. */
  private lastFollowedMarket: string | undefined;
  private orderStreams = new Map<
    string,
    {
      orders: Map<string, Order>;
      filledSoFar: Map<string, number>;
      running: boolean;
      healthy: boolean;
      syncedAt: number;
    }
  >();

  private constructor() {
    this.exchangeManager = new ConfigManager();
    this.supportedExchanges = [];
    this.eventEmitter = new EventEmitter();
    this.chaseLimitOrderActive = false;
  }

  static getInstance(): ExchangeClient {
    if (!this.instance) {
      this.instance = new ExchangeClient();
    }
    return this.instance;
  }

  async init(exchangeId?: string): Promise<void> {
    if (exchangeId) {
      await this.setExchange(exchangeId);
      await this.loadMarkets();
    }
    await this.loadExchanges();
  }

  public getAvailableMethods(): Record<string, boolean | 'emulated'> {
    return this.exchange!.has;
  }

  isInitialized(): boolean {
    return this.supportedExchanges !== null;
  }

  logAndReplace(msg: string) {
    NotificationManager.notify(msg, NType.INFO, 'ORDER');
  }

  async watchOrderBook(symbol: string): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient/watchOrderBook] Exchange not initialized. Please call 'init' or 'setExchange' before fetching order book.`
      );
      return;
    }

    if (!this.exchange.has.ws) {
      console.error(
        `[ExchangeClient/watchOrderBook] WebSocket not supported for the current exchange (${this.exchange.name}).`
      );
      return;
    }

    console.log(
      `[ExchangeClient/watchOrderBook] Subscribing to order book for ${symbol}`
    );
    try {
      while (true) {
        const orderbook = await this.exchange.watchOrderBook(symbol);
        console.log(new Date(), orderbook['asks'][0], orderbook['bids'][0]);
      }
    } catch (error) {
      console.error(
        `[ExchangeClient/watchOrderBook] Failed to subscribe to order book:`,
        error
      );
    }
  }

  async loadExchanges(): Promise<void> {
    const supportedExchanges: Set<string> = new Set();
    const exchangeIds = ccxt.exchanges;
    for (let i = 0; i < exchangeIds.length; i++) {
      const exchangeId = exchangeIds[i];
      try {
        const exchange = new (ccxtpro as any)[exchangeId]();
        if (exchange.has.ws) {
          supportedExchanges.add(exchange.name);
        }
      } catch (e) {
        continue;
      }
    }
    this.supportedExchanges = Array.from(supportedExchanges);
  }

  getMarketStructure(market: string): void {
    const marketStructure = Object.values(this.availableMarkets!).filter(
      (marketObj) => marketObj?.symbol === market
    )[0];
    console.log(marketStructure);
  }

  async loadMarkets(): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return;
    }

    try {
      this.availableMarkets = await this.exchange.loadMarkets();
    } catch (error) {
      const failure = describeExchangeError(error);
      NotificationManager.diagnostic(`[loadMarkets] ${failure.raw}`);
      NotificationManager.notify(`Could not load markets: ${failure.summary}`, NType.ERROR, 'ERROR');
    }
  }

  async setExchange(exchangeId: string): Promise<void> {
    console.log(`[ExchangeClient] Setting exchange to ${exchangeId}...`);
    const credentials = await this.exchangeManager.getExchangeCredentials(exchangeId);

    const exchangeConfig: any = {
      enableRateLimit: true,
      // Force IPv4. On networks without IPv6 (most VPNs drop it), the AAAA
      // lookup for api.phemex.com goes unanswered and stalls ~12s, blowing
      // ccxt's 10s timeout before the request is even sent.
      agent: new https.Agent({ family: 4 }),
      options: {
        defaultType: 'future',
        adjustForTimeDifference: true,
      }
    };

    if (exchangeId.toLowerCase() === 'hyperliquid') {
      if (!credentials.privateKey || !credentials.walletAddress) {
        throw new Error('Private key and wallet address are required for Hyperliquid');
      }
      exchangeConfig.privateKey = credentials.privateKey;
      exchangeConfig.walletAddress = credentials.walletAddress;
      exchangeConfig.publicAddress = credentials.publicAddress || credentials.walletAddress;
      exchangeConfig.options.defaultSlippage = 0.05;
    } else {
      if (!credentials.key || !credentials.secret) {
        throw new Error('API key and secret are required for this exchange');
      }
      exchangeConfig.apiKey = credentials.key;
      exchangeConfig.secret = credentials.secret;
    }

    // Feeds belong to the exchange instance being replaced; leaving them running
    // would keep sockets open against an exchange no longer in use.
    this.stopTickerStream();
    this.stopOrderStream();

    this.exchange = new (ccxtpro as any)[exchangeId.toLowerCase()](exchangeConfig);

    await this.loadMarkets();
    await this.loadExchanges();
    await this.loadFatFingerLimit();
    await this.loadConfirmThreshold();
    this.setEventListeners();

    // Call the time synchronization method here
    await this.synchronizeTimeWithExchange();
  }

  async getMarketTypes(): Promise<string[]> {
    const availableTypes = new Set<string>();
    if (this.availableMarkets !== null) {
      Object.values(this.availableMarkets).forEach((market) => {
        if (market?.type) {
          availableTypes.add(market.type);
        }
      });

      return Array.from(availableTypes);
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }
  }

  getSupportedExchanges(): string[] {
    return this.supportedExchanges || [];
  }

  getExchangeInstance(): Exchange | null {
    return this.exchange;
  }

  getSelectedExchangeName(): string | null {
    return this.exchange ? String(this.exchange.name ?? '') : null;
  }

  async getMarketSymbols(): Promise<Array<string>> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }

    if (this.availableMarkets !== null) {
      return Object.keys(this.availableMarkets);
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }
  }

  async getMarketByType(type: string): Promise<Array<string>> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }

    if (this.availableMarkets !== null) {
      return Object.keys(this.availableMarkets).filter(
        (symbol) => this.availableMarkets![symbol]?.type === type
      );
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }
  }

  trimAmount(amount: number): string {
    const trimmedAmount = amount.toFixed(
      Math.max(
        2,
        amount.toString().split('.')[1]?.replace(/0+$/, '').length || 0
      )
    );

    return trimmedAmount;
  }

  setEventListeners(): void {
    this.eventEmitter.on('limitOrderFilled', (data) => {
      console.log(
        `${data.side[0].toUpperCase()}${data.side.slice(1)} limit filled ${
          data.filled
        } @${data.price}`
      );
    });

    this.eventEmitter.on('orderCanceled', (data) => {
      console.log(
        `${data.side[0].toUpperCase()}${data.side.slice(1)} order canceled!`
      );
    });
  }

  getFatFingerLimit(): number | undefined {
    return this.fatFingerLimit;
  }

  /**
   * Position values ready for display, with unrealized PnL computed here rather
   * than read from the exchange payload. getPositionStructure has several
   * fallback paths that return differently shaped objects, so the field is not
   * dependable; entry, mark and size are, and the arithmetic is not in doubt.
   */
  async getPositionView(market: string): Promise<{
    side: string;
    size: number;
    entry?: number;
    unrealizedPnl?: number;
    realizedPnl?: number;
    leverage?: number;
    effectiveLeverage?: number;
    liquidation?: number;
    currency: string;
  } | null> {
    const position = await this.getPositionStructure(market);
    const contracts = Math.abs(Number(position?.contracts ?? 0));
    if (!position || contracts === 0) return null;

    const info = position as any;
    const marketInfo = this.availableMarkets?.[market];
    const contractSize = Number(marketInfo?.contractSize ?? 1);
    const currency = String(marketInfo?.settle ?? marketInfo?.quote ?? '');

    const entry = Number(position.entryPrice ?? info.entryPrice ?? NaN);
    const mark = await this.getReferencePrice(market);
    const isLong = String(position.side ?? '').toLowerCase() === 'long';

    let unrealizedPnl: number | undefined;
    if (Number.isFinite(entry) && mark !== undefined && entry > 0) {
      const direction = isLong ? 1 : -1;
      unrealizedPnl = marketInfo?.inverse
        ? contracts * contractSize * (1 / entry - 1 / mark) * direction
        : contracts * contractSize * (mark - entry) * direction;
    }

    return {
      side: String(position.side ?? '').toUpperCase(),
      size: contracts,
      entry: Number.isFinite(entry) ? entry : undefined,
      unrealizedPnl,
      realizedPnl: this.readRealizedPnl(info),
      leverage: Number(info.leverage) || undefined,
      effectiveLeverage: await this.getEffectiveLeverage(
        market,
        Math.abs(Number(position.notional ?? info.valueRv ?? NaN)),
        currency
      ),
      liquidation: Number(info.liquidationPrice) || undefined,
      currency,
    };
  }

  /**
   * Effective leverage: what the position is actually levered at right now, as
   * opposed to the leverage the account is configured for.
   *
   * Phemex reports only the configured figure, so this is derived: the
   * position's notional over the wallet balance.
   *
   * Unrealized PnL is deliberately excluded from the denominator. Including it
   * put the figure a few percent under what Phemex displays -- with a position
   * showing +193 against a 3,737 balance, this read 23.82x where the exchange
   * said 25.05x, a gap that is exactly the size of the unrealized amount. The
   * exchange divides by wallet balance, so this does too: a figure that
   * disagrees with the one on the exchange screen is worse than no figure.
   *
   * Undefined when the balance can't be established.
   */
  private async getEffectiveLeverage(
    market: string,
    notional: number | undefined,
    currency: string
  ): Promise<number | undefined> {
    if (notional === undefined || !(notional > 0)) return undefined;

    const balance = await this.getAccountBalance(currency);
    if (balance === undefined || !(balance > 0)) return undefined;

    return notional / balance;
  }

  /**
   * Realized PnL for the current position, read from the raw payload.
   *
   * ccxt's parsed position has no realizedPnl for Phemex -- it only computes
   * unrealizedPnl -- so taking profit on part of a position showed nothing. The
   * exchange reports it under curTermRealisedPnl, which is the realized amount
   * for the position as currently held rather than for all time.
   *
   * USDT-settled markets report real values ('Rv'); inverse markets report them
   * scaled ('Ev'), by the exchange's fixed 1e8 factor.
   */
  private readRealizedPnl(position: Record<string, any>): number | undefined {
    // The realized figure lives in the raw exchange payload, not on the parsed
    // position -- unlike leverage and liquidation price, which ccxt lifts to the
    // top level. Both shapes are accepted because getPositionStructure has
    // several fallback paths that return differently shaped objects.
    const info = position?.info ?? position;
    const real = info?.curTermRealisedPnlRv ?? info?.cumClosedPnlRv;
    if (real !== undefined && real !== null && Number.isFinite(Number(real))) {
      return Number(real);
    }

    const scaled = info?.curTermRealisedPnlEv ?? info?.cumClosedPnlEv;
    if (scaled !== undefined && scaled !== null && Number.isFinite(Number(scaled))) {
      return Number(scaled) / 1e8;
    }

    return undefined;
  }

  /**
   * Which open orders actually protect the current position.
   *
   * Not every reducing order is a stop. A take profit could close the same
   * quantity under favourable conditions, but it does nothing for the downside,
   * so counting it would understate risk. The exchange distinguishes them by
   * order type -- a trigger on the losing side is a Stop, one on the winning
   * side is a MarketIfTouched -- which is more reliable than comparing the
   * trigger to the entry, since a stop moved past breakeven is still a stop.
   */
  private toProtectiveStops(
    orders: Order[],
    market: string,
    positionSide: 'long' | 'short'
  ): ProtectiveStopTranche[] {
    const closingSide = positionSide === 'long' ? 'sell' : 'buy';

    return orders
      .filter((order) => {
        // Another instrument's stop protects another position.
        if (order.symbol && order.symbol !== market) return false;

        // Only orders that could close this position.
        if (String(order.side ?? '').toLowerCase() !== closingSide) return false;

        // Anything already finished no longer protects anything.
        const status = String(order.status ?? 'open').toLowerCase();
        if (['canceled', 'cancelled', 'rejected', 'expired', 'closed', 'filled'].includes(status)) {
          return false;
        }

        const info = (order as any).info ?? {};
        const trigger = Number((order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp ?? 0);
        if (!(trigger > 0)) return false;

        const orderType = String(info.ordType ?? info.orderType ?? order.type ?? '').toLowerCase();

        // Touch orders are take profits: they trigger on the winning side.
        if (orderType.includes('iftouched')) return false;

        return orderType.includes('stop') || orderType === 'trigger';
      })
      .map((order) => {
        const info = (order as any).info ?? {};
        const trigger = Number((order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp ?? 0);
        const requested = Number(order.remaining ?? order.amount ?? 0);
        const execInst = String(info.execInst ?? '');

        return {
          orderId: String(order.id ?? ''),
          triggerPrice: trigger,
          requestedQuantity: requested,
          // A quantity of zero on a trigger order means the whole position,
          // which follows the position rather than the size at creation.
          coversAll: !(requested > 0),
          reduceOnly:
            (order as any).reduceOnly === true || /closeontrigger|reduceonly/i.test(execInst),
          orderGroup: info.orderGroup ?? info.clOrdIDGroup ?? undefined,
        };
      });
  }

  /**
   * Planned downside for the current position, from its protective stops.
   * Returns undefined when there is no position to speak of.
   */
  async getPositionRisk(market: string): Promise<PositionRiskResult | undefined> {
    const position = await this.getPositionView(market);
    if (!position || !(position.size > 0) || position.entry === undefined) {
      return undefined;
    }

    const side = position.side.toLowerCase() === 'long' ? 'long' : 'short';
    const marketInfo = this.availableMarkets?.[market];

    let orders: Order[] = [];
    try {
      orders = await this.getLiveOpenOrders(market);
    } catch {
      orders = [];
    }

    return calculatePositionRisk({
      side,
      quantity: position.size,
      entryPrice: position.entry,
      currency: position.currency,
      contractSize: Number((marketInfo as any)?.contractSize ?? 1),
      inverse: Boolean((marketInfo as any)?.inverse),
      stops: this.toProtectiveStops(orders, market, side),
    });
  }

  /** Open orders for display. Uses the live view; completeness isn't critical. */
  async getOpenOrdersForDisplay(market: string): Promise<Order[]> {
    try {
      return await this.getLiveOpenOrders(market);
    } catch {
      return [];
    }
  }

  private static readonly FUNDING_CACHE_MS = 15000;

  /** Mark price, index price and funding rate, refreshed at a sensible interval. */
  private async getFundingSnapshot(market: string) {
    const cached = this.fundingCache.get(market);
    if (cached && Date.now() - cached.at <= ExchangeClient.FUNDING_CACHE_MS) {
      return cached;
    }

    const snapshot: { at: number; mark?: number; index?: number; funding?: number } = {
      at: Date.now(),
    };

    try {
      const rate = await this.exchange!.fetchFundingRate(market);
      snapshot.mark = Number(rate.markPrice) || undefined;
      snapshot.index = Number(rate.indexPrice) || undefined;
      snapshot.funding =
        rate.fundingRate === undefined || rate.fundingRate === null
          ? undefined
          : Number(rate.fundingRate);
    } catch {
      // Not every instrument has a funding rate; leave the fields unset rather
      // than inventing them.
    }

    this.fundingCache.set(market, snapshot);
    return snapshot;
  }

  /** Seconds between funding payments, as the instrument reports them. */
  private fundingIntervalSeconds(market: string): number | undefined {
    const seconds = Number(
      (this.availableMarkets?.[market]?.info as any)?.fundingInterval
    );
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  private formatFunding(market: string, rate: number): string {
    const perInterval = `${(rate * 100).toFixed(4)}%`;
    const interval = this.fundingIntervalSeconds(market);

    // Without a known interval there is no honest way to annualise it.
    if (interval === undefined) return perInterval;

    const periodsPerYear = 31536000 / interval;
    const apr = rate * periodsPerYear * 100;

    return `${perInterval} (${apr.toFixed(2)}% APR)`;
  }

  /**
   * The account the keys belong to, for the header. Read once: it can't change
   * while connected, and it costs an authenticated call.
   */
  async getAccountLabel(): Promise<string | undefined> {
    if (this.accountLookupDone) return this.accountLabel;
    this.accountLookupDone = true;

    try {
      const balance: any = await this.fetchAccountSnapshot(
        this.availableMarkets?.[this.lastFollowedMarket ?? '']?.settle
      );
      const info = balance?.info?.data ?? balance?.info ?? {};
      const account = info.account ?? info;

      const id =
        account.accountId ??
        account.accountID ??
        info.accountId ??
        info.accountID ??
        account.userID ??
        account.userId ??
        info.userID ??
        info.userId;

      this.accountLabel = id === undefined || id === null ? undefined : String(id);
    } catch {
      this.accountLabel = undefined;
    }

    return this.accountLabel;
  }

  private static readonly EQUITY_CACHE_MS = 10000;

  /**
   * Balance for a settlement currency.
   *
   * The client is configured with defaultType 'future', which ccxt rejects for
   * this call -- it accepts only 'spot' and 'swap' -- so every balance lookup
   * was throwing before it reached the exchange. The type and settlement
   * currency are named explicitly here rather than inherited.
   */
  private async fetchAccountSnapshot(currency?: string): Promise<any> {
    const settle = currency ?? 'USDT';
    return this.exchange!.fetchBalance({ type: 'swap', code: settle });
  }

  /**
   * Account balance in a settlement currency, cached briefly.
   *
   * Effective leverage needs account equity, and the balance call is
   * authenticated, so it is not made on every repaint.
   */
  private async getAccountBalance(currency: string): Promise<number | undefined> {
    const cached = this.equityCache;
    if (
      cached &&
      cached.currency === currency &&
      Date.now() - cached.at <= ExchangeClient.EQUITY_CACHE_MS
    ) {
      return cached.equity;
    }

    let equity: number | undefined;
    try {
      const balance: any = await this.fetchAccountSnapshot(currency);
      const total = balance?.total?.[currency];
      equity = Number.isFinite(Number(total)) ? Number(total) : undefined;
    } catch {
      equity = undefined;
    }

    this.equityCache = { at: Date.now(), currency, equity };
    return equity;
  }

  /** The market values the workspace shows, taken from the feeds where possible. */
  async getDisplayPrice(market: string): Promise<{
    last?: number;
    bid?: number;
    ask?: number;
    mark?: number;
    index?: number;
    spread?: string;
    funding?: string;
    change?: string;
  }> {
    const last = await this.getReferencePrice(market);
    let bid: number | undefined;
    let ask: number | undefined;

    try {
      const book = await this.exchange!.fetchL2OrderBook(market, 1);
      bid = book.bids?.[0]?.[0];
      ask = book.asks?.[0]?.[0];
    } catch {
      // Book unavailable this tick; the rest of the view is still worth showing.
    }

    const spread =
      bid !== undefined && ask !== undefined ? (ask - bid).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : undefined;

    const funding = await this.getFundingSnapshot(market);

    return {
      last,
      bid,
      ask,
      mark: funding.mark,
      index: funding.index,
      spread,
      // Quoted as a percentage, with the annualised equivalent alongside: the
      // per-interval figure is small enough to look negligible, and the yearly
      // one is what tells you whether holding the position actually costs
      // anything. The interval comes from the instrument rather than assuming
      // the usual eight hours.
      funding:
        funding.funding === undefined
          ? undefined
          : this.formatFunding(market, funding.funding),
    };
  }

  getConfirmThreshold(): number | undefined {
    return this.confirmThreshold;
  }

  async setConfirmThreshold(threshold: number | undefined): Promise<void> {
    await this.exchangeManager.setConfirmAbove(threshold);
    this.confirmThreshold = threshold;
  }

  async loadConfirmThreshold(): Promise<void> {
    try {
      this.confirmThreshold = await this.exchangeManager.getConfirmAbove();
    } catch {
      this.confirmThreshold = undefined;
    }
  }

  /**
   * What an order is worth, for showing before it is sent and for deciding
   * whether it needs confirming. Confirmation is threshold-based rather than
   * universal: a prompt on every order would make a tool built for speed
   * unusable, and would train the reflex of confirming without reading.
   */
  async describeOrder(
    market: string,
    quantity: number,
    price?: number
  ): Promise<{ notional: number; currency: string; needsConfirmation: boolean }> {
    const { notional, currency } = await this.calculateNotional(market, quantity, price);

    return {
      notional,
      currency,
      needsConfirmation:
        this.confirmThreshold !== undefined && notional >= this.confirmThreshold,
    };
  }

  async setFatFingerLimit(limit: number | undefined): Promise<void> {
    await this.exchangeManager.setFatFinger(limit);
    this.fatFingerLimit = limit;
  }

  async loadFatFingerLimit(): Promise<void> {
    try {
      this.fatFingerLimit = await this.exchangeManager.getFatFinger();
    } catch (error) {
      // A profile that can't be read must not leave the guard silently off.
      this.fatFingerLimit = undefined;
      console.error(
        `[ExchangeClient] Could not read the fatfinger limit; no size limit is active.`,
        (error as Error).message
      );
    }
  }

  // How stale a streamed price may be before it is fetched again. Long enough
  // that a quiet market doesn't force a REST call, short enough that nothing
  // acts on a price from a different market condition.
  private static readonly STREAMED_PRICE_MAX_AGE_MS = 5000;

  // Keeps the last traded price for a market current from the exchange's ticker
  // feed. Every stop and market order needs a reference price, and taking it
  // from a stream rather than a request removes a round trip from paths that are
  // typed in a hurry.
  private startTickerStream(market: string): void {
    if (!this.exchange?.has['watchTicker']) return;
    if (this.tickerStreams.get(market)?.running) return;

    const state = { price: undefined as number | undefined, at: 0, running: true };
    this.tickerStreams.set(market, state);

    void (async () => {
      while (state.running && this.exchange) {
        try {
          const ticker = await this.exchange.watchTicker(market);
          const last = ticker.last ?? ticker.close ?? undefined;

          if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
            state.price = last;
            state.at = Date.now();
          }
        } catch (error) {
          // The feed is a shortcut, not a dependency. Stop the loop and let
          // callers fall back to fetching, rather than surfacing an error for
          // something the trader never asked for.
          state.running = false;
          return;
        }
      }
    })();
  }

  // A resynced snapshot older than this is not trusted, on the theory that a
  // feed which has gone quiet for a minute may have missed something.
  private static readonly ORDER_CACHE_MAX_AGE_MS = 60000;

  // Keeps a live view of open orders for a market: a REST snapshot to start,
  // then updates applied from the order feed as they arrive.
  //
  // watchOrders reports changes, not the whole set, so this view is only as
  // complete as the snapshot it started from plus every event since. If the feed
  // drops, it can silently fall behind — so it is marked unhealthy on any error
  // and callers that need completeness fetch instead. See getLiveOpenOrders.
  private startOrderStream(
    market: string,
    params?: Record<string, any>,
    snapshot?: Order[]
  ): void {
    if (!this.exchange?.has['watchOrders']) return;
    if (this.orderStreams.get(market)?.running) return;

    const state = {
      orders: new Map<string, Order>(),
      filledSoFar: new Map<string, number>(),
      running: true,
      healthy: false,
      syncedAt: 0,
    };
    this.orderStreams.set(market, state);

    void (async () => {
      try {
        // Callers normally have just fetched the orders themselves; seeding from
        // that avoids asking for the same thing twice.
        const seed =
          snapshot ??
          (await this.exchange!.fetchOpenOrders(market, undefined, undefined, params));

        for (const order of seed) {
          if (!order.id) continue;
          state.orders.set(order.id, order);
          // Record what is already filled so the first event doesn't announce
          // fills that happened before the session started watching.
          state.filledSoFar.set(order.id, Number(order.filled ?? 0));
        }

        state.healthy = true;
        state.syncedAt = Date.now();
      } catch {
        state.running = false;
        return;
      }

      while (state.running && this.exchange) {
        try {
          const updates = await this.exchange.watchOrders(market);

          for (const update of updates) {
            if (!update.id) continue;

            const status = String(update.status ?? '');
            const done =
              status === 'closed' || status === 'canceled' || status === 'rejected';

            // Report what the exchange says happened, before updating the view.
            this.announceOrderUpdate(market, update, state);

            if (done) {
              state.orders.delete(update.id);
              state.filledSoFar.delete(update.id);
            } else {
              state.orders.set(update.id, update);
            }
          }

          state.syncedAt = Date.now();
        } catch {
          // Fell behind; the view can no longer be trusted to be complete.
          state.healthy = false;
          state.running = false;
          return;
        }
      }
    })();
  }

  // Reports what actually happened to an order, from the exchange's own event
  // rather than from the response to the request that created it. A 200 means
  // the order was accepted; it says nothing about whether it filled, and an
  // order can be rejected, cancelled or filled long after the call returned.
  private announceOrderUpdate(
    market: string,
    update: Order,
    state: { filledSoFar: Map<string, number> }
  ): void {
    const id = update.id;
    if (!id) return;

    // The chase narrates its own order; two messages for one event is worse
    // than one.
    if (id === this.currentChaseOrderId) return;

    const status = String(update.status ?? '');
    const side = String(update.side ?? 'order');
    const symbol = market.split(':')[0];
    const eventTime = this.orderEventTime(update);
    const filled = Number(update.filled ?? 0);
    const previouslyFilled = state.filledSoFar.get(id) ?? 0;
    const rawPrice = update.average ?? update.price;
    const price =
      rawPrice !== undefined ? this.formatPriceForDisplay(market, Number(rawPrice)) : undefined;
    const at = price !== undefined ? ` @${price}` : '';

    // Structured rather than prose: the row is columns the eye can run down,
    // and the market isn't repeated because it is already in the header.
    if (filled > previouslyFilled) {
      state.filledSoFar.set(id, filled);

      const complete =
        status === 'closed' ||
        (update.remaining !== undefined && Number(update.remaining) === 0);

      NotificationManager.notify('', NType.SUCCESS, 'FILL', eventTime, {
        side: side.toUpperCase(),
        quantity: this.formatQuantity(filled),
        price: price,
        status: complete ? 'FILLED' : 'PARTIAL',
      });
    }

    if (status === 'canceled' && filled === 0) {
      NotificationManager.notify('', NType.INFO, 'ORDER', eventTime, {
        side: side.toUpperCase(),
        quantity: this.formatQuantity(Number(update.amount ?? 0)),
        price: price,
        status: 'CANCELLED',
      });
    }

    if (status === 'rejected') {
      NotificationManager.notify(
        'nothing is resting',
        NType.ERROR,
        'ERROR',
        eventTime,
        {
          side: side.toUpperCase(),
          quantity: this.formatQuantity(Number(update.amount ?? 0)),
          price: price,
          status: 'REJECTED',
        }
      );
    }
  }

  /** The instrument's base asset, for labelling quantities. */
  getBaseAsset(market: string): string | undefined {
    const info = this.availableMarkets?.[market];
    const base = info?.base ?? market.split('/')[0];
    return base ? String(base) : undefined;
  }

  /**
   * How many decimals the instrument's prices are quoted to.
   *
   * ccxt reports precision either as a tick size (0.01, 0.5) or as a count of
   * decimal places, depending on the exchange, so both are handled.
   */
  private priceDecimals(market: string): number | undefined {
    const tick = this.availableMarkets?.[market]?.precision?.price;
    if (tick === undefined || tick === null) return undefined;

    const value = Number(tick);
    if (!Number.isFinite(value) || value <= 0) return undefined;

    // A tick-size mode exchange reports the smallest price step.
    if ((this.exchange as any)?.precisionMode === 4 || value < 1) {
      const decimals = String(value).split('.')[1]?.length ?? 0;
      return decimals;
    }

    return Math.round(value);
  }

  /**
   * A price at the instrument's own precision, for display.
   *
   * priceToPrecision rounds to the tick but does not pad, so a column would
   * otherwise mix 95.1 with 94.59. Padding to the instrument's decimals keeps
   * quoted prices reading as one set of numbers. Display only -- no stored or
   * calculated value is changed.
   */
  formatPriceForDisplay(market: string, price: number): string {
    if (!Number.isFinite(price)) return String(price);

    let rounded = price;
    try {
      rounded = Number(this.exchange!.priceToPrecision(market, price));
    } catch {
      rounded = Math.round(price * 10000) / 10000;
    }

    const decimals = this.priceDecimals(market);
    return decimals === undefined ? String(rounded) : rounded.toFixed(decimals);
  }

  /**
   * When an order event happened, rather than when it reached us. The feed
   * replays recent orders on connect, so without this a backlog of old fills all
   * appear stamped with the moment of login.
   */
  private orderEventTime(update: Order): number | undefined {
    const candidates = [
      (update as any).lastUpdateTimestamp,
      update.timestamp,
      // Phemex reports nanoseconds in the raw payload.
      (update as any).info?.transactTimeNs
        ? Number((update as any).info.transactTimeNs) / 1e6
        : undefined,
      (update as any).info?.actionTimeNs
        ? Number((update as any).info.actionTimeNs) / 1e6
        : undefined,
    ];

    for (const value of candidates) {
      const numeric = Number(value);
      // Guard against a zero or nonsense timestamp being taken as 1970.
      if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) return numeric;
    }

    return undefined;
  }

  /** Quantities without trailing precision the value doesn't carry. */
  private formatQuantity(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return 'ALL';
    return String(Number(value.toFixed(8)));
  }

  private capitalise(value: string): string {
    return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
  }

  // Begin following a market: prices and order events. Called when the market
  // changes, so fills and rejections are reported for whatever is being traded
  // without any command having to ask for them.
  public followMarket(market: string, params?: Record<string, any>): void {
    this.lastFollowedMarket = market;
    this.stopTickerStream();
    this.stopOrderStream();
    this.startTickerStream(market);
    this.startOrderStream(market, params);
  }

  private stopOrderStream(market?: string): void {
    for (const [symbol, state] of this.orderStreams) {
      if (market === undefined || symbol === market) {
        state.running = false;
        this.orderStreams.delete(symbol);
      }
    }
  }

  // Open orders for a market.
  //
  // `mustBeComplete` is for callers whose correctness depends on seeing every
  // order — cancelling them all, most importantly. Those always fetch: a cache
  // that has quietly missed an order would report success while leaving one
  // live, and being told you are flat when you are not is the worst outcome this
  // code can produce. Sizing and side-determination paths, which run often and
  // tolerate being a moment behind, take the streamed view.
  private async getLiveOpenOrders(
    market: string,
    params?: Record<string, any>,
    mustBeComplete = false
  ): Promise<Order[]> {
    const state = this.orderStreams.get(market);
    const fresh =
      state?.healthy === true &&
      Date.now() - state.syncedAt <= ExchangeClient.ORDER_CACHE_MAX_AGE_MS;

    if (!mustBeComplete && fresh) {
      return Array.from(state!.orders.values());
    }

    const orders = await this.exchange!.fetchOpenOrders(
      market,
      undefined,
      undefined,
      params
    );

    // Seed the feed from this snapshot so the next call can be served from it.
    this.startOrderStream(market, params, orders);

    return orders;
  }

  private stopTickerStream(market?: string): void {
    for (const [symbol, state] of this.tickerStreams) {
      if (market === undefined || symbol === market) {
        state.running = false;
        this.tickerStreams.delete(symbol);
      }
    }
  }

  // Last traded price, or undefined if one can't be established. Callers decide
  // whether that is fatal — a protective stop should still be placeable when the
  // ticker is briefly unavailable.
  private async getReferencePrice(market: string): Promise<number | undefined> {
    const streamed = this.tickerStreams.get(market);

    if (
      streamed?.price !== undefined &&
      Date.now() - streamed.at <= ExchangeClient.STREAMED_PRICE_MAX_AGE_MS
    ) {
      return streamed.price;
    }

    // Nothing live, or what's live is too old to act on.
    this.startTickerStream(market);

    try {
      const ticker = await this.exchange!.fetchTicker(market);
      const last = ticker.last ?? ticker.close ?? undefined;

      return typeof last === 'number' && Number.isFinite(last) && last > 0
        ? last
        : undefined;
    } catch (error) {
      console.warn(
        `[ExchangeClient] Could not fetch a reference price for ${market}: ${
          (error as Error).message
        }`
      );
      return undefined;
    }
  }

  // Notional value of an order, in the market's quote currency.
  //
  // On inverse contracts (Phemex's BTC/USD:BTC and friends) each contract is
  // already denominated in the quote currency, so the size IS the notional and no
  // price is needed. On linear contracts and spot, size is in the base currency,
  // so it has to be multiplied by a price.
  private async calculateNotional(
    market: string,
    quantity: number,
    price?: number
  ): Promise<{ notional: number; currency: string }> {
    const marketInfo = this.availableMarkets?.[market];
    if (!marketInfo) {
      throw new Error(
        `Cannot value an order for ${market}: the market is not loaded. No order was placed.`
      );
    }

    const contractSize = (marketInfo as any).contractSize ?? 1;
    const currency = String(marketInfo.quote ?? '');

    if ((marketInfo as any).inverse) {
      return { notional: quantity * contractSize, currency };
    }

    let referencePrice = price;

    // Fall back to the last traded price only when the caller has no price of its
    // own — a market order, for instance.
    if (
      referencePrice === undefined ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      referencePrice = await this.getReferencePrice(market);
    }

    if (
      referencePrice === undefined ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      // Refuse rather than wave the order through unchecked.
      throw new Error(
        `Cannot check the fatfinger limit for ${market}: no price available. No order was placed.`
      );
    }

    return { notional: quantity * contractSize * referencePrice, currency };
  }

  // Every path that sends a size to the exchange passes through here, so this is
  // where sizes are checked. `enforceFatFinger` is false for sizes derived from
  // the position itself (closing out, or a stop sized from an existing position):
  // those can't be a typo, and refusing them would strand a position or leave it
  // without a stop. `price` is the order's own price when it has one, so the
  // notional check doesn't need to fetch a ticker.
  async getQuantityPrecision(
    market: string,
    quantity: number,
    options: { enforceFatFinger?: boolean; price?: number } = {}
  ): Promise<number> {
    const { enforceFatFinger = true, price } = options;
    const marketInfo = this.availableMarkets![market];
    if (!marketInfo) {
      throw new Error(`Market ${market} not found.`);
    }

    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
      throw new Error(
        `Invalid order size '${quantity}' for ${market}. Size must be a number.`
      );
    }

    if (quantity <= 0) {
      throw new Error(
        `Invalid order size ${quantity} for ${market}. Size must be greater than 0.`
      );
    }

    const minTradeAmount = marketInfo.precision?.amount ?? 0;

    if (quantity < minTradeAmount) {
      throw new Error(`Minimum order size for ${market} is ${minTradeAmount}`);
    }

    if (enforceFatFinger && this.fatFingerLimit !== undefined) {
      const { notional, currency } = await this.calculateNotional(
        market,
        quantity,
        price
      );

      if (notional > this.fatFingerLimit) {
        throw new Error(
          `Fatfinger guard: this order is worth ${notional.toFixed(2)} ${currency}, ` +
            `over your limit of ${this.fatFingerLimit} ${currency} per order. No order was placed. ` +
            `Raise the limit with 'fatfinger <amount>' if this was intended.`
        );
      }
    }

    return quantity;
  }

  async executeOrder(
    method: string,
    market: string,
    ...args: any[]
  ): Promise<any> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before placing an order.`
      );
      return;
    }

    // Extract potential postOnly flag and params from the end of args
    let finalParams: Record<string, any> = {};
    let postOnly = false;
    let originalArgs = [...args]; // Copy original args

    // Check if the last arg is a params object
    if (originalArgs.length > 0 && typeof originalArgs[originalArgs.length - 1] === 'object' && originalArgs[originalArgs.length - 1] !== null) {
        finalParams = { ...originalArgs.pop() }; // Pop and copy params object
    }

    // Check if the (new) last arg is the postOnly boolean
    if (originalArgs.length > 0 && typeof originalArgs[originalArgs.length - 1] === 'boolean') {
        postOnly = originalArgs.pop(); // Pop boolean
    }

    if (postOnly) {
        finalParams['postOnly'] = true;
    }

    try {
      // Special handling for Hyperliquid market orders (shouldn't apply to limit chase)
      if (this.exchange.id === 'hyperliquid' && method.includes('Market')) {
        const ticker = await this.exchange.fetchTicker(market);
        const currentPrice = ticker.last || 0;
        finalParams.price = currentPrice;
        finalParams.slippage = 0.05;
      }

      // Call the underlying exchange method with market, remaining original args, and the final combined params
      const order = await (this.exchange as any)[method](market, ...originalArgs, finalParams);

      // What comes back here is the exchange accepting the request, not the
      // outcome. Whether it fills, and for how much, arrives on the order feed —
      // so this reports acceptance only, and announceOrderUpdate reports the
      // rest. Reading a 200 as a fill is how a rejected order passes for a live
      // one.
      //
      // The shape of the response varies by exchange, so nothing here may throw:
      // an error formatting a confirmation would land in the catch below and
      // report a placed order as failed.
      try {
        const side = order?.side ? `${this.capitalise(String(order.side))} ` : '';
        const amount = order?.amount !== undefined ? this.trimAmount(parseFloat(order.amount)) : '';
        const trigger = order?.triggerPrice ?? order?.stopPrice;
        const at =
          trigger !== undefined
            ? ` triggering at ${trigger}`
            : order?.price
            ? ` @${order.price}`
            : '';

        NotificationManager.notify('', NType.INFO, 'ORDER', undefined, {
          side: order?.side ? String(order.side).toUpperCase() : undefined,
          quantity: this.formatQuantity(Number(order?.amount)),
          price: trigger !== undefined ? String(trigger) : order?.price ? String(order.price) : undefined,
          status: trigger !== undefined ? 'STOP' : 'ACCEPTED',
        });
      } catch {
        console.log(`Order accepted${order?.id ? ` (id ${order.id})` : ''}`);
      }

      return order;
    } catch (error) {
      // Never swallow this. Returning undefined made a rejected order
      // indistinguishable from a placed one, so callers carried on as though
      // there were an order resting when there was not — and the chase read the
      // same undefined as 'filled immediately'.
      //
      // Callers decide what a failure means for them; none of them get to miss
      // that it happened.
      throw error;
    }
  }

  async getMarketPrecision(market: string): Promise<number> {
    if (this.exchange === null) {
        console.error(
            `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching market precision.`
        );
        return 0;
    }
    // Ensure markets are loaded
    if (!this.availableMarkets) {
      await this.loadMarkets();
    }
    // Use the market name to access precision details
    const marketInfo = this.availableMarkets![market];
    if (!marketInfo) {
      throw new Error(`Market ${market} not found.`);
    }
    return marketInfo.precision.price ?? 0;
  }

  async getPositionStructure(symbol: string): Promise<Position | undefined> {
    let positionStructure: Position | undefined = {
      symbol: '',
      contracts: 0,
      notional: 0,
      side: '',
    };

    if (!this.exchange) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching position.`
      );
      return positionStructure;
    }

    try {
      // Special handling for Hyperliquid
      if (this.exchange.id === 'hyperliquid') {
        // Get the public wallet address from the exchange configuration for queries
        const walletAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;

        if (!walletAddress) {
          console.error(`[ExchangeClient] Wallet address not found in exchange configuration`);
          return positionStructure;
        }

        // Generate different symbol formats to try - for Hyperliquid the format is different
        const baseSymbol = symbol.split('/')[0]; // Get the base, e.g. "SOL" from "SOL/USDC:USDC"
        const symbolVariations = [
          baseSymbol,           // Just the base: SOL
          symbol,               // Original format: SOL/USDC:USDC
          `${baseSymbol}-USD`,  // SOL-USD
          `${baseSymbol}/USD`,  // SOL/USD
          `${baseSymbol}USD`,   // SOLUSD
        ];

        // Helper function to check if position has real data
        const isValidPosition = (pos: any): boolean => {
          if (!pos) return false;

          // Check if it's an empty object
          if (Object.keys(pos).length === 0) return false;

          // Check if it has essential position properties
          if (!pos.symbol) return false;

          // If we have contracts, side, or entryPrice, it's likely valid
          if (pos.contracts !== undefined && pos.contracts !== 0) return true;
          if (pos.side && pos.side !== '') return true;
          if (pos.entryPrice) return true;

          return false;
        };

        try {
          // Try to fetch account balance for this user which might include position info
          try {
            const balanceParams = { 'user': walletAddress };
            const balance = await this.exchange.fetchBalance(balanceParams);

            // Check if there's position info in the balance
            if (balance && balance.info && balance.info.positions) {
              const positions = balance.info.positions;
              for (const pos of positions) {
                const posCoin = String(pos.coin || '').toLowerCase();
                const baseSymbolLower = baseSymbol.toLowerCase();

                if (posCoin === baseSymbolLower) {
                  // Convert to our Position structure
                  positionStructure = {
                    symbol: baseSymbol,
                    contracts: Number(pos.szi || 0),
                    notional: Number(pos.notional || 0),
                    side: Number(pos.szi || 0) > 0 ? 'long' : (Number(pos.szi || 0) < 0 ? 'short' : ''),
                    entryPrice: Number(pos.entryPx || 0)
                  };

                  return positionStructure;
                }
              }
            }
          } catch (error) {
            console.error(`[ExchangeClient] Error fetching balance:`, (error as Error).message);
          }

          // First try the direct fetchPosition method with each symbol variation
          for (const symVar of symbolVariations) {
            try {
              const params = { 'user': walletAddress };
              const position = await this.exchange.fetchPosition(symVar, params);

              if (position && isValidPosition(position)) {
                return position;
              }
            } catch (error) {
              // Suppress individual symbol errors
            }
          }

          // If direct fetching fails, try fetchPositions which gets all positions
          try {
            const params = { 'user': walletAddress };
            const allPositions = await this.exchange.fetchPositions(undefined, params);

            if (allPositions && allPositions.length > 0) {
              // Try to match by symbol, preferring an exact match with the input symbol or base symbol
              const targetSymbols = [
                symbol, // Original symbol first (e.g., SOL/USDC:USDC)
                baseSymbol, // Base symbol (e.g., SOL)
                // Add other common variations if necessary, but be specific
              ];

              for (const tSymbol of targetSymbols) {
                const foundPosition = allPositions.find(p => p.symbol && p.symbol.toLowerCase() === tSymbol.toLowerCase() && isValidPosition(p));
                if (foundPosition) {
                  return foundPosition; // Return the first exact match found
                }
              }

              // Stricter fallback: only if a position explicitly contains the baseSymbol AND has contracts
              // This avoids returning an unrelated active position if the target market has no position.
              const fallbackPosition = allPositions.find(p =>
                p.symbol && p.symbol.toLowerCase().includes(baseSymbol.toLowerCase()) &&
                isValidPosition(p) &&
                (p.contracts !== undefined && p.contracts !== 0) // Ensure it's an actual position
              );
              if (fallbackPosition) {
                // Before returning a fallback, log a warning if its symbol isn't an exact match
                if (!targetSymbols.some(ts => ts.toLowerCase() === fallbackPosition.symbol.toLowerCase())) {
                    console.warn(`[ExchangeClient/getPositionStructure] Hyperliquid: No exact symbol match for ${symbol}. ` +
                                 `Returning fallback position for ${fallbackPosition.symbol} as it includes base ${baseSymbol} and has contracts.`);
                }
                return fallbackPosition;
              }
            }
          } catch (error) {
            console.error(`[ExchangeClient] Error fetching positions:`, (error as Error).message);
          }
        } catch (error) {
          console.error(`[ExchangeClient] Error with wallet address ${walletAddress}:`, (error as Error).message);
        }

        console.log(`[ExchangeClient] No valid positions found for ${symbol}`);
        return positionStructure;
      }

      // Standard handling for other exchanges
      positionStructure = await this.exchange.fetchPosition(symbol);
      return positionStructure;
    } catch (error) {
      if (error instanceof ccxt.NotSupported) {
        try {
          const positions = await this.exchange.fetchPositions([symbol]);
          positionStructure = positions.find(
            (pos: Position) => pos.symbol === symbol
          );
          if (positionStructure) {
            return positionStructure;
          }
        } catch (error: unknown) {
          console.error('Error fetching positions:', (error as Error).message);
        }
      } else {
        console.error('Error fetching position:', (error as Error).message);
      }
    }

    return positionStructure;
  }

  async getEntryPrice(symbol: string): Promise<number | undefined> {
    const position = await this.getPositionStructure(symbol);
    if (position && position.contracts !== undefined) {
      return position.entryPrice ?? 0;
    }
  }

  async getPositionSize(symbol: string): Promise<number> {
    let positionSize = 0;

    const position = await this.getPositionStructure(symbol);
    if (position && position.contracts !== undefined) {
      positionSize = position.contracts;
    }
    if (positionSize === 0) {
      return 0;
    } else if (positionSize > 0) {
      return positionSize;
    } else {
      return Math.abs(positionSize);
    }
  }

  async cancelOrdersByDirection(
    market: string,
    direction?: string,
    rangeStart?: number,
    rangeEnd?: number
  ): Promise<void> {
    let hyperliquidParams: { user?: string } = {};
    const isHyperliquid = this.exchange?.id === 'hyperliquid';

    if (isHyperliquid) {
      const publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
      if (!publicAddress) {
        throw new Error('[ExchangeClient/cancelOrdersByDirection] Hyperliquid requires publicAddress.');
      }
      hyperliquidParams = { 'user': publicAddress };
    }

    // Fetch the orders from the market symbol, including user param for Hyperliquid
    const openOrders = await this.exchange!.fetchOpenOrders(market, undefined, undefined, isHyperliquid ? hyperliquidParams : undefined);

    // Filter to get only relevant limit orders
    const limitOrdersToConsider = openOrders.filter((order) => {
      if (isHyperliquid) {
        const isBasicLimit = order.type === 'limit' ||
                             (order.info && (order.info.orderType === 'Limit' || order.info.orderType === 'LimitOrder'));
        const isNotTrigger = order.info?.isTrigger !== true &&
                             order.info?.orderType !== 'Stop Limit' &&
                             order.info?.orderType !== 'Trigger' &&
                             order.info?.orderType !== 'StopMarket';
        return isBasicLimit && isNotTrigger;
      } else {
        // Original filter for non-Hyperliquid exchanges: effectively, non-stop orders
        return order.type?.toLowerCase() !== 'stop';
      }
    });

    // Sort orders by price depending on the direction
    const sortedOrders =
      direction === 'bottom'
        ? limitOrdersToConsider.sort((a, b) => a.price - b.price)
        : limitOrdersToConsider.sort((a, b) => b.price - a.price);

    // Determine the range of orders to be canceled
    let start = rangeStart ? rangeStart - 1 : 0; // rangeStart is 1-indexed from user
    let end = rangeEnd ? rangeEnd : sortedOrders.length;

    // Slice the orders array based on the determined range
    const ordersToCancel = sortedOrders.slice(start, end);

    // Cancel the orders within the range
    if (ordersToCancel.length > 0) {
      const cancelPromises = ordersToCancel.map((order) =>
        this.exchange!.cancelOrder(order.id, market, isHyperliquid ? hyperliquidParams : undefined)
      );
      await Promise.all(cancelPromises);
      console.log(`${ordersToCancel.length} limit orders have been canceled.`);
    } else {
      console.log('No matching limit orders found to cancel.');
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    this.cancelAllStopOrders(symbol);
    this.cancelAllLimitOrders(symbol);
  }

  async cancelAllLimitOrders(symbol: string): Promise<void> {
    try {
      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // Fetch open orders with wallet address for Hyperliquid
      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined,
        walletAddress ? { 'user': walletAddress } : undefined);

      // Filter orders to obtain only limit orders
      const limitOrders = openOrders.filter((order) => {
        // For Hyperliquid, check both standard limit orders and Hyperliquid's specific limit order types
        if (this.exchange!.id === 'hyperliquid') {
          const isBasicLimit = order.type === 'limit' ||
                               (order.info && (order.info.orderType === 'Limit' || order.info.orderType === 'LimitOrder'));
          // Ensure it's not a trigger order (like stop-limit)
          const isNotTrigger = order.info?.isTrigger !== true &&
                               order.info?.orderType !== 'Stop Limit' &&
                               order.info?.orderType !== 'Trigger' &&
                               order.info?.orderType !== 'StopMarket';
          return isBasicLimit && isNotTrigger;
        }
        return order.type === 'limit';
      });

      // If there are no limit orders, simply return without doing anything further
      if (limitOrders.length === 0) {
        console.log('No open limit orders to cancel.');
        return;
      }

      // If there are limit orders, proceed with canceling them
      const cancelPromises = limitOrders.map((order) =>
        this.exchange!.cancelOrder(order.id, symbol)
      );
      // Wait for all cancellations to complete
      await Promise.all(cancelPromises);
    } catch (error) {
      const failure = describeExchangeError(error);
      NotificationManager.diagnostic(`[cancelAllLimitOrders] ${failure.raw}`);
      NotificationManager.notify(`Limit orders NOT cancelled: ${failure.summary}`, NType.ERROR, 'ERROR');
    }
  }

  async cancelAllStopOrders(symbol: string): Promise<void> {
    try {
      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // For Hyperliquid, we need to use the public wallet address to fetch orders
      const params = walletAddress ? { 'user': walletAddress } : undefined;

      // Fetch open orders with wallet address for Hyperliquid
      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined, params);

      let stopOrders = [];

      // For Hyperliquid, check for both standard stop orders and Hyperliquid's specific stop order types
      if (this.exchange!.id === 'hyperliquid') {
        stopOrders = openOrders.filter(
          (order) => {
            return order.type === 'stop' ||
                   order.info?.orderType === 'Stop Limit' ||
                   order.info?.orderType === 'Trigger' ||
                   order.info?.orderType === 'StopMarket' ||
                   (order.info?.isTrigger === true);
          }
        );
      } else {
        // For other exchanges, use standard stop order detection
        stopOrders = openOrders.filter(
          (order) =>
            order.type === 'stop' ||
            order.info?.order_type === 'stop_market'
        );
      }

      if (stopOrders.length > 0) {
        const cancelPromises = stopOrders.map((order) =>
          this.exchange!.cancelOrder(order.id, symbol, params)
        );
        await Promise.all(cancelPromises);
      }
    } catch (error) {
      const failure = describeExchangeError(error);
      NotificationManager.diagnostic(`[cancelAllStopOrders] ${failure.raw}`);
      NotificationManager.notify(`Stop orders NOT cancelled: ${failure.summary}`, NType.ERROR, 'ERROR');
    }
  }

  async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cancelChaseOrder(orderId: string, market: string, params?: Record<string, any>): Promise<void> {
    // Always set the active flag to false when cancellation is attempted
    this.chaseLimitOrderActive = false;
    // Prefer the id the chase is actually working; the caller's copy is from
    // when the chase started and may name an order that has since been replaced.
    const targetId = this.currentChaseOrderId ?? orderId;
    this.currentChaseOrderId = undefined;
    try {
      await this.exchange!.cancelOrder(targetId, market, params);
    } catch (error: any) {
        // Check if it's a benign OrderNotFound error
        const errorMessage = String(error.message || '');
        const isOrderNotFound = errorMessage.includes('OrderNotFound') ||
                                errorMessage.includes('Order was never placed, already canceled, or filled');

        if (isOrderNotFound) {
            // Log simplified warning or omit if preferred
            // console.warn(`[cancelChaseOrder] Attempted to cancel chase order ${orderId}, but it was likely already finalized.`);
        } else {
            // Log other errors as actual problems
            NotificationManager.diagnostic(`[cancelChaseOrder] ${(error as Error).message}`);
            // Optionally re-throw if needed downstream
            // throw error;
        }
    }
  }

  getChaseLimitOrderStatus(): boolean {
    return this.chaseLimitOrderActive;
  }

  // Chase driven by the exchange's WebSocket feeds instead of polling.
  //
  // The book pushes prices as they change, and the order stream reports fills
  // and cancels as they happen. That removes two REST calls per cycle, so the
  // only requests left are the ones that actually move an order — which is what
  // the exchange's order-action rate limit is for. It also means a fill is known
  // from an event rather than looked up afterwards in an API that lags.
  //
  // Phemex has no order placement over WebSocket, so moves stay on REST.
  private async runStreamingChase(opts: {
    market: string;
    side: string;
    amount: number;
    orderId: string;
    orderPrice: number;
    params?: Record<string, any>;
  }): Promise<void> {
    const { market, side, amount, params } = opts;
    const tickSize = this.getMarketPriceTickSize(market);

    let orderId = opts.orderId;
    let orderPrice = opts.orderPrice;
    let remaining = amount;
    let finished = false;
    // A move is cancel/replace on some exchanges, which makes the old order
    // report as cancelled. Without this the order stream would read our own
    // replacement as the trader's order being cancelled and end the chase.
    let moveInFlight = false;
    // The in-flight flag alone isn't enough: the cancellation event for an order
    // we replaced can arrive after the move has finished. Orders we retired
    // ourselves are remembered so a late event about one is never mistaken for
    // the trader cancelling.
    const retiredOrderIds = new Set<string>();
    // A chase driven by the book retries on every tick, so without a budget a
    // move that always fails retries forever -- and a chase that will not stop
    // cannot be stopped from anywhere else either, since the order id it is
    // working lives only in this process.
    const maxConsecutiveErrors = 5;
    let consecutiveErrors = 0;

    this.currentChaseOrderId = orderId;

    const finish = (message: string) => {
      if (finished) return;
      finished = true;
      this.chaseLimitOrderActive = false;
      this.currentChaseOrderId = undefined;
      // An empty message ends the chase without a row: the event that ended it
      // has already been reported in its own right.
      if (message) this.logAndReplace(message);
    };

    const moveTo = async (targetPrice: number) => {
      if (moveInFlight || finished || !this.chaseLimitOrderActive) return;
      moveInFlight = true;

      try {
        try {
          const edited = await this.editOrder(
            orderId,
            market,
            'limit',
            targetPrice,
            remaining,
            params,
            // The stream keeps us current on the order, so hand editOrder what
            // it needs rather than let it fetch order history — that lookup is
            // the REST call streaming exists to avoid.
            { id: orderId, side, amount: remaining } as unknown as Order
          );

          if (edited?.id && edited.id !== orderId) {
            orderId = edited.id;
          }
        } catch (editError) {
          // Amend refused: cancel and replace instead.
          retiredOrderIds.add(orderId);
          await this.exchange!.cancelOrder(orderId, market, params);

          const replacement = await (side === 'buy'
            ? this.createLimitBuyOrder(market, targetPrice, remaining, params, true)
            : this.createLimitSellOrder(market, targetPrice, remaining, params, true));

          if (!replacement?.id) {
            finish(
              `Chase stopped: the order was cancelled to move it to ${targetPrice}, ` +
                `but the replacement could not be placed. Nothing is resting — you are not in this trade.`
            );
            return;
          }

          orderId = replacement.id;
          // An exchange that reuses the id must not leave the live order marked
          // as retired.
          retiredOrderIds.delete(orderId);
        }

        orderPrice = targetPrice;
        this.currentChaseOrderId = orderId;
        consecutiveErrors = 0;
      } catch (error) {
        // The order being chased is gone. Rather than retry an id that will
        // never resolve, find out what actually became of it and say so --
        // leaving a chase quiet about an unfilled remainder is how a position
        // ends up smaller than intended without anyone noticing.
        if (isMissingOrderError(error)) {
          await this.reportChaseOutcome(market, orderId, side, amount, finish);
          return;
        }

        const failure = describeExchangeError(error);
        // The raw payload is kept as a diagnostic rather than printed across
        // the activity row.
        NotificationManager.diagnostic(`[chase] ${failure.raw}`);

        consecutiveErrors++;
        this.logAndReplace(
          `Chase: could not move the order (${failure.summary}) ` +
            `[${consecutiveErrors}/${maxConsecutiveErrors}]`
        );

        if (consecutiveErrors >= maxConsecutiveErrors) {
          finish(
            `Chase stopped after ${maxConsecutiveErrors} failed moves. ` +
              `Any resting order is still live — check the exchange.`
          );
          return;
        }
      } finally {
        moveInFlight = false;
      }
    };

    const followBook = async () => {
      while (!finished && this.chaseLimitOrderActive) {
        const book = await this.exchange!.watchOrderBook(market);
        if (finished || !this.chaseLimitOrderActive) return;

        const levels = side === 'buy' ? book.bids : book.asks;
        if (!levels || levels.length === 0) continue;

        const best = Number(levels[0]?.[0]);
        if (!Number.isFinite(best) || best <= 0) continue;

        const improves = side === 'buy' ? best > orderPrice : best < orderPrice;

        if (improves && Math.abs(best - orderPrice) >= tickSize) {
          await moveTo(best);
        }
      }
    };

    const followOrder = async () => {
      while (!finished && this.chaseLimitOrderActive) {
        const orders = await this.exchange!.watchOrders(market);
        if (finished || !this.chaseLimitOrderActive) return;

        for (const update of orders) {
          // Anything we retired ourselves is our own doing, however late the
          // event arrives.
          if (update.id !== undefined && retiredOrderIds.has(update.id)) continue;

          // Only the order being worked; events for orders we have already
          // replaced are stale by definition.
          if (update.id !== orderId) continue;

          if (update.remaining !== undefined) {
            remaining = update.remaining;
          }

          const status = String(update.status ?? '');

          if (status === 'closed') {
            const filled = Number(update.filled ?? amount);
            const fillPrice = update.average ?? update.price;

            NotificationManager.notify('', NType.SUCCESS, 'FILL', undefined, {
              side: side.toUpperCase(),
              quantity: this.formatQuantity(filled),
              // No price is invented when the fill data hasn't arrived.
              price:
                fillPrice === undefined
                  ? undefined
                  : this.formatPriceForDisplay(market, Number(fillPrice)),
              status: 'FILLED',
            });

            finish('');
            return;
          }

          if (status === 'canceled' || status === 'rejected') {
            // Our own cancel/replace produces this too; only the trader's
            // cancellation should end the chase.
            if (!moveInFlight) {
              finish(`Chase ${side} order ${status} ${market}`);
              return;
            }
          }
        }
      }
    };

    // Whichever finishes first ends the chase; the other loop sees `finished`
    // on its next event and exits.
    await Promise.race([followBook(), followOrder()]);
  }

  async chaseLimitOrder(
    market: string,
    side: string,
    amount: number,
    decay?: string
  ): Promise<string | undefined | void> {
    if (!this.exchange) { throw new Error('Exchange not initialized'); }
    this.chaseLimitOrderActive = true;

    // --- Hyperliquid Params ---
    let params: Record<string, any> | undefined = undefined;
    if (this.getExchangeId() === 'hyperliquid') {
        const publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
        if (!publicAddress) {
          throw new Error('[ExchangeClient/chaseLimitOrder] Hyperliquid requires publicAddress.');
        }
        params = { 'user': publicAddress };
        // Use Add Liquidity Only TIF for initial placement instead of postOnly flag
        params.timeInForce = 'Alo';
    }
    // --- End Hyperliquid Params ---

    const orderBook = await this.exchange!.fetchL2OrderBook(market);
    const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0][0] : 0;
    const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0][0] : Infinity;

    // Use best bid/ask directly, rely on TIF: Alo in params
    const initialPrice = side === 'buy' ? bestBid : bestAsk;
    if (!isFinite(initialPrice) || initialPrice <= 0) {
        // Basic validation, might need refinement
        throw new Error(`Invalid initial best price calculated: ${initialPrice}`);
    }

    // Pass params (containing TIF: Alo for Hyperliquid) AND postOnly: true flag
    // The active flag is already set, so a failure here has to clear it or the
    // next chase is refused with 'Chase order already active'.
    let order;
    try {
      order = await (side === 'buy'
        ? await this.createLimitBuyOrder(market, initialPrice, amount, params, true)
        : await this.createLimitSellOrder(market, initialPrice, amount, params, true));
    } catch (error) {
      this.chaseLimitOrderActive = false;
      this.currentChaseOrderId = undefined;
      throw error;
    }

    if (!order) {
      // executeOrder throws on rejection, so nothing here means the client had
      // no exchange to talk to rather than an order that vanished.
      this.chaseLimitOrderActive = false;
      this.currentChaseOrderId = undefined;
      NotificationManager.notify(
        'Chase not started: no order was placed.',
        NType.ERROR
      );
      return;
    }

    // Use let instead of const to allow potential reassignment after edits
    let orderId = order.id;
    let remainingAmount = amount;

    // A cycle costs several API calls (open orders, order book, and an edit),
    // and ccxt's rate limiter spaces every call out. Polling faster than the
    // limiter allows doesn't chase harder, it just queues work and falls behind,
    // so the floor is derived from the exchange's own rate limit.
    const callsPerCycle = 3;
    const rateLimitFloor = Math.ceil(
      (this.exchange.rateLimit ?? 100) * callsPerCycle
    );
    const chaseInterval = Math.max(
      this.getExchangeId() === 'hyperliquid' ? 1500 : 100,
      rateLimitFloor
    );

    // Transient failures are normal against a live exchange. Give up only after
    // several in a row, and say so, rather than dying on the first one.
    const maxConsecutiveErrors = 5;
    let consecutiveErrors = 0;

    // Smallest price move the market can express; anything under it isn't a
    // move worth an API call.
    const tickSize = this.getMarketPriceTickSize(market);

    const finishChase = (message: string) => {
      this.chaseLimitOrderActive = false;
      this.currentChaseOrderId = undefined;
      this.logAndReplace(message);
    };

    // Single entry point for running a cycle. Nothing else calls
    // executeChaseOrder directly, so a rejected promise can never escape and end
    // the chase silently with the active flag still set — which is what left a
    // stalled chase unrestartable.
    const runCycle = () => {
      executeChaseOrder().catch((error) => {
        finishChase(
          `Chase stopped unexpectedly: ${(error as Error).message}. ` +
            `Any resting order is still live.`
        );
      });
    };

    const scheduleNextCycle = () => {
      setTimeout(runCycle, chaseInterval);
    };

    const executeChaseOrder = async () => {
      // 'cancel chase' clears the flag; stop rather than resurrecting the loop.
      if (!this.chaseLimitOrderActive) {
        this.logAndReplace(`Chase ${side} order cancelled for ${amount} ${market}`);
        return;
      }

      try {
        // Pass params to fetchOpenOrders
        const openOrders = await this.exchange!.fetchOpenOrders(market, undefined, undefined, params);
        const order = openOrders.find((o) => o.id === orderId);

        if (!order) {
          // Gone from the open orders isn't the same as filled — it may have
          // been cancelled or rejected.
          //
          // Phemex resolves a finished order through its historical data API,
          // which lags the live book by a second or so, and answers in the
          // meantime with an empty record. An empty record is 'not yet known',
          // never 'did not fill', so only a record that actually says something
          // is allowed to decide the outcome.
          let outcome: string | undefined;

          for (let attempt = 0; attempt < 3 && outcome === undefined; attempt++) {
            if (attempt > 0) {
              await this.sleep(750);
            }

            try {
              const finalOrder = await this.exchange!.fetchOrder(orderId, market, params);
              const filled = Number(finalOrder?.filled ?? 0);
              const status = String(finalOrder?.status ?? '');

              if (status === 'closed' || filled >= amount) {
                outcome = `filled for ${filled || amount}`;
              } else if (status === 'canceled' || status === 'rejected') {
                outcome =
                  filled > 0
                    ? `${status} after filling ${filled} of ${amount}`
                    : `${status} without filling`;
              } else if (filled > 0) {
                outcome = `ended with ${filled} of ${amount} filled`;
              }
              // Anything else is an unpopulated record: try again.
            } catch {
              // Not visible to the history API yet either; try again.
            }
          }

          finishChase(
            outcome !== undefined
              ? `Chase ${side} order ${outcome} ${market}`
              : `Chase ${side} order is no longer open for ${market}. ` +
                  `The exchange hasn't reported the outcome yet — check your position.`
          );
          return;
        }

        const updatedOrderBook = await this.exchange!.fetchL2OrderBook(market);
        const levels =
          side === 'buy' ? updatedOrderBook.bids : updatedOrderBook.asks;

        // An empty side of the book is momentary; wait for the next cycle rather
        // than reading past the end of the array and killing the chase.
        if (!levels || levels.length === 0) {
          scheduleNextCycle();
          return;
        }

        const updatedBestPrice = levels[0][0];

        // Only chase a move worth chasing. Sub-tick differences can't be
        // expressed in an order anyway, and amending on every flicker is what
        // runs an account into the exchange's order-action rate limit.
        const improves =
          side === 'buy'
            ? updatedBestPrice > order.price
            : updatedBestPrice < order.price;
        const movedAtLeastOneTick =
          Math.abs(updatedBestPrice - order.price) >= tickSize;

        if (improves && movedAtLeastOneTick) {
          try {
            const editResult = await this.editOrder(
              orderId,
              market,
              'limit',
              updatedBestPrice,
              order.remaining,
              params, // Pass Hyperliquid params here
              order // already in hand; saves a fetchOrders call per edit
            );

            // Check if the order ID changed after edit (esp. for cancel/replace exchanges)
            if (editResult && editResult.id !== orderId) {
              orderId = editResult.id; // Update orderId for subsequent checks
              this.currentChaseOrderId = orderId;
            }

            consecutiveErrors = 0;
          } catch (error) {
            // Exchanges refuse amends for all sorts of reasons — order-action
            // rate limits, a partial fill, an order still settling from the last
            // amend. Cancelling and placing a fresh order achieves the same
            // thing and doesn't depend on amend being available at all.
            try {
              await this.exchange!.cancelOrder(orderId, market, params);
            } catch (cancelError) {
              // Couldn't amend and couldn't cancel: leave it alone this cycle
              // rather than risk ending up with two live orders.
              consecutiveErrors++;
              this.logAndReplace(
                `Chase: could not move the order to ${updatedBestPrice} ` +
                  `(${(error as Error).message}) [${consecutiveErrors}/${maxConsecutiveErrors}]`
              );

              if (consecutiveErrors >= maxConsecutiveErrors) {
                finishChase(
                  `Chase stopped after ${maxConsecutiveErrors} failed moves. ` +
                    `The order is still resting at ${order.price} — cancel it with 'cancel chase'.`
                );
                return;
              }

              scheduleNextCycle();
              return;
            }

            // The old order is gone from here on, so a failure to place the
            // replacement leaves nothing resting and must be said plainly.
            const replacement = await (side === 'buy'
              ? this.createLimitBuyOrder(market, updatedBestPrice, order.remaining, params, true)
              : this.createLimitSellOrder(market, updatedBestPrice, order.remaining, params, true));

            if (!replacement?.id) {
              finishChase(
                `Chase stopped: the order was cancelled to move it to ${updatedBestPrice}, ` +
                  `but the replacement could not be placed. Nothing is resting — you are not in this trade.`
              );
              return;
            }

            orderId = replacement.id;
            this.currentChaseOrderId = orderId;
            consecutiveErrors = 0;
          }
        } else {
          consecutiveErrors = 0;
        }

        remainingAmount = order.remaining;

        if (remainingAmount > 0) {
          scheduleNextCycle();
        } else {
          finishChase(`Chase ${side} order filled for ${amount} ${market}`);
        }
      } catch (error) {
        // Anything unexpected: keep the chase alive across a blip, but never
        // leave it running silently forever.
        consecutiveErrors++;

        if (consecutiveErrors >= maxConsecutiveErrors) {
          finishChase(
            `Chase stopped after ${maxConsecutiveErrors} consecutive errors ` +
              `(${(error as Error).message}). Any resting order is still live — check with 'cancel chase'.`
          );
          return;
        }

        scheduleNextCycle();
      }
    };

    this.currentChaseOrderId = orderId;

    // Prefer the live feeds when the exchange has them; fall back to polling if
    // they aren't supported or the socket refuses to start (bad key, blocked
    // port). A chase that polls is worse than one that streams, but far better
    // than one that doesn't run.
    const canStream =
      Boolean(this.exchange.has['watchOrderBook']) &&
      Boolean(this.exchange.has['watchOrders']);

    if (canStream) {
      this.runStreamingChase({
        market,
        side,
        amount,
        orderId,
        orderPrice: initialPrice,
        params,
      }).catch((error) => {
        if (!this.chaseLimitOrderActive) return;

        this.logAndReplace(
          `Chase: live feed unavailable (${(error as Error).message}); using polling instead.`
        );
        runCycle();
      });
    } else {
      runCycle();
    }

    // let's parse the decay time. 'decay' that takes a time argument in seconds e.g. `5s` or minutes e.g. `1m`
    const parseDecayTime = (decay: string): number => {
      const time = decay.slice(0, -1);
      const unit = decay.slice(-1);
      let decayTime = 0;

      if (unit === 's') {
        decayTime = parseInt(time) * 1000;
      } else if (unit === 'm') {
        decayTime = parseInt(time) * 60000;
      } else {
        throw new Error('Invalid decay time');
      }

      return decayTime;
    };

    if (decay) {
      const decayTime = parseDecayTime(decay);
      setTimeout(() => {
        if (this.chaseLimitOrderActive) {
          // Pass params to cancelChaseOrder
          this.cancelChaseOrder(orderId, market, params);
        }
      }, decayTime);
    }

    return orderId;
  }

  /**
   * What became of a chase order that vanished, reported as a fill event.
   *
   * A chase whose order disappears has usually filled, but not always in full.
   * The remainder is the thing worth knowing, so it is stated rather than left
   * for the trader to spot in the position size.
   */
  private async reportChaseOutcome(
    market: string,
    orderId: string,
    side: string,
    requested: number,
    finish: (message: string) => void
  ): Promise<void> {
    let filled: number | undefined;
    let price: number | undefined;

    try {
      const order = await this.exchange!.fetchOrder(orderId, market);
      filled = Number(order?.filled ?? 0);
      const raw = order?.average ?? order?.price;
      price = raw === undefined ? undefined : Number(raw);
    } catch {
      // The order is gone from the live book and not yet in history.
    }

    if (filled !== undefined && filled > 0) {
      NotificationManager.notify('', NType.SUCCESS, 'FILL', undefined, {
        side: side.toUpperCase(),
        quantity: this.formatQuantity(filled),
        price:
          price === undefined ? undefined : this.formatPriceForDisplay(market, price),
        status: filled + 1e-9 >= requested ? 'FILLED' : 'PARTIAL',
      });
    }

    const remainder = filled === undefined ? undefined : requested - filled;

    finish(
      remainder !== undefined && remainder > 1e-9
        ? `Chase ended with ${this.formatQuantity(remainder)} unfilled.`
        : filled === undefined
        ? 'Chase ended: the order is no longer on the exchange.'
        : ''
    );
  }

  async editOrder(
    orderId: string,
    symbol: string,
    orderType: string,
    price: number,
    quantity?: number,
    params?: Record<string, any>,
    knownOrder?: Order
  ): Promise<Order | undefined> {
    try {
      // A caller that already holds the order passes it in. Re-fetching order
      // history to find an order we were just looking at costs an extra API call
      // per edit, and on a chase that is the difference between keeping up with
      // the book and falling behind it.
      let order = knownOrder;

      if (!order) {
        // Pass params to fetchOrders for exchanges like Hyperliquid that require user context
        const orders = await this.exchange!.fetchOrders(symbol, undefined, undefined, params);
        order = orders.find((order) => order.id === orderId);
      }

      if (!order) {
        throw new Error(`Order with id ${orderId} not found`);
      }

      // If quantity is not provided, use the order's amount
      quantity = quantity !== undefined ? quantity : order.amount;

      const editedOrder = await this.exchange!.editOrder(
        order.id,
        symbol,
        orderType,
        String(order.side ?? ''),
        quantity,
        price,
        params
      );
      // Return the result of the exchange edit call
      return editedOrder;
    } catch (error) {
      // console.error('Error editing order:', error);
      // This has been disabled for now since it keeps throwing an error and polluting the console
      throw error;
    }
  }

  async bumpOrders(symbol: string, priceChange: number): Promise<void> {
    try {
      let hyperliquidParams: { user?: string } = {};
      let isHyperliquid = this.exchange?.id === 'hyperliquid';

      if (isHyperliquid) {
        const publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
        if (!publicAddress) {
          throw new Error('[ExchangeClient/bumpOrders] Hyperliquid requires publicAddress for bumping orders.');
        }
        hyperliquidParams = { 'user': publicAddress };
      }

      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined, isHyperliquid ? hyperliquidParams : undefined);

      if (openOrders.length > 0) {
        for (const order of openOrders) {
          const orderType = order.type?.toLowerCase() ?? '';
          let newPrice: number | undefined;

          if (isHyperliquid) {
            // Hyperliquid-specific logic
            if (orderType.includes('stop') || order.info?.isTrigger === true || order.info?.orderType?.toLowerCase().includes('stop')) {
              const currentStopPrice = order.stopPrice ?? order.price;
              if (currentStopPrice === undefined) {
                continue;
              }
              newPrice = currentStopPrice + priceChange;
              await this.updateStopOrder(symbol, order.amount, newPrice);
            } else if (orderType === 'limit') {
              newPrice = order.price + priceChange;
              await this.exchange!.editOrder(
                order.id,
                symbol,
                orderType, // 'limit'
                String(order.side ?? ''),
                Number(order.amount) > 0 ? order.amount : undefined,
                newPrice,
                hyperliquidParams
              );
            } else {
              // console.warn(`[ExchangeClient/bumpOrders] Hyperliquid: Skipping unsupported order type '${orderType}' for order ${order.id}`); // Removed log
            }
          } else {
            // Original logic for other exchanges (restored)
            let paramsForEdit: Record<string, any> | undefined = undefined; // Keep it undefined initially
            let originalNewPrice: number | undefined = undefined;

            if (orderType === 'stop') {
              const stopOrder = order as StopOrder;
              if (typeof stopOrder.stopPrice === 'number') {
                originalNewPrice = stopOrder.stopPrice + priceChange;
                // For non-Hyperliquid stop orders, params for editOrder might be needed by CCXT implicitly or explicitly by exchange
                // The original code example for Phemex used params = { stopPrice: newPrice }
                // A generic approach might be to ensure the trigger price field is in params if needed.
                // For ccxt unified editOrder, it often expects the new stop price as the main price argument for stop orders,
                // or within params if the exchange requires it differently. We'll pass it as main price for now.
                paramsForEdit = { [exchangeParams[this.exchange!.id]?.orders.stopLoss.STOP_LOSS_PROP || 'stopPrice']: originalNewPrice };
              } else {
                 console.warn(`[ExchangeClient/bumpOrders] Non-Hyperliquid: Order ${order.id} is type 'stop' but has no valid stopPrice. Skipping.`);
                 continue;
              }
            } else if (orderType === 'limit') {
              originalNewPrice = order.price + priceChange;
              // No special params typically needed for limit order price changes beyond the price itself.
            } else {
                console.warn(`[ExchangeClient/bumpOrders] Non-Hyperliquid: Skipping unsupported order type '${orderType}' for order ${order.id}`);
                continue;
            }

            if (originalNewPrice !== undefined) {

                await this.exchange!.editOrder(
                    order.id,
                    symbol,
                    orderType,
                    String(order.side ?? ''),
                    // A stop sized to the whole position has an amount of zero.
                    // Sending that is rejected as below the minimum; sending
                    // nothing leaves the existing size untouched, which is what
                    // moving a stop should do anyway.
                    Number(order.amount) > 0 ? order.amount : undefined,
                    originalNewPrice, // Pass the new price directly
                    paramsForEdit // Pass specific params if any (like for stop orders)
                );
            }
          }
        }
      } else {
        throw new Error('No open orders to bump');
      }
    } catch (error) {
      // Rethrown for the caller to report; logging here as well showed the same
      // failure twice.
      throw error;
    }
  }

  async closePosition(market: string): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before closing a position.`
      );
      return;
    }

    try {
      const position = await this.getPositionStructure(market);
      let quantity = 0;
      if (!position) {
        console.error('Position is not defined');
        return;
      }
      // Safely check position side - convert to string and compare
      const positionSide = String(position.side || '');
      const side = positionSide === 'long' ? 'sell' : 'buy';

      if (typeof position.contracts === 'number') {
        quantity = Math.abs(position.contracts);
      } else {
        throw new Error('Position size is not defined');
      }

      if (quantity > 0) {
        // Special handling for Hyperliquid market orders
        if (this.exchange.id === 'hyperliquid') {
          // Get current market price
          const ticker = await this.exchange.fetchTicker(market);
          const currentPrice = ticker.last || 0;

          // Add a buffer to ensure the order executes immediately
          const adjustedPrice = side === 'buy' ? currentPrice * 1.05 : currentPrice * 0.95;

          // Create a limit order that behaves like a market order
          await this.executeOrder(
            side === 'buy' ? 'createLimitBuyOrder' : 'createLimitSellOrder',
            market,
            await this.getQuantityPrecision(market, quantity, { enforceFatFinger: false }),
            adjustedPrice
          );
        } else {
          await this.executeOrder(
            'createMarketOrder',
            market,
            side,
            await this.getQuantityPrecision(market, quantity, { enforceFatFinger: false })
          );
        }
      } else {
        console.error(`[ExchangeClient] No positions found for ${market}.`);
      }
    } catch (error) {
      NotificationManager.notify(
        `Position not closed: ${(error as Error).message}. You are still in this position.`,
        NType.ERROR
      );
    }
  }

  calculatePositionSize(
    totalCapitalToRisk: number,
    riskPercentage: number,
    entryPrice: number,
    stopPrice: number
  ): number {
    const riskAmount = (totalCapitalToRisk * riskPercentage) / 100;
    const positionRisk = Math.abs(entryPrice - stopPrice);
    if (positionRisk === 0) {
      throw new Error(
        'Position risk cannot be zero. Entry price and stop price cannot be the same.'
      );
    }
    return riskAmount / positionRisk;
  }

  calculateRiskReturnRatio(
    entryPrice: number,
    stopPrice: number,
    takeProfitPrice: number
  ): number {
    return Math.abs(takeProfitPrice - entryPrice) / Math.abs(entryPrice - stopPrice);
  }

  async createBracketLimitOrder(
    market: string,
    side: string,
    capitalToRisk: number,
    riskPercentage: number,
    stopPrice: number,
    entryPrice: number
  ): Promise<void> {
    const slippageAdjustmentFactor = 1.75;
    const riskAmount = (capitalToRisk * riskPercentage) / 100;
    const quantity = riskAmount / Math.abs(entryPrice - stopPrice);
    const slippageAdjustedQuantity = quantity / slippageAdjustmentFactor;

    await (side === 'buy'
      ? this.createLimitBuyOrder(market, entryPrice, slippageAdjustedQuantity)
      : this.createLimitSellOrder(
          market,
          entryPrice,
          slippageAdjustedQuantity
        ));

    await this.createStopOrder(market, stopPrice, slippageAdjustedQuantity);

    const potentialLoss = Math.abs(entryPrice - stopPrice) * quantity;
    console.log(
      `Bracket ${side} order of ${slippageAdjustedQuantity.toFixed(
        2
      )} placed @ $${entryPrice.toFixed(2)}`
    );
    console.log(`Potential loss of around: $${potentialLoss.toFixed(2)}`);
  }

  async submitRangeOrders(
    action: string,
    market: string,
    startPrice: number,
    endPrice: number,
    numOrders: number,
    totalRiskPercentage: number,
    stopPrice: number,
    takeProfitPrice: number,
    totalCapitalToRisk: number,
    riskReturnRatioThreshold: number
  ) {
    const priceStep = (endPrice - startPrice) / (numOrders - 1);
    const riskPercentagePerOrder = totalRiskPercentage / numOrders;

    const spinner = ora(`Posting range ${action} orders...`).start();

    for (let i = 0; i < numOrders; i++) {
      const orderPrice = startPrice + priceStep * i;
      const positionSize = this.calculatePositionSize(
        totalCapitalToRisk,
        riskPercentagePerOrder,
        orderPrice,
        stopPrice
      );
      const riskReturnRatio = this.calculateRiskReturnRatio(
        orderPrice,
        stopPrice,
        takeProfitPrice
      );

      if (riskReturnRatio <= riskReturnRatioThreshold) {
        throw new Error(
          `Risk/return ratio of ${riskReturnRatio} is below the threshold of ${riskReturnRatioThreshold}.`
        );
      }

      if (action === 'buy') {
        await this.createLimitBuyOrder(market, orderPrice, positionSize);
      } else if (action === 'sell') {
        await this.createLimitSellOrder(market, orderPrice, positionSize);
      } else {
        throw new Error(`Invalid action: ${action}. Expected 'buy' or 'sell'`);
      }
    }

    spinner.stop();

    this.createStopOrder(market, stopPrice);

    const allOrders = await this.exchange!.fetchOrders(market);
    const openOrders = allOrders.filter((order) => order.status === 'open');
    const openQuantity = openOrders.reduce((acc, order) => {
      if (order.type !== 'stop' && !isNaN(order.remaining)) {
        return acc + order.remaining;
      } else {
        return acc;
      }
    }, 0);
    const avgOrderPrice =
      openOrders.reduce((acc, order) => {
        if (!isNaN(order.price)) {
          return acc + order.price;
        } else {
          return acc;
        }
      }, 0) / openOrders.length;
    const totalPotentialProfit =
      Math.abs(avgOrderPrice - takeProfitPrice) * openQuantity;
    const totalPotentialLoss =
      Math.abs(avgOrderPrice - stopPrice) * openQuantity;
    const totalRiskReturnRatio = totalPotentialProfit / totalPotentialLoss;

    console.log(`Average order price: ${avgOrderPrice.toFixed(2)}`);

    console.log(
      `Total position size: ${openQuantity.toFixed(3)} ${market.split('/')[0]}`
    );
    console.log(
      `Total potential profit: ${totalPotentialProfit.toFixed(2)} ${
        market.split('/')[1].split(':')[0]
      }`
    );
    console.log(
      `Total potential loss: ${totalPotentialLoss.toFixed(2)} ${
        market.split('/')[1].split(':')[0]
      }`
    );
    console.log(`Total risk/return ratio: ${totalRiskReturnRatio.toFixed(2)}`);
  }

  async createMarketBuyOrder(market: string, quantity: number): Promise<void> {
    if (this.exchange?.id === 'hyperliquid') {
      // For Hyperliquid, create a "limit" order that behaves like a market order
      const ticker = await this.exchange.fetchTicker(market);
      const currentPrice = ticker.last || 0; // Add default value to avoid undefined

      // Add a buffer to ensure the order executes immediately
      const adjustedPrice = currentPrice * 1.05; // 5% above market price

      // Create a limit order with post-only=false to ensure it executes immediately
      await this.createLimitBuyOrder(
        market,
        adjustedPrice,
        await this.getQuantityPrecision(market, quantity, { price: currentPrice })
      );
    } else {
      await this.executeOrder(
        'createMarketBuyOrder',
        market,
        await this.getQuantityPrecision(market, quantity)
      );
    }
  }

  async createMarketSellOrder(market: string, quantity: number): Promise<void> {
    if (this.exchange?.id === 'hyperliquid') {
      // For Hyperliquid, create a "limit" order that behaves like a market order
      const ticker = await this.exchange.fetchTicker(market);
      const currentPrice = ticker.last || 0; // Add default value to avoid undefined

      // Add a buffer to ensure the order executes immediately
      const adjustedPrice = currentPrice * 0.95; // 5% below market price

      // Create a limit order with post-only=false to ensure it executes immediately
      await this.createLimitSellOrder(
        market,
        adjustedPrice,
        await this.getQuantityPrecision(market, quantity, { price: currentPrice })
      );
    } else {
      await this.executeOrder(
        'createMarketSellOrder',
        market,
        await this.getQuantityPrecision(market, quantity)
      );
    }
  }

  async createLimitBuyOrder(
    market: string,
    price: number,
    quantity: number,
    params?: Record<string, any>,
    postOnly?: boolean
  ): Promise<any> {
    const order = await this.executeOrder(
      'createLimitBuyOrder',
      market,
      await this.getQuantityPrecision(market, quantity, { price }),
      price,
      postOnly,
      params
    );
    return order;
  }

  async createLimitSellOrder(
    market: string,
    price: number,
    quantity: number,
    params?: Record<string, any>,
    postOnly?: boolean
  ): Promise<any> {
    const order = await this.executeOrder(
      'createLimitSellOrder',
      market,
      await this.getQuantityPrecision(market, quantity, { price }),
      price,
      postOnly,
      params
    );
    return order;
  }

  async editCurrentStopOrder(symbol: string, newStopPrice: number): Promise<string | undefined> {
    if (this.exchange === null) {
        console.error(
            `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching the stop order ID.`
        );
        return;
    }

    // --- Hyperliquid Handling ---
    if (this.getExchangeId() === 'hyperliquid') {
        try {
            // For Hyperliquid, use the cancel/replace strategy via updateStopOrder
            // Capture and return the new order ID from updateStopOrder
            const newOrderId = await this.updateStopOrder(symbol, undefined, newStopPrice);
            return newOrderId;
        } catch (error) {
            NotificationManager.diagnostic(`[editCurrentStopOrder] ${(error as Error).message}`);
            // Re-throw or return undefined based on desired error handling
            throw error;
        }
    }

    // --- Original Logic for Other Exchanges ---
    // Identified by carrying a trigger price rather than by an order-type
    // string, which varies by exchange and by how ccxt happens to map it.
    const openOrders = await this.exchange.fetchOpenOrders(symbol);
    const stopOrder = openOrders.find((order) => {
      const info = (order as any).info ?? {};
      const trigger = Number((order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp ?? 0);
      if (!(trigger > 0)) return false;

      const orderType = String(info.ordType ?? info.orderType ?? order.type ?? '').toLowerCase();
      // A touch order is a take profit, not a stop.
      return !orderType.includes('iftouched');
    });

    if (!stopOrder) {
      throw new Error(`No stop order found for ${symbol} to move.`);
    }

    await this.exchange.editOrder(
      stopOrder.id,
      symbol,
      'stop',
      String(stopOrder.side ?? ''),
      // A stop covering the whole position has an amount of zero. Sending that
      // is rejected as below the minimum; sending nothing leaves the existing
      // size alone, which is what moving a stop should do.
      Number(stopOrder.amount) > 0 ? stopOrder.amount : undefined,
      // A stop-market has no limit price of its own. Passing the trigger here
      // as well would set a limit price on an order that shouldn't have one --
      // the trigger belongs in the params below.
      undefined,
      { stopPrice: newStopPrice }
    );

    return stopOrder.id;
  }

  // Helper method to calculate default stop amount
  private async _calculateDefaultStopAmount(market: string): Promise<number> {
    // Get public wallet address from exchange config for Hyperliquid
    const publicAddress = this.exchange?.id === 'hyperliquid' ?
      (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

    // Sizing only; a moment-old view is fine here.
    const openOrders = await this.getLiveOpenOrders(market,
        publicAddress ? { 'user': publicAddress } : undefined);

    // Filter to only include limit orders, excluding stop/market orders
    // This logic might need refinement based on exact CCXT/Hyperliquid behavior
    const limitOrders = openOrders?.filter((order) => {
        const isLimit = order.type === 'limit' || (order.info && order.info.orderType === 'Limit');
        // Refined check to explicitly exclude known stop/trigger types
        const isNotStopTrigger = !(order.type?.toLowerCase().includes('stop') ||
                                 order.info?.type === 'trigger' ||
                                 order.info?.orderType === 'StopMarket' ||
                                 order.info?.orderType === 'Stop Limit' ||
                                 order.info?.isTrigger === true);
        return isLimit && isNotStopTrigger;
    });

    // Get the position size for the given market
    const position = await this.getPositionStructure(market);
    // Ensure positionSize is non-negative
    const positionSize = Math.abs(position?.contracts ?? 0);

    // Calculate the total quantity of open limit orders
    const openOrdersQuantity = limitOrders?.reduce((acc, order) => {
        // Ensure order.remaining is treated as a number
        return acc + (order.remaining ?? 0);
    }, 0) ?? 0;

    // Total quantity is position size plus open limit orders quantity
    let quantity = positionSize;
    if (openOrdersQuantity > 0) {
        quantity += openOrdersQuantity;
    }
    return quantity;
  }

  async createStopOrder(
    market: string,
    price: number,
    quantity?: number,
    suppressLog?: boolean,
    enforceFatFinger: boolean = true
  ): Promise<Order | undefined> {
    // A size we work out from the position isn't something the user typed, so it
    // isn't subject to the fatfinger limit — a stop must always be placeable.
    const sizeCameFromUser = quantity !== undefined;
    if (!this.exchange) {
        console.error('[ExchangeClient/createStopOrder] Exchange not initialized.');
        return undefined;
    }
    try {
      // Format price according to market precision
      const marketInfo = this.availableMarkets![market];
      if (!marketInfo || !marketInfo.precision || marketInfo.precision.price === undefined) {
        throw new Error(`Market ${market} precision info not found`);
      }
      // Format price to required decimal places
      price = Number(price.toFixed(Math.abs(Math.log10(marketInfo.precision.price))));

      // A stop is only meaningful near the market, so a price nowhere near it is
      // almost always transposed arguments -- 'stop 0.5 15000' in the old
      // size-first order, which now reads as a stop at 0.5. Refuse it rather than
      // resting an order that can never behave as intended.
      const marketPrice = await this.getReferencePrice(market);

      if (marketPrice !== undefined) {
        const ratio = price / marketPrice;

        if (ratio > 10 || ratio < 0.1) {
          throw new Error(
            `Stop price ${price} is far from the market price of ${marketPrice} for ${market}. ` +
              `No order was placed. The stop price comes first: 'stop <price> [size]'.`
          );
        }
      }

      let side;

      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // Side determination only; a moment-old view is fine here.
      const openOrders = await this.getLiveOpenOrders(market,
        walletAddress ? { 'user': walletAddress } : undefined);

       // Filter to only include limit orders, excluding stop/market orders (needed for side calculation)
      const limitOrders = openOrders?.filter((order) => {
          const isLimit = order.type === 'limit' || (order.info && order.info.orderType === 'Limit');
          const isNotStopTrigger = !(order.type?.toLowerCase().includes('stop') ||
                                   order.info?.type === 'trigger' ||
                                   order.info?.orderType === 'StopMarket' ||
                                   order.info?.orderType === 'Stop Limit' ||
                                   order.info?.isTrigger === true);
          return isLimit && isNotStopTrigger;
      });

      const position = await this.getPositionStructure(market);
      const hasPosition =
        position?.contracts !== undefined && position.contracts > 0;

      // Phemex expresses "the whole position" as an order quantity of zero: the
      // exchange closes whatever the position is at the moment the stop fires,
      // rather than a size fixed when it was placed. That is what the UI creates
      // when you set a stop on a position, and it is why an explicitly sized
      // stop shows up as a standalone conditional order instead.
      //
      // Only when the size wasn't given. 'stop <price> <size>' still means that
      // size, so a partial stop is still possible.
      const closeWholePosition =
        !sizeCameFromUser && this.exchange.id === 'phemex' && hasPosition;

      if (closeWholePosition) {
        quantity = 0;
      } else if (quantity === undefined) {
        quantity = await this._calculateDefaultStopAmount(market);
      }

      // If there's a non-zero quantity, proceed with creating the stop order
      if (quantity > 0 || closeWholePosition) {
        // Get limit orders only and determine their side if there are no open positions from which to determine the side
        if (hasPosition) {
          side = position?.side === 'long' ? 'sell' : 'buy';
        } else if (limitOrders.length > 0) {
          side = limitOrders[0].side === 'buy' ? 'sell' : 'buy';
        } else {
          // Reuse the price already fetched for the sanity check above.
          const currentPrice = marketPrice ?? 0;

          // If stop price is below current price, it's a sell stop
          // If stop price is above current price, it's a buy stop
          side = price < currentPrice ? 'sell' : 'buy';
        }

        // Get the appropriate exchange parameters based on the current exchange
        const exchangeName = this.exchange!.id;
        const orderType =
          exchangeParams[exchangeName].orders.stopLoss.ORDER_TYPE;
        const stopLossProp =
          exchangeParams[exchangeName].orders.stopLoss.STOP_LOSS_PROP;
        const reduceOnlySupported =
          exchangeParams[exchangeName].orders.stopLoss.REDUCE_ONLY.SUPPORTED;
        const reduceOnlyProp =
          exchangeParams[exchangeName].orders.stopLoss.REDUCE_ONLY
            .REDUCE_ONLY_PROP || '';

        // Create an object for the order parameters, setting the stop loss price according to the appropriate property
        const params: { [key: string]: any } = {
          [stopLossProp]: price,
        };

        // Special handling for Hyperliquid stop orders
        if (this.exchange!.id === 'hyperliquid') {
          // Add any specific parameters needed for Hyperliquid stop orders
          params.trigger = 'ByLastPrice'; // Assuming this is the default trigger type for Hyperliquid

          // Add the wallet address parameter for Hyperliquid if available
          if (walletAddress) {
            params.user = walletAddress;
          }
        }

        if (this.exchange!.id === 'phemex') {
          // ccxt wants the direction as the string 'up' or 'down' and uses it to
          // choose the Phemex order type. It was being sent as 1 or 2, which
          // matches nothing, so the direction was silently discarded.
          //
          // Derive it from where the trigger sits relative to the market rather
          // than from the side, so a trigger on the far side of the market
          // becomes MarketIfTouched instead of an unreachable Stop.
          params.triggerDirection =
            marketPrice !== undefined
              ? price > marketPrice
                ? 'up'
                : 'down'
              : side === 'sell'
              ? 'down'
              : 'up';

          // The UI triggers on last price; ccxt defaults to mark price, and the
          // two diverge. 'trigger' was the wrong key and never took effect.
          params.triggerType = 'ByLastPrice';
        }

        // If the reduce-only feature is supported by the exchange, add the corresponding property to the parameters object
        if (reduceOnlySupported) {
          params[reduceOnlyProp] = true;
        }

        // Adjust the quantity to match the exchange's precision requirements
        // A zero quantity is the "whole position" marker, not a size, so it
        // skips the size checks -- which would reject it, and which have nothing
        // to guard against when the exchange caps the fill at the position.
        if (!closeWholePosition) {
          quantity = await this.getQuantityPrecision(market, quantity, {
            enforceFatFinger: enforceFatFinger && sizeCameFromUser,
            price,
          });
        }

        // --- Adjust parameters for Hyperliquid Stop Market ---
        let finalOrderType = orderType;
        let finalPriceArg: number | undefined = price; // Initialize with the stop price
        let finalParams = { ...params };

        if (this.exchange.id === 'hyperliquid') {
            finalOrderType = 'market'; // Use market type for stop-market
            finalPriceArg = price; // Pass the trigger price as the main price argument for slippage calculation
            if (!finalParams.triggerPrice) finalParams.triggerPrice = price;
            finalParams.reduceOnly = true;
        } else if (
            finalOrderType.toLowerCase() === 'stop' ||
            finalOrderType.toLowerCase() === 'market'
        ) {
            // A stop-market has no limit price of its own, so the main price
            // argument stays undefined. The trigger price is already carried in
            // finalParams under the exchange's own key.
            finalPriceArg = undefined;
        }
        // --- End Hyperliquid Adjustment ---

        // Execute the stop order and get the created order object
        const createdOrder = await this.executeOrder(
          'createOrder',
          market,
          finalOrderType, // Use adjusted type
          side,
          quantity,
          finalPriceArg, // Use adjusted price arg (potentially undefined for Phemex stop-market)
          finalParams // Use adjusted params
        );

        // Only log and return if the order was successfully created
        if (createdOrder) {
          if (!suppressLog) {
              NotificationManager.notify('', NType.INFO, 'ORDER', undefined, {
                side: side.toUpperCase(),
                quantity: closeWholePosition ? 'ALL' : this.formatQuantity(quantity),
                price: this.formatPriceForDisplay(market, price),
                status: 'STOP WORKING',
              });
          }
          return createdOrder;
        } else {
          // executeOrder already logs specific errors, so we just return undefined
          return undefined;
        }
      } else {
        // If there's no position found, log an error message and return undefined
        console.error(
          `[ExchangeClient] No positions or open orders found to determine quantity/side for market ${market}. Cannot create stop order.`
        );
        return undefined; // Return undefined if order not created
      }
    } catch (error) {
      // If any errors occur during the process, log the error message
      const failure = describeExchangeError(error);
      // The full response stays available, marked as diagnostic so it doesn't
      // run across the activity row.
      NotificationManager.diagnostic(`[createStopOrder] ${failure.raw}`);

      NotificationManager.notify(failure.summary, NType.ERROR, 'ERROR', undefined, {
        side: 'STOP',
        status: 'REJECTED',
      });
      return undefined; // Return undefined on error
    }
  }

  async updateStopOrder(
    market: string,
    newAmount?: number,
    newStopPrice?: number
  ): Promise<string | undefined> {
    if (!this.exchange) {
      throw new Error('Exchange not initialized');
    }
    let newOrderId: string | undefined = undefined;

    try {
      let params: Record<string, any> = {};
      let publicAddress: string | undefined;

      // Hyperliquid specific logic: requires publicAddress
      if (this.exchange.id === 'hyperliquid') {
        publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
        if (!publicAddress) {
          throw new Error('[ExchangeClient] Hyperliquid requires publicAddress (or walletAddress) for fetching/editing orders.');
        }
        // Use 'user' as the key for Hyperliquid params, matching other methods
        params = { 'user': publicAddress };
      }

      const openOrders = await this.exchange.fetchOpenOrders(market, undefined, undefined, params);

      // Find the stop order (using Hyperliquid-specific checks if necessary)
      const stopOrder = openOrders.find(order => {
        const isStop = order.type?.toLowerCase().includes('stop');
        if (this.exchange?.id === 'hyperliquid') {
          return isStop ||
                 order.info?.type === 'trigger' ||
                 order.info?.orderType === 'StopMarket' ||
                 order.info?.orderType === 'Stop Limit' || // Added 'Stop Limit'
                 order.info?.isTrigger === true;
        } else {
          return isStop;
        }
      });

      if (!stopOrder) {
        console.warn(`[ExchangeClient] No open stop order found for ${market} to update.`);
        return;
      }

      // Ensure the found stop order has a stop price defined before proceeding
      if (stopOrder.stopPrice === undefined) {
        console.error(`[ExchangeClient] Found stop order ${stopOrder.id} for ${market}, but its stopPrice is undefined. Cannot update.`);
        return;
      }

      // Determine the final amount
      let finalAmount: number;
      if (newAmount !== undefined) {
        // Typed by the user, so the fatfinger limit applies.
        finalAmount = await this.getQuantityPrecision(market, newAmount, {
          price: newStopPrice ?? stopOrder.stopPrice,
        });
      } else {
        // If newAmount is not provided, calculate the default amount using the helper
        finalAmount = await this._calculateDefaultStopAmount(market);
        finalAmount = await this.getQuantityPrecision(market, finalAmount, {
          enforceFatFinger: false,
        }); // Apply precision
      }

      // Determine the final stop price
      // Use existing stop price if newStopPrice is not provided
      const finalStopPrice: number = newStopPrice !== undefined ? newStopPrice : stopOrder.stopPrice;

      // Validate the calculated/provided final amount
      if (finalAmount <= 0) {
        console.warn(`[ExchangeClient] Calculated/Provided amount (${finalAmount}) is zero or negative. Cannot update stop order ${stopOrder.id}.`);
        // If only price was provided, maybe allow price-only update?
        // Current logic requires a valid amount to proceed.
        // Consider if a price-only update makes sense when amount becomes invalid.
        if (newAmount === undefined && newStopPrice !== undefined && stopOrder.amount > 0) {
             // Attempt price-only update if original amount was valid and new amount calculation failed
             this.logAndReplace(`Calculated amount is invalid (${finalAmount}), attempting to update price only for stop order ${stopOrder.id} to ${finalStopPrice}`);
              await this.editOrder(
                 stopOrder.id,
                 market,
                 stopOrder.type ?? 'limit',
                 finalStopPrice,
                 stopOrder.amount, // Use original amount
                 params
              );
              this.logAndReplace(`Updated stop order ${stopOrder.id} price to ${finalStopPrice}`);
        } else {
             console.warn(`[ExchangeClient] Invalid amount (${finalAmount}) prevents update for stop order ${stopOrder.id}.`);
        }
        return; // Exit if amount is invalid
      }

       // Parameters for cancel/create (mainly the user ID for Hyperliquid)
      let cancelReplaceParams: Record<string, any> = { ...params }; // Copy base params (like user)

      // --- Always use Cancel/Replace Logic ---
      try {
          // 1. Cancel the existing order
          await this.exchange.cancelOrder(stopOrder.id, market, cancelReplaceParams);

          // 2. Create a new stop order and capture the result. finalAmount was
          // already checked above, and the old stop is now cancelled — a second
          // check here could only fail and leave the position with no stop.
          const newOrder = await this.createStopOrder(market, finalStopPrice, finalAmount, true, false);
          newOrderId = newOrder?.id; // Store the new order ID

      } catch (replaceError) {
          console.error(`[ExchangeClient] Error during cancel/replace:`, replaceError);
          // Rethrow or handle - potentially the cancel succeeded but create failed, leaving no stop.
          throw replaceError;
      }

    } catch (error: any) {
        if (error.message && error.message.includes('Order not found')) {
            console.warn(`[ExchangeClient] Attempted to update stop order ${market}, but it might have been filled or cancelled.`);
        } else {
            const failure = describeExchangeError(error);
      NotificationManager.diagnostic(`[updateStopOrder] ${failure.raw}`);
      NotificationManager.notify(`Stop NOT updated: ${failure.summary}`, NType.ERROR, 'ERROR');
            // Potentially re-throw or handle specific errors differently
             throw error;
        }
    }
    return newOrderId; // Return the ID of the new order (or undefined)
  }

  async synchronizeTimeWithExchange() {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before synchronizing time.`
      );
      return;
    }

    // Check if the exchange supports the fetchTime method
    if (!this.exchange.has['fetchTime']) {
      console.log(`[ExchangeClient] fetchTime not supported by ${this.exchange.name}.`);
      return;
    }

    try {
      const serverTime = await this.exchange.fetchTime() ?? 0;
      const localTime = Date.now();
      const timeDifference = serverTime - localTime;

      // Synchronize time if there is any difference
      if (timeDifference !== 0) {
        // Adjust the exchange's API object to account for the time difference
        this.exchange.options.adjustForTimeDifference = true;
        this.exchange.options.timeDifference = timeDifference;

        console.log(`Time synchronized with exchange. Time difference: ${timeDifference} ms`);
      } else {
        console.log(`No need to synchronize time. Time difference: ${timeDifference} ms`);
      }
    } catch (error) {
      NotificationManager.diagnostic(`[synchronizeTime] ${(error as Error).message}`);
    }
  }

  // Getter for the current exchange ID
  public getExchangeId(): string | undefined {
    return this.exchange?.id;
  }

  // Helper to get market price tick size
  private getMarketPriceTickSize(marketSymbol: string): number {
    if (!this.availableMarkets) {
        console.warn('[ExchangeClient] Markets not loaded, cannot get tick size. Defaulting to small value.');
        // Return a reasonably small default if markets aren't loaded
        // This might need adjustment based on typical market values
        return 0.01;
    }
    const marketInfo = this.availableMarkets[marketSymbol];
    if (!marketInfo || !marketInfo.precision || marketInfo.precision.price === undefined) {
        console.warn(`[ExchangeClient] Precision info not found for ${marketSymbol}. Defaulting to small value.`);
        return 0.01;
    }
    // ccxt stores precision as 1 / tickSize (e.g., 0.01 precision means tick size of 100 is wrong) -> needs tickSize directly if available, or calculate
    // Let's assume marketInfo.precision.price IS the tick size for now, which is common.
    // If errors persist, investigate if ccxt provides tickSize differently for this exchange.
    return marketInfo.precision.price;
  }

  // --- REMOVE Temporary Latency Ping Method --- START
  /*
  async pingExchangeLatency(numPings: number = 10): Promise<number> { ... }
  */
  // --- REMOVE Temporary Latency Ping Method --- END
}
