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
import {
  Candle,
  averageTrueRange,
  closedCandles,
  atrTrailOffset,
  rangeOver,
  nestRanges,
  RANGE_WINDOWS,
} from '../trading/volatility.js';
import { TrailSpec, describeTrailSpec } from '../trading/trailSpec.js';
import {
  planTrailStop,
  advanceHighWaterMark,
  TrailSide,
} from '../trading/adaptiveTrail.js';
import { buildTrailTag, readTrailTag, TrailTag } from '../trading/trailTag.js';
import { describeExchangeError, isMissingOrderError } from '../utils/exchangeErrors.js';
import { classifyOrderStatus, staleOrderIds } from './orderCacheRules.js';
import { GuardService } from '../guard/guardService.js';
import { OrderProposal, PositionContext } from '../guard/detectors.js';
import { GuardVerdict } from '../guard/guardrails.js';
import { MarketContext, MarketSeries } from '../guard/marketContext.js';
import { describeOrders } from '../trading/orderView.js';
import { resolvePolicy, GuardPolicy } from '../guard/guardPolicy.js';
import {
  describeExitPlan,
  ExitUrgency,
  planExit,
} from '../trading/exitPlan.js';
import { ExitExecutionPort, ExitExecutor } from '../trading/exitExecutor.js';
import { NotificationManager } from '../utils/notificationManager.js';
import { NType } from '../utils/notificationManager.js';

/** How an order ended: the one shape every caller reads. */
/** How many orders a cancel actually removed, and how many refused. */
export interface CancelResult {
  cancelled: number;
  failed: number;
}

/** One period's high and low, as the RANGE panel shows them. */
export interface PriceRangeView {
  label: string;
  high?: number;
  low?: number;
  /** What a bar of this period typically covers. */
  atr?: number;
}

export interface OrderOutcome {
  status: string;
  filled: number;
  average?: number;
  at: number;
}

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
  /**
   * Behavioural guardrails.
   *
   * Created eagerly and unconditionally: it must be able to record from the
   * very first fill, and a journal with a hole in it at the start of the
   * session is one that cannot say what the session's typical size was.
   */
  private guard = new GuardService();
  private guardSweepTimer: NodeJS.Timeout | null = null;
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
  private chaseDeadline: number | undefined = undefined;
  private tickerStreams = new Map<
    string,
    {
      price: number | undefined;
      bid?: number;
      ask?: number;
      at: number;
      running: boolean;
    }
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
  /** Markets with a background order refresh already running. */
  private orderResyncInFlight = new Set<string>();
  /** Keyed by market, timeframe and period; valid until the next candle closes. */
  private atrCache = new Map<string, { until: number; value?: number }>();
  private rangeCache = new Map<string, { at: number; ranges: PriceRangeView[] }>();
  /** Markets with a background range refresh already running. */
  private rangeRefreshInFlight = new Set<string>();
  private candleCache = new Map<string, { until: number; candles: Candle[] }>();
  /** Markets known to carry an adaptive trail, so the monitor knows where to look. */
  private adaptiveMarkets = new Set<string>();
  /** Consecutive amendment failures per order; a trail is abandoned after too many. */
  private trailFailures = new Map<string, number>();
  /** Orders the monitor has given up on, so it does not keep retrying silently. */
  private abandonedTrails = new Set<string>();
  /**
   * Best price reached since each managed trail was placed.
   *
   * Held here rather than on the exchange because nothing else needs it: the
   * exchange is running a plain stop and has no idea it is a trail. Losing this
   * to a restart is recoverable -- see reconstructHighWaterMark -- and cannot
   * lower a stop, only delay raising one.
   */
  private trailHighWater = new Map<string, number>();
  private trailTimer: NodeJS.Timeout | null = null;
  private trailReviewRunning = false;
  /** Trails already announced as resumed, so a restart says so once. */
  private trailResumeAnnounced = new Set<string>();
  /** Delayed trails that have reached their arming price and begun trailing. */
  private armedTrails = new Set<string>();
  /** Looked up once per session; it does not change while connected. */
  private accountLabel: string | undefined;
  private equityCache:
    | { at: number; currency: string; balance?: number; equity?: number }
    | undefined;
  private equityRefreshInFlight = false;
  private accountLookupDone = false;
  /** The market being followed, so account lookups know which wallet to ask for. */
  private lastFollowedMarket: string | undefined;
  private orderStreams = new Map<
    string,
    {
      orders: Map<string, Order>;
      filledSoFar: Map<string, number>;
      /**
       * How orders ended, as the feed reported it.
       *
       * The stream says an order closed, for how much and at what price, at the
       * moment it happens. Discarding that and then asking the REST history API
       * the same question is what made filled orders report as unfilled: that
       * API trails the book and answers with an empty record in between.
       */
      finished: Map<string, OrderOutcome>;
      running: boolean;
      healthy: boolean;
      /** When the feed last delivered anything. */
      syncedAt: number;
      /** When the cache was last rebuilt from the exchange's own list. */
      snapshotAt: number;
    }
  >();

  private constructor() {
    this.exchangeManager = new ConfigManager();
    this.supportedExchanges = [];
    this.eventEmitter = new EventEmitter();
    this.chaseLimitOrderActive = false;

    // The guard knows nothing about exchanges by design, so what the coach may
    // see of the market arrives as a function rather than as a dependency. It
    // resolves to undefined until a market is being followed, which is exactly
    // what a coach asked about the market before one is chosen should be told.
    this.guard.setMarketSource(() => this.getMarketContext().catch(() => undefined));
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
    await this.loadGuardPolicy();
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
  /**
   * Unrealized on one position, derived from entry and mark.
   *
   * It is derived rather than read because ccxt's parsed `unrealizedPnl` is
   * not usable on Phemex: on a 250-lot sitting 0.04 above entry it returned
   * 0.00105 where the true figure was 10.00. Anything that trusts that field
   * reports a flat account no matter how the position is doing.
   *
   * The mark comes from the position payload rather than a price lookup, and
   * that is the point: entry, size and mark then all describe the same instant.
   * Valuing against a separately fetched price mixes two snapshots, which is
   * what made the panel show a mark and an unrealized figure that could not be
   * reconciled with each other. It also costs nothing -- the exchange sends it
   * with the position, and it is the mark that drives the liquidation price
   * shown beside it.
   *
   * Phemex marks positions to the mark price, not the last trade, so order
   * pricing keeps using getReferencePrice: the last trade is what a taker
   * actually pays. The two answer different questions.
   *
   * Both the position panel and account equity come through here, so the two
   * cannot report different unrealized figures on the same screen.
   */
  /** The mark the exchange stamped on this position, if it sent a usable one. */
  private markPriceOf(position: any): number | undefined {
    const mark = Number(position?.markPrice ?? NaN);
    return Number.isFinite(mark) && mark > 0 ? mark : undefined;
  }

  private unrealizedPnlOf(position: any, market: string): number | undefined {
    const contracts = Math.abs(Number(position?.contracts ?? 0));
    if (contracts === 0) return undefined;

    const mark = this.markPriceOf(position);

    const marketInfo = this.availableMarkets?.[market];
    const contractSize = Number(marketInfo?.contractSize ?? 1);
    const entry = Number(position?.entryPrice ?? NaN);

    if (!Number.isFinite(entry) || entry <= 0) return undefined;
    if (mark === undefined || !Number.isFinite(mark) || mark <= 0) return undefined;

    const direction =
      String(position?.side ?? '').toLowerCase() === 'long' ? 1 : -1;

    return marketInfo?.inverse
      ? contracts * contractSize * (1 / entry - 1 / mark) * direction
      : contracts * contractSize * (mark - entry) * direction;
  }

  async getPositionView(market: string): Promise<{
    side: string;
    size: number;
    entry?: number;
    /** The mark these figures were computed against, not a separate reading. */
    mark?: number;
    unrealizedPnl?: number;
    realizedPnl?: number;
    leverage?: number;
    effectiveLeverage?: number;
    liquidation?: number;
    /** Position value in the settlement currency, as the exchange reports it. */
    notional?: number;
    currency: string;
  } | null> {
    const position = await this.getPositionStructure(market);
    const contracts = Math.abs(Number(position?.contracts ?? 0));
    if (!position || contracts === 0) return null;

    const info = position as any;
    const marketInfo = this.availableMarkets?.[market];
    const currency = String(marketInfo?.settle ?? marketInfo?.quote ?? '');

    const entry = Number(position.entryPrice ?? info.entryPrice ?? NaN);
    const unrealizedPnl = this.unrealizedPnlOf(position, market);

    return {
      side: String(position.side ?? '').toUpperCase(),
      size: contracts,
      entry: Number.isFinite(entry) ? entry : undefined,
      mark: this.markPriceOf(position),
      unrealizedPnl,
      realizedPnl: this.readRealizedPnl(info),
      leverage: Number(info.leverage) || undefined,
      effectiveLeverage: await this.getEffectiveLeverage(
        market,
        Math.abs(Number(position.notional ?? info.valueRv ?? NaN)),
        currency
      ),
      liquidation: Number(info.liquidationPrice) || undefined,
      notional: Number.isFinite(Number(position.notional ?? info.valueRv))
        ? Math.abs(Number(position.notional ?? info.valueRv))
        : undefined,
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

  /**
   * How an order ended, from the feed if it saw it and from the exchange if not.
   *
   * One place decides what "finished" means, so the rule that an empty record is
   * 'not known yet' rather than 'nothing filled' is written once instead of at
   * every call site -- which is how filled orders came to be reported as
   * unfilled in three separate places.
   *
   * The feed is asked first because it already knows, and again between each
   * fallback attempt, since the event may arrive while the REST lookup is being
   * waited on.
   */
  async getOrderOutcome(
    market: string,
    orderId: string
  ): Promise<OrderOutcome | undefined> {
    const fromStream = () => this.orderStreams.get(market)?.finished.get(orderId);

    const streamed = fromStream();
    if (streamed) return streamed;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await this.sleep(750);
        const late = fromStream();
        if (late) return late;
      }

      try {
        const order = await this.exchange!.fetchOrder(orderId, market);
        const filled = Number(order?.filled ?? NaN);
        const status = String(order?.status ?? '');

        // Only a record that says something is allowed to decide the outcome.
        if (Number.isFinite(filled) && (filled > 0 || status !== '')) {
          const average = Number(order?.average ?? order?.price ?? NaN);
          return {
            status,
            filled,
            average: Number.isFinite(average) ? average : undefined,
            at: Date.now(),
          };
        }
      } catch {
        // Not in the history API yet either; the next pass re-checks the feed.
      }
    }

    return undefined;
  }

  /** Open orders for display. Uses the live view; completeness isn't critical. */
  /**
   * The order list for the screen, which never waits on the exchange.
   *
   * Redrawing is on a two-second timer, and a reconciliation lands in the
   * middle of that every twenty seconds. Awaiting it there stalled the whole
   * frame -- position, market and orders all repaint together -- for as long as
   * the request took.
   *
   * So the cache answers immediately and the refresh happens behind it. What is
   * shown is at worst one cycle old, and everything this process does to orders
   * updates the cache directly, so the operator's own actions still appear at
   * once.
   */
  async getOpenOrdersForDisplay(market: string): Promise<Order[]> {
    const state = this.orderStreams.get(market);

    if (state?.healthy === true) {
      // snapshotAt only moves when a refresh finishes, so without this the
      // two-second redraw would start a new one on every tick while the first
      // was still running.
      if (
        Date.now() - state.snapshotAt > ExchangeClient.ORDER_RESYNC_MS &&
        !this.orderResyncInFlight.has(market)
      ) {
        this.orderResyncInFlight.add(market);
        void this.getLiveOpenOrders(market)
          .catch(() => undefined)
          .finally(() => this.orderResyncInFlight.delete(market));
      }
      return Array.from(state.orders.values());
    }

    try {
      return await this.getLiveOpenOrders(market);
    } catch {
      return [];
    }
  }

  private static readonly FUNDING_CACHE_MS = 15000;
  /**
   * Phemex's kline endpoint accepts only certain limits -- 60 is rejected
   * outright, 100 is not -- so this is a value the exchange allows rather than
   * the smallest that would serve. 100 candles covers any ATR period worth
   * quoting with room to spare.
   */
  private static readonly CANDLE_LIMIT = 100;
  /**
   * The kline limits the exchange will accept.
   *
   * Not a range: anything between two of these is rejected outright with
   * 'Please double check input arguments', which is what happened the first
   * time the coach's history was deepened and 182 daily candles were asked for.
   * A request over a thousand is silently capped rather than refused, which is
   * the more dangerous of the two failures -- so the snap below is upward into
   * this set and never past its end.
   */
  private static readonly CANDLE_LIMITS = [5, 10, 50, 100, 500, 1000];

  /** The smallest accepted limit that satisfies a wanted depth. */
  private static snapLimit(wanted: number): number {
    return (
      ExchangeClient.CANDLE_LIMITS.find((limit) => limit >= wanted) ??
      ExchangeClient.CANDLE_LIMITS[ExchangeClient.CANDLE_LIMITS.length - 1]
    );
  }
  /** How long to hold a failed volatility read before trying again. */
  private static readonly ATR_RETRY_MS = 30000;
  /**
   * How often adaptive trails are reconsidered.
   *
   * Two things move a managed trail, on very different clocks. The cushion
   * changes only when a candle closes, and ATR is cached until then. The
   * high-water mark changes whenever price makes a new extreme, which can be at
   * any moment -- and since nothing else advances the stop now, noticing that
   * promptly is this loop's job rather than the exchange's.
   *
   * So the pass is frequent and nearly free: cached ATR, a streamed mark, and a
   * cached order list. A request is only sent when the stop should actually
   * move.
   */
  private static readonly TRAIL_CHECK_MS = 10000;
  /** The stop must improve by this fraction of the current trail to be worth amending. */
  private static readonly TRAIL_MIN_IMPROVEMENT = 0.05;
  /** How far a moved stop must stay clear of the mark. */
  private static readonly TRAIL_SAFETY_TICKS = 2;
  /** Consecutive failures before a trail is left alone and reported. */
  private static readonly TRAIL_MAX_FAILURES = 3;
  /** How far back the search for a position's opening fill will go. */
  private static readonly FILL_WALK_PAGES = 8;
  private static readonly FILL_WALK_WINDOW_MS = 24 * 3600 * 1000;
  /**
   * High and low move with every tick, so this is short. It is not shorter
   * because the underlying candles only change on a close, and the current
   * price -- which is what actually moves between closes -- is folded in
   * separately on every read.
   */
  private static readonly RANGE_CACHE_MS = 15000;
  /** The period ATR is quoted at essentially everywhere. */
  private static readonly RANGE_ATR_PERIOD = 14;
  private static readonly CANDLE_CACHE_MIN_MS = 15000;
  /**
   * The longest a candle series is held, whatever its size says.
   *
   * Was five minutes flat, which was defensible when every series was a hundred
   * bars and the coarse ones were only read for ATR. It stopped being
   * defensible when the coach's history went to five hundred daily and weekly
   * bars: a weekly candle cannot change more than once a week, and refetching
   * five hundred of them twelve times an hour spends the rate limit to be told
   * the same thing.
   *
   * The real bound is the next close, and the forming bar is dropped before
   * anything reads the series, so nothing in a held series can change before
   * then. This is the backstop over that, not the rule.
   */
  private static readonly CANDLE_CACHE_MAX_MS = 3600000;

  /** Mark price, index price and funding rate, refreshed at a sensible interval. */
  /**
   * Average true range for a market, in price units.
   *
   * Cached until the next candle closes, because that is exactly how long the
   * answer can stay the same: ATR is computed from closed candles only, so
   * asking again within the same period returns the same number and costs a
   * request for it.
   *
   * A failed read is held far more briefly. The value is undefined either way,
   * but caching "we don't know" for an hour would leave an adaptive trail
   * unadjusted long after the feed recovered.
   */
  /**
   * Candles for a market, in the shape the measurements take.
   *
   * Cached until the next candle of that size closes, because that is exactly
   * when the answer can change. Daily candles change once a day; asking for
   * them every fifteen seconds spends the rate limit to be told the same thing.
   * What actually moves between closes is the current price, and that is read
   * separately and folded in fresh.
   *
   * Expiring on the close rather than on some fraction of it matters. ATR is
   * cached until the same moment, so if these two disagreed the measurement
   * would come due, ask for candles, and be handed a set that did not yet
   * include the bar that had just closed -- a column that updates on the close
   * in principle but lags it by minutes in practice.
   *
   * Clamped at both ends: never longer than a few minutes, so a month of
   * uptime cannot sit on a month-old read, and never shorter than the floor,
   * so an exchange that publishes a candle a moment late is retried rather
   * than polled flat out.
   */
  /** Requests already on the wire, so five callers share one of them. */
  private candleInFlight = new Map<string, Promise<Candle[]>>();
  /** Series that just failed, and when they may be asked for again. */
  private candleFailure = new Map<string, number>();
  /**
   * How long a failed series is left alone.
   *
   * The reason this exists is a feedback loop rather than politeness. A throw
   * never populated the cache, so a series that failed was re-requested by
   * every pass that wanted it -- and once the rate limiter's queue backs up,
   * every candle fetch fails, which means every pass asks again, which fills
   * the queue further. The client talked itself into 'throttle queue is over
   * maxCapacity (1000)' and stayed there.
   */
  private static readonly CANDLE_RETRY_MS = 30_000;

  private async getCandles(
    market: string,
    timeframe: string,
    wanted = ExchangeClient.CANDLE_LIMIT
  ): Promise<Candle[]> {
    // Snapped here as well as at the call sites, so no caller can send a value
    // the exchange refuses.
    const limit = ExchangeClient.snapLimit(wanted);

    // The depth is part of the key. A deep series and a shallow one on the same
    // timeframe are different answers with different costs, and letting a
    // hundred-candle read satisfy a request for six months -- or the reverse,
    // pulling a thousand candles to measure ATR(14) -- would be wrong in one
    // direction or wasteful in the other.
    const key = `${market}|${timeframe}|${limit}`;
    const cached = this.candleCache.get(key);
    if (cached && Date.now() < cached.until) return cached.candles;

    // Recently failed. Whatever is held stands, and nothing goes on the wire.
    const quiet = this.candleFailure.get(key);
    if (quiet !== undefined && Date.now() < quiet) return cached?.candles ?? [];

    // The range panel, the ATR cache and the coach's history all want the same
    // series, and before this they each asked for it. One request, shared.
    const already = this.candleInFlight.get(key);
    if (already) return already;

    const request = this.fetchCandleSeries(market, timeframe, limit, key).finally(() => {
      this.candleInFlight.delete(key);
    });
    this.candleInFlight.set(key, request);
    return request;
  }

  /** The work behind getCandles. Always goes to the exchange. */
  private async fetchCandleSeries(
    market: string,
    timeframe: string,
    limit: number,
    key: string
  ): Promise<Candle[]> {
    let raw: unknown[];
    try {
      raw = await this.exchange!.fetchOHLCV(market, timeframe, undefined, limit);
    } catch (error) {
      this.candleFailure.set(key, Date.now() + ExchangeClient.CANDLE_RETRY_MS);
      throw error;
    }
    this.candleFailure.delete(key);

    const candles = raw.map((row: any) => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    }));

    const intervalMs = this.exchange!.parseTimeframe(timeframe) * 1000;
    const now = Date.now();
    const last = closedCandles(candles, now, intervalMs).pop();

    // The close after the most recent one: nothing here changes before then.
    const nextClose =
      last !== undefined ? last.timestamp + 2 * intervalMs : now;

    // Never longer than one bar of this size: on a fast timeframe the backstop
    // above would otherwise hold a minute candle for an hour.
    const ceiling = Math.min(
      ExchangeClient.CANDLE_CACHE_MAX_MS,
      Math.max(ExchangeClient.CANDLE_CACHE_MIN_MS, intervalMs)
    );

    const until = Math.min(
      now + ceiling,
      Math.max(now + ExchangeClient.CANDLE_CACHE_MIN_MS, nextClose)
    );

    this.candleCache.set(key, { until, candles });
    return candles;
  }

  /**
   * Highest high and lowest low over each reported period.
   *
   * Two candle sizes rather than one: a hundred one-minute candles resolve the
   * short windows to the minute but reach back less than two hours, so the
   * longer ones are measured on fifteen-minute candles instead. Reading every
   * window off a size coarse enough for a day would make the 5m column the last
   * five-minute candle, which is not a five-minute range.
   */
  async getPriceRanges(market: string): Promise<PriceRangeView[]> {
    const cached = this.rangeCache.get(market);
    const fresh = cached && Date.now() - cached.at <= ExchangeClient.RANGE_CACHE_MS;
    if (fresh) return cached!.ranges;

    // Nine candle series, each a request the exchange rate-limits. Awaiting
    // that on the redraw stalled the whole frame -- position, orders and market
    // repaint together -- for as long as it took, every time the cache lapsed.
    //
    // Once there is something to show, showing it wins. Ranges are measured
    // over minutes to a month; a few seconds of staleness is invisible in the
    // numbers and very visible in the redraw.
    // Refreshed in the background whether or not there is anything cached yet,
    // and the caller is answered immediately either way.
    //
    // The first call used to await the computation, which meant the first
    // populated frame of a session waited on nine rate-limited candle requests
    // -- and since the workspace reads price, position, orders and ranges
    // together, everything else waited with it. The panel now shows '--' for a
    // few seconds instead, which is what it has to show anyway, and the values
    // that were ready are on screen while the slow ones arrive.
    if (!this.rangeRefreshInFlight.has(market)) {
      this.rangeRefreshInFlight.add(market);
      void this.computePriceRanges(market)
        .catch(() => undefined)
        .finally(() => this.rangeRefreshInFlight.delete(market));
    }

    return cached?.ranges ?? [];
  }

  /** The work behind getPriceRanges. Always goes to the exchange. */
  private async computePriceRanges(market: string): Promise<PriceRangeView[]> {

    const latest = await this.getReferencePrice(market);

    // Each candle size is fetched once however many windows read from it, and
    // separately, so a failure on one leaves the windows it feeds empty rather
    // than blanking the whole panel.
    const timeframes = Array.from(new Set(RANGE_WINDOWS.map((w) => w.source)));
    const series = new Map<string, Candle[]>();

    await Promise.all(
      timeframes.map(async (timeframe) => {
        try {
          series.set(timeframe, await this.getCandles(market, timeframe));
        } catch (error) {
          console.warn(
            `[ExchangeClient] Could not read ${timeframe} candles for ${market}: ${
              (error as Error).message
            }`
          );
          series.set(timeframe, []);
        }
      })
    );

    const now = Date.now();

    // getAtr rather than a second measurement here: it already reads closed
    // candles only, caches until the next one closes, and shares the candle
    // cache with the fetches above.
    const measured = await Promise.all(
      RANGE_WINDOWS.map(async ({ label, minutes, source, atrTimeframe }) => {
        const range = rangeOver(series.get(source) ?? [], minutes * 60_000, now, latest);
        const atr = await this.getAtr(
          market,
          ExchangeClient.RANGE_ATR_PERIOD,
          atrTimeframe
        ).catch(() => undefined);

        return { label, high: range?.high, low: range?.low, atr };
      })
    );

    // Each window is measured on candles coarse enough to span it, so the wider
    // ones lag: a spike reaches the 1h column when its minute candle closes but
    // the 1d column only when the fifteen-minute one does, and the month --
    // measured on daily candles -- would not show today at all until midnight.
    // The windows nest, so carrying the running extreme outward is simply using
    // the better evidence we already hold about recent time.
    const nested = nestRanges(measured);
    const ranges = measured.map((range, index) => ({
      ...range,
      high: nested[index].high,
      low: nested[index].low,
    }));

    this.rangeCache.set(market, { at: now, ranges });
    return ranges;
  }

  async getAtr(
    market: string,
    period: number,
    timeframe: string
  ): Promise<number | undefined> {
    const key = `${market}|${timeframe}|${period}`;
    const cached = this.atrCache.get(key);
    if (cached && Date.now() < cached.until) return cached.value;

    const intervalMs = this.exchange!.parseTimeframe(timeframe) * 1000;
    let value: number | undefined;
    let until = Date.now() + ExchangeClient.ATR_RETRY_MS;

    try {
      const candles = await this.getCandles(market, timeframe);
      const closed = closedCandles(candles, Date.now(), intervalMs);
      value = averageTrueRange(closed, period);

      const last = closed[closed.length - 1];
      // Constant until the candle following the last closed one has itself
      // closed; there is nothing new to measure before then.
      if (last !== undefined && value !== undefined) {
        until = last.timestamp + 2 * intervalMs;
      }
    } catch (error) {
      console.warn(
        `[ExchangeClient] Could not measure volatility for ${market}: ${
          (error as Error).message
        }`
      );
      value = undefined;
    }

    this.atrCache.set(key, { until, value });
    return value;
  }

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

  /** '8h', '4h', '1h' -- how the interval reads rather than how it is stored. */
  private static intervalLabel(seconds: number): string {
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
  }

  /**
   * What the next funding payment costs, or pays, on the position as it stands.
   *
   * The rate is the honest figure and the annualised one says whether it
   * matters over time, but neither answers the question actually being asked,
   * which is how much money moves at the next payment. A hundredth of a percent
   * sounds like nothing until it is read against a six-figure notional.
   *
   * Signed from the operator's side: negative is paid out, positive is
   * received. A positive rate means longs pay shorts, so a long notional
   * against a positive rate is a cost -- which is why the notional arrives
   * signed rather than as a size.
   *
   * Linear contracts only. An inverse contract settles in the base asset and
   * the arithmetic is a different one; returning the linear answer for it would
   * be a confident wrong number rather than a missing one.
   */
  fundingCost(
    market: string,
    signedNotional: number | undefined
  ): { amount: number; daily: number; currency: string; interval: string } | undefined {
    if (signedNotional === undefined || !Number.isFinite(signedNotional)) return undefined;
    if (signedNotional === 0) return undefined;

    const info = this.availableMarkets?.[market];
    if ((info as any)?.inverse === true) return undefined;

    const rate = this.fundingCache.get(market)?.funding;
    if (rate === undefined || !Number.isFinite(rate)) return undefined;

    const seconds = this.fundingIntervalSeconds(market);
    if (seconds === undefined) return undefined;

    // Negated so the sign reads from the operator's side rather than the
    // market's: what they pay is money leaving.
    const amount = -(signedNotional * rate);

    return {
      amount,
      // A day's worth, which is the figure worth reading. One payment of nine
      // dollars sounds like a rounding error; the same position costing
      // twenty-nine a day is a number that can be weighed against the trade.
      //
      // Scaled from the current rate, which assumes it holds across the day's
      // remaining payments. It will not exactly -- the rate is re-struck each
      // interval -- but it is the same assumption the annualised figure beside
      // it already makes, and the alternative is a number nobody can act on.
      daily: amount * (86400 / seconds),
      currency: String(info?.settle ?? info?.quote ?? ''),
      interval: ExchangeClient.intervalLabel(seconds),
    };
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
  /**
   * Wallet balance and account equity, cached together.
   *
   * Balance is what the exchange holds; equity is that plus what every open
   * position is currently up or down. They differ by exactly the unrealized
   * amount, which is the number that decides whether the account can take
   * another position -- so both are worth showing rather than one.
   *
   * Unrealized is summed across all positions, not just the market on screen:
   * equity is an account-level figure and counting only the visible position
   * would overstate it whenever anything else is open.
   */
  private async getAccountSummary(currency: string): Promise<{
    balance?: number;
    equity?: number;
  }> {
    const cached = this.equityCache;
    const fresh =
      cached &&
      cached.currency === currency &&
      Date.now() - cached.at <= ExchangeClient.EQUITY_CACHE_MS;

    if (fresh) return { balance: cached!.balance, equity: cached!.equity };

    // A balance read and a positions read, both rate-limited. Same reasoning as
    // the ranges: once there is a figure to show, showing it beats holding the
    // frame for a fresher one.
    if (cached && cached.currency === currency) {
      if (!this.equityRefreshInFlight) {
        this.equityRefreshInFlight = true;
        void this.computeAccountSummary(currency)
          .catch(() => undefined)
          .finally(() => {
            this.equityRefreshInFlight = false;
          });
      }
      return { balance: cached.balance, equity: cached.equity };
    }

    return this.computeAccountSummary(currency);
  }

  /** The work behind getAccountSummary. Always goes to the exchange. */
  private async computeAccountSummary(currency: string): Promise<{
    balance?: number;
    equity?: number;
  }> {

    let balance: number | undefined;
    let equity: number | undefined;

    try {
      const snapshot: any = await this.fetchAccountSnapshot(currency);
      const total = snapshot?.total?.[currency];
      balance = Number.isFinite(Number(total)) ? Number(total) : undefined;
    } catch {
      balance = undefined;
    }

    if (balance !== undefined) {
      try {
        const positions = await this.exchange!.fetchPositions(undefined, {
          type: 'swap',
          code: currency,
        });

        const open = positions.filter(
          (position) => Math.abs(Number((position as any).contracts ?? 0)) > 0
        );

        let unrealized = 0;
        let complete = true;

        for (const position of open) {
          const symbol = String((position as any).symbol ?? '');
          const value = this.unrealizedPnlOf(position, symbol);

          // One position we cannot price makes the total wrong by an unknown
          // amount, and an equity figure that is quietly short is worse than
          // no equity figure at all -- it reads as a real number.
          if (value === undefined || !Number.isFinite(value)) {
            complete = false;
            break;
          }

          unrealized += value;
        }

        equity = complete ? balance + unrealized : undefined;
      } catch {
        // Without positions there is no honest equity figure; balance stands
        // on its own rather than being presented as equity.
        equity = undefined;
      }
    }

    // The peak this session is measured from these samples, so one is recorded
    // whenever a real figure is available. An incomplete equity is deliberately
    // not journalled: a peak set by a number that was quietly short would make
    // every later give-back reading wrong.
    if (equity !== undefined) this.guard.recordEquity(equity, currency);

    this.equityCache = { at: Date.now(), currency, balance, equity };
    return { balance, equity };
  }

  private async getAccountBalance(currency: string): Promise<number | undefined> {
    return (await this.getAccountSummary(currency)).balance;
  }

  /** Wallet balance and equity for display. */
  async getAccountFunds(market: string): Promise<{
    balance?: number;
    equity?: number;
    currency: string;
  }> {
    const info = this.availableMarkets?.[market];
    const currency = String(info?.settle ?? info?.quote ?? 'USDT');
    const { balance, equity } = await this.getAccountSummary(currency);
    return { balance, equity, currency };
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

    // Top of book from the streamed ticker, which already carries it. This was
    // fetchL2OrderBook on every redraw -- a rate-limited request every two
    // seconds for two numbers arriving on a socket we were already holding
    // open. The fetch remains as a fallback for the first tick and for a feed
    // that has gone quiet.
    const streamed = this.tickerStreams.get(market);
    let bid = streamed?.bid;
    let ask = streamed?.ask;

    if (bid === undefined || ask === undefined) {
      try {
        const book = await this.exchange!.fetchL2OrderBook(market, 1);
        bid = book.bids?.[0]?.[0];
        ask = book.asks?.[0]?.[0];
      } catch {
        // Book unavailable this tick; the rest of the view is still worth showing.
      }
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
    if (!this.exchange?.has?.['watchTicker']) return;
    if (this.tickerStreams.get(market)?.running) return;

    const state = {
      price: undefined as number | undefined,
      bid: undefined as number | undefined,
      ask: undefined as number | undefined,
      at: 0,
      running: true,
    };
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

          // Top of book arrives on the same message, and saves a request for it
          // on every redraw.
          const bid = Number(ticker.bid);
          const ask = Number(ticker.ask);
          if (Number.isFinite(bid) && bid > 0) state.bid = bid;
          if (Number.isFinite(ask) && ask > 0) state.ask = ask;
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
  /**
   * How long the cached order list may go without being checked against the
   * exchange's own list. The feed reports changes rather than the whole set, so
   * anything it fails to report persists until something asks outright.
   */
  private static readonly ORDER_RESYNC_MS = 20000;


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
    if (!this.exchange?.has?.['watchOrders']) return;
    if (this.orderStreams.get(market)?.running) return;

    const state = {
      orders: new Map<string, Order>(),
      filledSoFar: new Map<string, number>(),
      finished: new Map<string, OrderOutcome>(),
      running: true,
      healthy: false,
      syncedAt: 0,
      snapshotAt: 0,
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
        state.snapshotAt = Date.now();
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
            const disposition = classifyOrderStatus(status);

            // Report what the exchange says happened, before updating the view.
            this.announceOrderUpdate(market, update, state);

            // An order is shown as working only on a status that says so.
            // Treating anything unrecognised as "still open" is what left a
            // cancelled chase order on screen for a whole session: the replace
            // emitted an update this did not match, so the order was neither
            // removed nor questioned. When the status means nothing to us the
            // cache is left alone and the next snapshot decides.
            if (disposition === 'unknown') continue;

            if (disposition === 'finished') {
              const average = Number(update.average ?? update.price ?? NaN);
              state.finished.set(update.id, {
                status,
                filled: Number(update.filled ?? 0),
                average: Number.isFinite(average) ? average : undefined,
                at: Date.now(),
              });

              // Bounded: this is a short memory for orders just closed, not a
              // history of the account.
              if (state.finished.size > 200) {
                const oldest = state.finished.keys().next().value;
                if (oldest !== undefined) state.finished.delete(oldest);
              }

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
      // The guardrails' whole memory is built from this: only the *new* part of
      // a partial fill is journalled, or a working order that reports its
      // running total on every update would be counted several times over and
      // the session would look far larger than it was.
      this.guard.recordFill({
        market,
        side: String(update.side ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
        size: filled - previouslyFilled,
        price: Number(rawPrice ?? 0),
        at: eventTime,
        contractSize: (this.availableMarkets?.[market] as any)?.contractSize ?? 1,
        inverse: (this.availableMarkets?.[market] as any)?.inverse === true,
        // What this fill is, as opposed to what it looked like from here. The
        // `filledSoFar` map below is per-stream, so a reconnect starts a fresh
        // one and replays fills it has already reported; naming them lets the
        // journal recognise the ones it has already counted.
        orderId: id,
        filledTotal: filled,
      });

      state.filledSoFar.set(id, filled);
      this.invalidatePosition(market);

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
      this.guard.recordOrderCancelled(market, id);
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
    const now = Date.now();
    const fresh =
      state?.healthy === true &&
      now - state.syncedAt <= ExchangeClient.ORDER_CACHE_MAX_AGE_MS &&
      // Feed activity alone is not evidence the cache is right: syncedAt moves
      // on every event about any order, so a chatty feed kept the cache
      // permanently "fresh" and the exchange was never asked again.
      now - state.snapshotAt <= ExchangeClient.ORDER_RESYNC_MS;

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

    const existing = this.orderStreams.get(market);
    if (existing) this.reconcileOrderCache(existing, orders, params);

    return orders;
  }

  /**
   * Puts an order this process has just placed into the cached list.
   *
   * Only orders that are actually working: a market order that filled on the
   * way in is not an open order, and adding it would put a phantom in the panel
   * -- the mirror image of the bug this exists to prevent.
   */
  private rememberPlacedOrder(market: string, order: any): void {
    const state = this.orderStreams.get(market);
    if (!state || !order?.id) return;

    const disposition = classifyOrderStatus(order.status);
    if (disposition === 'finished') return;

    // An unknown status from a placement response is treated as working: the
    // exchange has just accepted the order, so the one thing we do know is that
    // it existed a moment ago. The next reconciliation corrects it if not.
    this.guard.recordOrderPlaced(market, String(order.id));

    state.orders.set(String(order.id), order as Order);
    if (!state.filledSoFar.has(String(order.id))) {
      state.filledSoFar.set(String(order.id), Number(order.filled ?? 0));
    }
  }

  /**
   * Drops orders this process has just cancelled from the cached list.
   *
   * The cache is refreshed against the exchange periodically, which is right
   * for drift nobody caused. A cancellation is not drift: we know the order is
   * gone the moment the exchange accepts it, and continuing to show it is worse
   * here than anywhere else -- a cancelled stop on screen reads as protection
   * that no longer exists.
   *
   * The next read is also forced to go to the exchange, so anything else the
   * cancellation changed is picked up rather than waiting out the interval.
   */
  private forgetCancelledOrders(market: string, ids: Array<string | undefined>): void {
    const state = this.orderStreams.get(market);
    if (!state) return;

    for (const id of ids) {
      if (id === undefined) continue;
      state.orders.delete(String(id));
      state.filledSoFar.delete(String(id));
    }

    state.snapshotAt = 0;
  }

  /**
   * Makes the cached order list agree with the exchange's.
   *
   * The feed reports changes, not the whole set, so anything it fails to report
   * -- a cancellation carrying a status we don't recognise, an event missed
   * while reconnecting -- leaves an order on screen the exchange has no record
   * of. Taking the exchange's own list as the truth every so often bounds how
   * long any such drift can last, whatever caused it.
   *
   * A filtered fetch may only remove orders it could have returned. Reconciling
   * the whole cache against, say, an untriggered-only query would delete every
   * ordinary limit order in it.
   */
  private reconcileOrderCache(
    state: {
      orders: Map<string, Order>;
      filledSoFar: Map<string, number>;
      snapshotAt: number;
      syncedAt: number;
    },
    orders: Order[],
    params?: Record<string, any>
  ): void {
    const live = new Set<string>();

    for (const order of orders) {
      if (!order.id) continue;
      live.add(order.id);
      state.orders.set(order.id, order);
      // Only for orders we haven't been tracking, so an in-flight fill isn't
      // re-announced from a snapshot that happens to include it.
      if (!state.filledSoFar.has(order.id)) {
        state.filledSoFar.set(order.id, Number(order.filled ?? 0));
      }
    }

    const authoritative = params === undefined || Object.keys(params).length === 0;
    for (const id of staleOrderIds(state.orders.keys(), live, authoritative)) {
      state.orders.delete(id);
      state.filledSoFar.delete(id);
    }
    if (authoritative) state.snapshotAt = Date.now();

    state.syncedAt = Date.now();
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

      // Into the cached list immediately. The exchange has accepted it, so it
      // exists; waiting for the next reconciliation to discover that left a new
      // order missing from the panel for up to twenty seconds. The same
      // reasoning as forgetting a cancelled one, in the other direction.
      this.rememberPlacedOrder(market, order);

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

        // Stops announce themselves, and with better wording -- 'STOP WORKING'
        // rather than a bare 'STOP'. Announcing here too gave one order two rows.
        if (trigger !== undefined) {
          return order;
        }

        const at =
          trigger !== undefined
            ? ` triggering at ${trigger}`
            : order?.price
            ? ` @${order.price}`
            : '';

        NotificationManager.notify('', NType.INFO, 'ORDER', undefined, {
          side: order?.side ? String(order.side).toUpperCase() : undefined,
          quantity: this.formatQuantity(Number(order?.amount)),
          price:
            trigger !== undefined
              ? this.formatPriceForDisplay(market, Number(trigger))
              : order?.price
              ? this.formatPriceForDisplay(market, Number(order.price))
              : undefined,
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

  /** Position reads on the wire, so simultaneous callers share one. */
  private positionInFlight = new Map<string, Promise<Position | undefined>>();
  private positionCache = new Map<string, { at: number; position: Position | undefined }>();
  /**
   * How long a position read is reused.
   *
   * Short enough that nothing on screen is visibly behind -- the panel repaints
   * every two seconds and this is under one -- and long enough that the several
   * things which each want the position during a single pass ask for it once.
   * The workspace reads it directly and then reads it again inside the risk
   * calculation, and the guard's market block wants it too, so one pass was
   * three requests for one answer on the endpoint that was failing.
   */
  private static readonly POSITION_CACHE_MS = 900;

  /**
   * Drops the held position for a market.
   *
   * Called the moment a fill is seen. Under a second of staleness is invisible
   * on a panel that repaints every two, but it is not invisible immediately
   * after a fill -- that is exactly when the size on screen is being checked
   * against what was just done, and showing the previous size for even half a
   * second there is the one moment it would be believed.
   */
  private invalidatePosition(market: string): void {
    this.positionCache.delete(market);
  }

  async getPositionStructure(symbol: string): Promise<Position | undefined> {
    const cached = this.positionCache.get(symbol);
    if (cached && Date.now() - cached.at < ExchangeClient.POSITION_CACHE_MS) {
      return cached.position;
    }

    const already = this.positionInFlight.get(symbol);
    if (already) return already;

    const request = this.readPositionStructure(symbol)
      .then((position) => {
        this.positionCache.set(symbol, { at: Date.now(), position });
        return position;
      })
      .finally(() => this.positionInFlight.delete(symbol));

    this.positionInFlight.set(symbol, request);
    return request;
  }

  private async readPositionStructure(symbol: string): Promise<Position | undefined> {
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
        this.exchange!
          .cancelOrder(order.id, market, isHyperliquid ? hyperliquidParams : undefined)
          .then((result) => {
            this.forgetCancelledOrders(market, [order.id]);
            return result;
          })
      );
      await Promise.all(cancelPromises);
      console.log(`${ordersToCancel.length} limit orders have been canceled.`);
    } else {
      console.log('No matching limit orders found to cancel.');
    }
  }

  /**
   * Any order resting until a trigger price is reached.
   *
   * Detected by carrying a trigger price rather than by an order-type string.
   * ccxt leaves Phemex's 'Stop' unmapped, so order.type is 'Stop' and a test for
   * 'stop' matches nothing -- which is how 'cancel stops' came to cancel nothing
   * while reporting success.
   */
  private isTriggerOrder(order: Order): boolean {
    const info = (order as any).info ?? {};
    const trigger = Number(
      (order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp ?? 0
    );
    if (trigger > 0) return true;

    const type = String(
      info.ordType ?? info.orderType ?? order.type ?? ''
    ).toLowerCase();

    return type.includes('stop') || type.includes('trigger') || info.isTrigger === true;
  }

  /**
   * Cancels everything, and waits for it.
   *
   * Both calls were previously left unawaited, so this returned before anything
   * had been cancelled and the caller reported success on work that had not
   * happened -- or had failed.
   */
  async cancelAllOrders(symbol: string): Promise<CancelResult> {
    const [stops, limits] = await Promise.all([
      this.cancelAllStopOrders(symbol),
      this.cancelAllLimitOrders(symbol),
    ]);

    return {
      cancelled: stops.cancelled + limits.cancelled,
      failed: stops.failed + limits.failed,
    };
  }

  async cancelAllLimitOrders(symbol: string): Promise<CancelResult> {
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
        return order.type === 'limit' && !this.isTriggerOrder(order);
      });

      if (limitOrders.length === 0) return { cancelled: 0, failed: 0 };

      const results = await Promise.allSettled(
        limitOrders.map((order) =>
          // The wallet parameter was omitted here while the fetch above used it.
          this.exchange!
            .cancelOrder(order.id, symbol, walletAddress ? { user: walletAddress } : undefined)
            .then((result) => {
              this.forgetCancelledOrders(symbol, [order.id]);
              return result;
            })
        )
      );

      const failed = results.filter((r) => r.status === 'rejected').length;
      for (const result of results) {
        if (result.status === 'rejected') {
          NotificationManager.diagnostic(
            `[cancelAllLimitOrders] ${describeExchangeError(result.reason).raw}`
          );
        }
      }

      return { cancelled: results.length - failed, failed };
    } catch (error) {
      const failure = describeExchangeError(error);
      NotificationManager.diagnostic(`[cancelAllLimitOrders] ${failure.raw}`);
      NotificationManager.notify(`Limit orders NOT cancelled: ${failure.summary}`, NType.ERROR, 'ERROR');
      return { cancelled: 0, failed: 0 };
    }
  }

  async cancelAllStopOrders(symbol: string): Promise<CancelResult> {
    try {
      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // For Hyperliquid, we need to use the public wallet address to fetch orders
      const params = walletAddress ? { 'user': walletAddress } : undefined;

      // Fetch open orders with wallet address for Hyperliquid
      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined, params);

      const stopOrders = openOrders.filter((order) => this.isTriggerOrder(order));

      if (stopOrders.length === 0) return { cancelled: 0, failed: 0 };

      // Settled rather than all: one refusal should not discard the outcome of
      // the others, and the caller needs to know how many actually went.
      const results = await Promise.allSettled(
        stopOrders.map((order) => this.exchange!.cancelOrder(order.id, symbol, params))
      );

      const cancelled = stopOrders.filter(
        (_, index) => results[index].status === 'fulfilled'
      );

      this.forgetCancelledOrders(
        symbol,
        cancelled.map((order) => order.id)
      );

      // Only the ones that actually went. A refused cancel left the stop in
      // place, and recording it as pulled would have the guard reporting
      // protection that was never removed.
      void this.noteStopsCancelled(
        symbol,
        cancelled.map((order) =>
          Number((order as any).triggerPrice ?? (order as any).info?.stopPxRp ?? order.stopPrice ?? 0)
        )
      );

      const failed = results.filter((r) => r.status === 'rejected').length;
      for (const result of results) {
        if (result.status === 'rejected') {
          NotificationManager.diagnostic(
            `[cancelAllStopOrders] ${describeExchangeError(result.reason).raw}`
          );
        }
      }

      return { cancelled: results.length - failed, failed };
    } catch (error) {
      const failure = describeExchangeError(error);
      NotificationManager.diagnostic(`[cancelAllStopOrders] ${failure.raw}`);
      NotificationManager.notify(`Stop orders NOT cancelled: ${failure.summary}`, NType.ERROR, 'ERROR');
      return { cancelled: 0, failed: 0 };
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
      this.forgetCancelledOrders(market, [targetId]);
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

  /** When the running chase expires, if it was given a decay. */
  getChaseDeadline(): number | undefined {
    return this.chaseLimitOrderActive ? this.chaseDeadline : undefined;
  }

  /** The order the chase is currently working, if one is running. */
  getCurrentChaseOrderId(): string | undefined {
    return this.chaseLimitOrderActive ? this.currentChaseOrderId : undefined;
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
          const result = await this.getOrderOutcome(market, orderId);

          const outcome =
            result === undefined
              ? undefined
              : result.status === 'closed' || result.filled >= amount
              ? `filled for ${result.filled || amount}`
              : result.status === 'canceled' || result.status === 'rejected'
              ? result.filled > 0
                ? `${result.status} after filling ${result.filled} of ${amount}`
                : `${result.status} without filling`
              : result.filled > 0
              ? `ended with ${result.filled} of ${amount} filled`
              : undefined;

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
      Boolean(this.exchange.has?.['watchOrderBook']) &&
      Boolean(this.exchange.has?.['watchOrders']);

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
      // Recorded so the interface can count it down. Read through
      // getChaseDeadline, which returns nothing once the chase has ended, so a
      // finished chase can't leave a countdown running on screen.
      this.chaseDeadline = Date.now() + decayTime;

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
    const outcome = await this.getOrderOutcome(market, orderId);
    const filled = outcome?.filled;
    const price = outcome?.average;

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
        ? // Never assert it didn't fill on a lookup that never answered.
          'Chase ended — the exchange has not reported the outcome yet. Check your position.'
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
    enforceFatFinger: boolean = true,
    /** Absolute price distance the exchange should trail the stop by. */
    trailOffset?: number,
    clientOrderId?: string,
    triggerOnMark = false
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

          // A trail managed from here is an ordinary stop as far as the
          // exchange is concerned -- no peg, we move it ourselves -- but it
          // still follows the mark, because a wick on this venue should not
          // ratchet it up behind a price nobody else saw.
          if (triggerOnMark) {
            params.triggerType = 'ByMarkPrice';
            if (clientOrderId) params.clOrdID = clientOrderId;
          }

          if (trailOffset !== undefined && trailOffset > 0) {
            // A trail follows the price, so the price it follows matters more
            // than for a fixed stop. Last price is what a wick moves: a spike
            // on this venue ratchets the trail up behind it, and when price
            // comes back the stop is left sitting near the market and takes the
            // position out on a move that never really happened.
            //
            // Mark price is derived from the index, so a wick that doesn't move
            // the wider market barely moves it. Costs nothing and keeps working
            // while disconnected, which monitoring cannot.
            params.triggerType = 'ByMarkPrice';

            // The exchange maintains the trail from here, so it keeps working
            // whether or not this process does.
            //
            // Sign follows the position: negative closing a long, positive
            // closing a short. And the trigger price above is what makes this a
            // Stop -- a peg sent without one becomes a plain market order and
            // closes the position immediately, which is not a failure anyone
            // would want to discover live.
            params.pegOffsetValueRp =
              side === 'sell' ? -Math.abs(trailOffset) : Math.abs(trailOffset);
            params.pegPriceType = 'TrailingStopPeg';

            // Carries the trail's terms on the order itself, so a restart can
            // find it again and keep adapting it.
            if (clientOrderId) params.clOrdID = clientOrderId;
          }
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

  /**
   * A stop the exchange trails behind the best price.
   *
   * The distance is fixed once and maintained by Phemex, which is the whole
   * point: a trail that this process maintained would stop trailing the moment
   * it died, leaving a stop frozen wherever it happened to be while looking
   * like it was still working.
   *
   * `percent` treats the value as a percentage of the current price rather than
   * an absolute distance.
   */
  /**
   * What a trail spec works out to right now, in price units.
   *
   * The one place a spec becomes a distance. Placement and any later adjustment
   * both come through here, so an adaptive trail cannot end up being sized one
   * way when it is placed and another way when it is revised.
   */
  async resolveTrailDistance(
    market: string,
    spec: TrailSpec,
    reference: number
  ): Promise<number | undefined> {
    switch (spec.kind) {
      case 'absolute':
        return spec.distance;

      case 'percent':
        return (reference * spec.percent) / 100;

      case 'atr': {
        const atr = await this.getAtr(market, spec.period, spec.timeframe);
        // A trail finer than the tick cannot be expressed as a price, so the
        // tick is the floor whatever a very quiet market measures.
        const tick = await this.getMarketPrecision(market).catch(() => 0);
        return atrTrailOffset(atr, {
          multiple: spec.multiple,
          minimumOffset: tick > 0 ? tick : undefined,
        });
      }
    }
  }

  /**
   * Starts reconsidering adaptive trails, if it is not already running.
   *
   * One timer covers every trail rather than one per order: the work is a map
   * lookup in the common case, and a second timer per order would multiply the
   * ways this can be left running after the order it watched is gone.
   */

  // ==========================================================================
  // Behavioural guardrails
  //
  // The rules themselves are in src/guard and know nothing about exchanges.
  // This section is only the plumbing: it hands the guard what it needs to
  // measure, and carries out what it decides.
  // ==========================================================================

  /** How often open positions and the session are reconsidered. */
  private static readonly GUARD_SWEEP_MS = 30_000;

  getGuard(): GuardService {
    return this.guard;
  }

  /**
   * How much history of each size the coach is shown.
   *
   * The ladder runs from the last hour to the last few years, because the
   * questions being asked run that far: where to put a stop is a question about
   * the last few bars, whether to hold over a weekend is a question about the
   * last few months, and 'is this level still the level' is a question about
   * where price has spent its time since it was.
   *
   * It used to be four sizes and a hundred and eight bars in total, which was
   * chosen to cost nothing -- those were the sizes the range panel already had
   * in cache. That reasoning survives for the fine end and not the coarse: a
   * hundred daily candles is three months, and a position held through a
   * quarter is one the coach can only see the end of.
   *
   * So the coarse sizes are fetched to their own depth, on their own schedule,
   * in the background. A daily candle changes once a day; a weekly one once a
   * week. Nothing here is ever read on the path of a coach call.
   */
  private static readonly COACH_SERIES: Array<{ timeframe: string; count: number }> = [
    { timeframe: '1m', count: 60 }, //  1 hour, to the minute
    { timeframe: '5m', count: 72 }, //  6 hours
    { timeframe: '15m', count: 96 }, // 1 day
    { timeframe: '1h', count: 96 }, //  4 days
    { timeframe: '4h', count: 120 }, // 20 days
    { timeframe: '1d', count: 180 }, // 6 months
    { timeframe: '1w', count: 104 }, // 2 years
    { timeframe: '1M', count: 48 }, //  4 years
  ];

  /**
   * How deep each of those has to be fetched, given the bar still forming and
   * the limits the exchange is willing to be asked for.
   */
  private static coachDepth(count: number): number {
    return ExchangeClient.snapLimit(count + 2);
  }

  /**
   * Keeps the coach's candle history warm.
   *
   * Called from the sweep, never from a coach call. Each size is refreshed only
   * when its own cache has lapsed, which for the coarse ones is roughly when a
   * bar of that size closes -- so the weekly series is read about once a week,
   * and the cost of the whole ladder amortises to almost nothing.
   */
  private coachWarmRunning = false;
  private coachWarmAt = 0;
  /**
   * How often the ladder is walked at all.
   *
   * Each series refuses to refetch until a bar of its own size has closed, so
   * walking the ladder is usually free -- but 'usually' was doing the work.
   * There was no guard against a second walk starting while the first was still
   * going, and none against walking it again thirty seconds later, so a slow
   * exchange turned one pass into several overlapping ones. A minute is more
   * often than any series here can change.
   */
  private static readonly COACH_WARM_MS = 60_000;

  async warmCoachCandles(market?: string): Promise<void> {
    const symbol = market ?? this.lastFollowedMarket;
    if (!symbol || !this.exchange) return;

    // One walk at a time, and not again straight away. Both matter: the first
    // stops passes overlapping when the exchange is slow, the second stops the
    // sweep asking every thirty seconds for series that change hourly.
    if (this.coachWarmRunning) return;
    if (Date.now() - this.coachWarmAt < ExchangeClient.COACH_WARM_MS) return;

    this.coachWarmRunning = true;
    try {
      for (const { timeframe, count } of ExchangeClient.COACH_SERIES) {
        await this.getCandles(symbol, timeframe, ExchangeClient.coachDepth(count)).catch(
          () => undefined
        );
      }
    } finally {
      this.coachWarmRunning = false;
      this.coachWarmAt = Date.now();
    }
  }

  /**
   * What the coach is shown of the market.
   *
   * Built from what is already held rather than by fetching: the candle cache
   * is read but never filled here, and the range panel's cache is used as it
   * stands. A coach call must not put nine candle requests on the wire, and it
   * certainly must not do so behind a confirmation panel that is waiting on it.
   *
   * Position and price are read live, because they are the two things that are
   * worthless stale and both are cheap -- the ticker is streamed and the
   * position is one call the panel is already making every couple of seconds.
   */
  async getMarketContext(market?: string): Promise<MarketContext | undefined> {
    const symbol = market ?? this.lastFollowedMarket;
    if (!symbol || !this.exchange) return undefined;

    const info: any = this.availableMarkets?.[symbol] ?? {};

    const [price, position, risk, orders] = await Promise.all([
      this.getDisplayPrice(symbol).catch(() => ({}) as Awaited<
        ReturnType<ExchangeClient['getDisplayPrice']>
      >),
      this.getPositionView(symbol).catch(() => null),
      this.getPositionRisk(symbol).catch(() => undefined),
      this.getOpenOrdersForDisplay(symbol).catch(() => []),
    ]);

    // Cached only. An empty panel is better than a coach that rate-limits the
    // client it lives inside.
    const ranges = this.rangeCache.get(symbol)?.ranges ?? [];

    const series: MarketSeries[] = [];
    for (const { timeframe, count } of ExchangeClient.COACH_SERIES) {
      const cached = this.candleCache.get(
        `${symbol}|${timeframe}|${ExchangeClient.coachDepth(count)}`
      )?.candles;
      if (!cached || cached.length === 0) continue;

      // The bar still forming is dropped: its high, low and close are all
      // provisional, and a coach reading it as a closed bar is reading a bar
      // that has not happened yet.
      const intervalMs = this.exchange.parseTimeframe(timeframe) * 1000;
      const closed = closedCandles(cached, Date.now(), intervalMs);

      series.push({
        timeframe,
        candles: closed.slice(-count).map((candle) => ({
          at: candle.timestamp,
          open: candle.open ?? candle.close,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      });
    }

    const spread =
      price.bid !== undefined && price.ask !== undefined ? price.ask - price.bid : undefined;

    return {
      market: symbol,
      at: Date.now(),
      base: info.base,
      quote: info.quote,
      last: price.last,
      bid: price.bid,
      ask: price.ask,
      mark: price.mark,
      index: price.index,
      spread,
      funding: price.funding,
      ranges: ranges.map(({ label, high, low, atr }) => ({ label, high, low, atr })),
      position: position
        ? {
            side: position.side,
            size: position.size,
            entry: position.entry,
            mark: position.mark,
            unrealizedPnl: position.unrealizedPnl,
            leverage: position.leverage,
            effectiveLeverage: position.effectiveLeverage,
            liquidation: position.liquidation,
            plannedRisk: risk?.totalRisk,
            coverage: risk?.coveragePercentage,
            ...(() => {
              const cost = this.fundingCost(
                symbol,
                position.notional === undefined
                  ? undefined
                  : position.side === 'SHORT'
                    ? -position.notional
                    : position.notional
              );
              return cost
                ? {
                    fundingCost: cost.amount,
                    fundingDaily: cost.daily,
                    fundingInterval: cost.interval,
                  }
                : {};
            })(),
            currency: position.currency,
          }
        : undefined,
      // Read once, by the same function the panel uses. The coach and the
      // screen therefore cannot disagree about what is protecting the position.
      orders: describeOrders(orders, {
        isTrailArmed: (id) => this.isTrailArmed(id),
        chaseOrderId: this.getCurrentChaseOrderId(),
      }),
      series,
    };
  }

  async loadGuardPolicy(): Promise<void> {
    try {
      const stored = await this.exchangeManager.getGuardPolicy();
      this.guard.setPolicy(resolvePolicy(stored));
      // Read here rather than at construction because the coach's key lives in
      // the same file as the thresholds, and this is the one place that file is
      // opened on the way into a session. A key entered on the home menu is
      // therefore live on the next 'Start Trading' without restarting.
      this.guard.setApiKey(await this.exchangeManager.getAnthropicKey());
      this.guard.load();
    } catch {
      // Defaults stand. A profile that cannot be read must not leave the
      // application without guardrails *and* without saying so, so this is a
      // warning rather than silence.
      NotificationManager.diagnostic(
        '[ExchangeClient] Could not read guardrail settings; defaults are in use.'
      );
      this.guard.load();
    }
  }

  async saveGuardPolicy(policy: GuardPolicy): Promise<void> {
    this.guard.setPolicy(policy);
    await this.exchangeManager.setGuardPolicy(policy);
  }

  /**
   * The position as the guard needs to see it.
   *
   * `openedAt` comes from this session's own journal rather than from the
   * exchange. That is deliberate: a position opened before Tame started has no
   * known age here, and `noStop` treats an unknown age as 'say nothing' -- which
   * is far better than flagging every pre-existing position the moment the
   * application connects.
   */
  private async positionContextFor(market: string): Promise<PositionContext | undefined> {
    const position = await this.getPositionView(market).catch(() => null);
    if (!position || !(position.size > 0) || position.entry === undefined) return undefined;

    const side = position.side.toLowerCase() === 'long' ? 'long' : 'short';
    const risk = await this.getPositionRisk(market).catch(() => undefined);
    const mark = await this.getMarkPriceForTrail(market).catch(() => undefined);

    const info: any = this.availableMarkets?.[market] ?? {};
    const contractSize = Number(info.contractSize ?? 1);
    const notional =
      info.inverse === true
        ? position.size * contractSize
        : mark !== undefined
          ? position.size * contractSize * mark
          : undefined;

    const journalled = this.guard
      .snapshot()
      .openPositions.find((open) => open.market === market);

    return {
      market,
      side,
      size: position.size,
      entryPrice: position.entry,
      markPrice: mark,
      unrealizedPnl: position.unrealizedPnl,
      notional,
      hasProtectiveStop: (risk?.protectedQuantity ?? 0) > 0,
      plannedRisk: risk?.totalRisk,
      openedAt: journalled?.openedAt,
    };
  }

  /**
   * What the guard makes of an order that has not been sent.
   *
   * Called by the command layer, which owns the confirmation prompt. A verdict
   * of 'allow' with findings attached is the ordinary case for a notice: the
   * order goes, and the observation is logged alongside it.
   */
  async reviewProposal(proposal: OrderProposal): Promise<GuardVerdict> {
    const position = await this.positionContextFor(proposal.market).catch(() => undefined);
    const summary = await this.equityFor(proposal.market);

    return this.guard.review({
      proposal,
      position,
      priceMove: await this.recentMoveFor(proposal.market).catch(() => undefined),
      equity: summary?.equity,
      currency: this.availableMarkets?.[proposal.market]?.quote,
    });
  }

  /**
   * Equity in the currency this market settles in.
   *
   * The percentage checks -- risk per trade, leverage -- divide by this, so
   * taking equity in the wrong currency would not fail, it would silently
   * produce a number off by the exchange rate. Undefined when the settle
   * currency is unknown, which the detectors treat as 'no claim'.
   */
  private async equityFor(market: string): Promise<{ equity?: number } | undefined> {
    const settle = (this.availableMarkets?.[market] as any)?.settle;
    if (!settle) return undefined;
    return this.getAccountSummary(String(settle)).catch(() => undefined);
  }

  /**
   * Percentage move over the chase window, from candles already being cached.
   *
   * Returns undefined rather than zero when it cannot be worked out. Zero is a
   * claim that the market has not moved, which would be a lie that happens to
   * silence the detector.
   */
  private async recentMoveFor(market: string): Promise<
    { percent: number; overMs: number } | undefined
  > {
    const windowMs = this.guard.getPolicy().chaseWindowMs;

    try {
      const candles = await this.getCandles(market, '1m');
      if (!candles || candles.length < 2) return undefined;

      // One bar more than the window: the move is measured from the close
      // *before* the window opened, not from the close of its first bar, which
      // would silently discard that bar's own movement.
      const bars = Math.max(2, Math.round(windowMs / 60_000));
      const slice = candles.slice(-(bars + 1));
      const base = Number(slice[0]?.close);
      const latest = Number(slice[slice.length - 1]?.close);
      if (!(base > 0) || !(latest > 0)) return undefined;

      return {
        percent: ((latest - base) / base) * 100,
        overMs: (slice.length - 1) * 60_000,
      };
    } catch {
      return undefined;
    }
  }

  startGuardSweep(): void {
    if (this.guardSweepTimer) return;

    this.guardSweepTimer = setInterval(() => {
      void this.runGuardSweep().catch(() => {
        // The sweep is advisory. It must never be the reason a session ends.
      });
    }, ExchangeClient.GUARD_SWEEP_MS);

    this.guardSweepTimer.unref?.();
  }

  stopGuardSweep(): void {
    if (this.guardSweepTimer) clearInterval(this.guardSweepTimer);
    this.guardSweepTimer = null;
  }

  /**
   * One pass over the session and whatever position is on screen.
   *
   * Scoped to the followed market rather than every position on the account:
   * sweeping everything would mean a position query per market per thirty
   * seconds, and the behaviours this catches are about the thing being traded.
   */
  private guardSweepRunning = false;

  private async runGuardSweep(): Promise<void> {
    const market = this.lastFollowedMarket;
    if (!market) return;

    // One at a time, for the same reason the trail review is: a pass that
    // outlasts its interval must not have the next one start on top of it.
    // Every sweep reads the position, the equity and the market, and passes
    // stacking on a rate-limited queue is how a slow exchange becomes an
    // unusable one.
    if (this.guardSweepRunning) return;
    this.guardSweepRunning = true;
    try {
      await this.guardSweepPass(market);
    } finally {
      this.guardSweepRunning = false;
    }
  }

  private async guardSweepPass(market: string): Promise<void> {

    const position = await this.positionContextFor(market).catch(() => undefined);
    const summary = await this.equityFor(market);

    // Keeps the coach's view of the market warm. The two things it says without
    // being asked -- the confirmation panel's sentence and an unprompted remark
    // -- both arrive at moments that cannot wait for a read, so the read
    // happens here, on a timer, where waiting costs nothing.
    void this.guard.refreshMarket();
    // And the history behind it. Each size refuses to refetch until a bar of
    // its own size has closed, so this is a no-op on almost every sweep.
    void this.warmCoachCandles(market);

    const { transitions, interventions } = this.guard.sweep(
      position ? [position] : [],
      summary?.equity,
      this.availableMarkets?.[market]?.quote
    );

    // Only the edges are logged. What is merely still true is on the guard
    // status line, which is rewritten in place -- a standing breach re-derived
    // every thirty seconds is one fact, and reporting it as a hundred and
    // twenty events an hour buried every fill and cancel between them.
    for (const transition of transitions) {
      const finding = transition.finding;
      if (!finding) continue;

      // Notices are already visible in the panel's own numbers and on the
      // status line. They are tracked so they can escalate, but they do not
      // announce themselves in either direction.
      if (finding.severity === 'notice') continue;

      if (transition.kind === 'cleared') {
        NotificationManager.notify(
          `${finding.behaviour.title}: cleared.`,
          NType.INFO,
          'SYSTEM'
        );
        continue;
      }

      NotificationManager.notify(
        transition.kind === 'escalated'
          ? `${finding.behaviour.title} (now ${finding.severity}): ${finding.detail}`
          : `${finding.behaviour.title}: ${finding.detail}`,
        NType.ERROR,
        'WARNING'
      );

      // The coach is told only if the operator has asked for it to be. An
      // unprompted remark is a model call nobody requested and somebody pays
      // for, and a condition that flaps around its threshold can produce
      // several inside a quarter of an hour. What the guardrail found is
      // already on the status line and on the row above this one.
      if (this.guard.getPolicy().coachRemarks) {
        void this.guard
          .getThread()
          .nudge(finding)
          .catch(() => undefined);
      }
    }

    for (const intervention of interventions) {
      if (intervention.type === 'lockout') {
        this.guard.lockout(intervention.until, intervention.behaviour, intervention.reason);
        NotificationManager.notify(
          `New entries are stopped for ${Math.ceil(
            (intervention.until - Date.now()) / 60_000
          )} minutes. ${intervention.reason} ` +
            `Closing and protective orders are unaffected. Lift it with 'guard unlock'.`,
          NType.ERROR,
          'WARNING'
        );
        continue;
      }

      await this.offerAssistedExit(intervention.market, intervention.urgency, intervention.reason, intervention.authorised);
    }
  }

  /**
   * Works out how the position would be left, and either says so or does it.
   *
   * The plan is always computed and always shown. An operator who has not
   * authorised the guard to act still gets the useful half -- a worked-out exit
   * they can run themselves with 'guard exit' -- rather than a warning and a
   * shrug.
   */
  private async offerAssistedExit(
    market: string,
    urgency: ExitUrgency,
    reason: string,
    authorised: boolean
  ): Promise<void> {
    const plan = await this.buildExitPlan(market, urgency);
    if (!plan) return;

    const currency = this.availableMarkets?.[market]?.quote ?? '';

    // Recorded whether or not it is run. A plan that was offered and declined
    // is a decision, and it is the half of the exchange that leaves no other
    // trace: the plan that runs at least leaves fills behind it.
    this.guard.recordExitPlanned(
      market,
      urgency,
      plan.plan.slices.length,
      plan.plan.slices.reduce((total, slice) => total + slice.size, 0),
      `${describeExitPlan(plan.plan, currency)}${authorised ? '' : ' (offered, not run)'}`
    );

    if (!authorised) {
      NotificationManager.notify(
        `${reason} A worked exit is ready: ${describeExitPlan(plan.plan, currency)} ` +
          `Run it with 'guard exit', or authorise it in future with 'guard autoexit <behaviour>'.`,
        NType.INFO,
        'WARNING'
      );
      return;
    }

    NotificationManager.notify(
      `${reason} Closing the position: ${describeExitPlan(plan.plan, currency)}`,
      NType.ERROR,
      'WARNING'
    );

    await this.runExitPlan(market, plan.side, plan.plan);
  }

  /**
   * Tells the guard a protective stop moved, and which way.
   *
   * Which way is the whole point: the trail moves stops toward entry many times
   * an hour and that must never be flagged, while a stop moved away from entry
   * is the behaviour most worth catching. The side is read from the position
   * rather than inferred from the prices, because 'lower' means safer for a
   * short and worse for a long.
   */
  private async noteStopMoved(market: string, from: number, to: number): Promise<void> {
    if (!(from > 0) || !(to > 0) || from === to) return;

    const position = await this.getPositionView(market).catch(() => null);
    if (!position || !(position.size > 0)) return;

    this.guard.recordStopMoved(
      market,
      position.side.toLowerCase() === 'long' ? 'long' : 'short',
      from,
      to,
      position.entry
    );
  }

  /**
   * Tells the guard a protective stop was cancelled while a position was open.
   *
   * Whether the position was losing is recorded at the moment of the cancel,
   * not worked out later: by the time a sweep runs the position may be green
   * again, and 'they pulled the stop while it was underwater' would quietly
   * become false.
   */
  private async noteStopsCancelled(market: string, triggers: number[]): Promise<void> {
    if (triggers.length === 0) return;

    const position = await this.getPositionView(market).catch(() => null);
    if (!position || !(position.size > 0)) return;

    const underwater = (position.unrealizedPnl ?? 0) < 0;
    for (const trigger of triggers) {
      if (trigger > 0) this.guard.recordStopCancelled(market, trigger, underwater);
    }
  }

  /** The plan for leaving a market, or nothing if there is no position. */
  async buildExitPlan(
    market: string,
    urgency: ExitUrgency
  ): Promise<{ plan: ReturnType<typeof planExit>; side: 'long' | 'short' } | undefined> {
    const position = await this.positionContextFor(market).catch(() => undefined);
    if (!position || !(position.size > 0)) return undefined;

    const tick = await this.getMarketPrecision(market).catch(() => 0);

    let bestBid = position.markPrice ?? 0;
    let bestAsk = position.markPrice ?? 0;
    try {
      const ticker = await this.exchange!.fetchTicker(market);
      if (Number(ticker.bid) > 0) bestBid = Number(ticker.bid);
      if (Number(ticker.ask) > 0) bestAsk = Number(ticker.ask);
    } catch {
      // No book. The planner treats a zero spread as nothing to earn by
      // resting, which collapses it toward crossing -- the right default when
      // we cannot see what we would be resting inside of.
    }

    const atr = await this.getAtr(market, ExchangeClient.RANGE_ATR_PERIOD, '5m').catch(
      () => undefined
    );

    return {
      side: position.side,
      plan: planExit(
        {
          side: position.side,
          size: position.size,
          markPrice: position.markPrice ?? bestBid,
          bestBid,
          bestAsk,
          tick: tick > 0 ? tick : 0.01,
          atr,
        },
        urgency
      ),
    };
  }

  /**
   * The port the executor works through.
   *
   * Every child is reduce-only and every size is position-derived, so the
   * fatfinger limit is deliberately not enforced on them -- the same exemption
   * a stop gets, and for the same reason: an order that can only ever reduce
   * exposure must always be placeable.
   */
  private exitPort(): ExitExecutionPort {
    return {
      book: async (market) => {
        const ticker = await this.exchange!.fetchTicker(market);
        const tick = await this.getMarketPrecision(market).catch(() => 0.01);
        const bid = Number(ticker.bid);
        const ask = Number(ticker.ask);
        if (!(bid > 0) || !(ask > 0)) return undefined;
        return { bestBid: bid, bestAsk: ask, tick: tick > 0 ? tick : 0.01 };
      },
      positionSize: (market) => this.getPositionSize(market),
      placeReduceOnlyLimit: async (market, side, size, price) => {
        const quantity = await this.getQuantityPrecision(market, size, {
          enforceFatFinger: false,
          price,
        });
        const order = await this.executeOrder('createOrder', market, 'limit', side, quantity, price, {
          reduceOnly: true,
        });
        return order?.id ? String(order.id) : undefined;
      },
      placeReduceOnlyMarket: async (market, side, size) => {
        const quantity = await this.getQuantityPrecision(market, size, {
          enforceFatFinger: false,
        });
        const order = await this.executeOrder('createOrder', market, 'market', side, quantity, undefined, {
          reduceOnly: true,
        });
        return order?.id ? String(order.id) : undefined;
      },
      cancelOrder: async (market, orderId) => {
        await this.exchange!.cancelOrder(orderId, market);
        this.forgetCancelledOrders(market, [orderId]);
      },
      filledOf: async (market, orderId) => {
        const orders = await this.getLiveOpenOrders(market, undefined, true).catch(
          () => [] as Order[]
        );
        const found = orders.find((order) => String(order.id) === orderId);
        // Absent from the open list means it finished, and a finished child of
        // a reduce-only exit has filled. Reporting zero would have the executor
        // send the same quantity again.
        if (!found) return Number.POSITIVE_INFINITY;
        return Number(found.filled ?? 0);
      },
      say: (message, kind) =>
        NotificationManager.notify(
          message,
          kind === 'good' ? NType.SUCCESS : kind === 'bad' ? NType.ERROR : NType.INFO,
          kind === 'bad' ? 'WARNING' : 'ORDER'
        ),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  private activeExit: ExitExecutor | null = null;

  /** Whether an assisted exit is running, for 'guard exit stop'. */
  isExiting(): boolean {
    return this.activeExit?.isRunning() === true;
  }

  abortAssistedExit(): boolean {
    if (!this.activeExit) return false;
    this.activeExit.abort();
    return true;
  }

  async runExitPlan(
    market: string,
    side: 'long' | 'short',
    plan: ReturnType<typeof planExit>
  ): Promise<void> {
    if (this.isExiting()) {
      NotificationManager.notify(
        'An assisted exit is already running. Stop it with \'guard exit stop\' first.',
        NType.ERROR,
        'ERROR'
      );
      return;
    }

    // A fresh executor per run: abort is one-way by design, so a reused one
    // would refuse to start after the first time it was stopped.
    const executor = new ExitExecutor(this.exitPort());
    this.activeExit = executor;

    try {
      await executor.run(market, side, plan, Date.now());
    } finally {
      this.activeExit = null;
    }
  }

  startTrailMonitor(): void {
    if (this.trailTimer) return;
    this.trailTimer = setInterval(() => {
      // A pass can outlast the interval -- reconstructing a high-water mark
      // walks fills and candles -- and two passes reading the same pre-change
      // state both decide to move the same stop, then both announce it. One at
      // a time, whatever the interval and however many timers exist.
      if (this.trailReviewRunning) return;
      this.trailReviewRunning = true;
      void this.reviewAdaptiveTrails().finally(() => {
        this.trailReviewRunning = false;
      });
    }, ExchangeClient.TRAIL_CHECK_MS);
    // Long-lived timer; it must not be the reason the process stays alive.
    this.trailTimer.unref?.();
  }

  /** Whether a delayed trail has reached its arming price. */
  isTrailArmed(orderId: string): boolean {
    return this.armedTrails.has(orderId);
  }

  stopTrailMonitor(): void {
    if (this.trailTimer) clearInterval(this.trailTimer);
    this.trailTimer = null;
  }

  /**
   * One pass over every adaptive trail we can see.
   *
   * The register of what to manage is the exchange, not this process: a trail
   * carries its terms in its client order id, so anything found open and tagged
   * is picked up, including after a restart, and anything no longer open simply
   * is not found. There is no local list to fall out of step.
   */
  private async reviewAdaptiveTrails(): Promise<void> {
    const markets = new Set(this.adaptiveMarkets);
    if (this.lastFollowedMarket) markets.add(this.lastFollowedMarket);

    for (const market of markets) {
      try {
        const trails = await this.findAdaptiveTrails(market);

        // Anything no longer open has been filled or cancelled; its high-water
        // mark is meaningless and must not be reused if the id ever recurs.
        const live = new Set(trails.map((trail) => String(trail.id)));
        for (const id of Array.from(this.trailHighWater.keys())) {
          if (!live.has(id) && this.adaptiveMarkets.has(market)) {
            this.trailHighWater.delete(id);
            this.trailFailures.delete(id);
            this.abandonedTrails.delete(id);
            this.trailResumeAnnounced.delete(id);
            this.armedTrails.delete(id);
          }
        }

        if (trails.length === 0) {
          this.adaptiveMarkets.delete(market);
          continue;
        }
        this.adaptiveMarkets.add(market);
        for (const trail of trails) await this.reviewTrail(market, trail);
      } catch (error) {
        console.warn(
          `[ExchangeClient] Could not review trails on ${market}: ${
            (error as Error).message
          }`
        );
      }
    }
  }

  /**
   * When the current position was opened, established from fills.
   *
   * The exchange does not report it. `lastTermEndTimeNs` looks like it should
   * be it and is not: it records when the *previous* position closed, so on an
   * account that sat flat for a while it points hours before the position that
   * exists now.
   *
   * So it is reconstructed instead -- walk backwards through fills subtracting
   * each from the current size, and the fill that brings the running total to
   * zero is the one that opened it. That self-verifies: reaching exactly zero
   * means every fill in between has been accounted for. Truncated history
   * cannot reach zero, and the caller is expected to treat that as "unknown"
   * rather than as an answer.
   */
  private async findPositionOpenTime(
    market: string,
    side: TrailSide,
    size: number
  ): Promise<number | undefined> {
    let remaining = side === 'long' ? size : -size;
    let until = Date.now();

    try {
      for (let page = 0; page < ExchangeClient.FILL_WALK_PAGES; page++) {
        const since = until - ExchangeClient.FILL_WALK_WINDOW_MS;
        const fills: any[] = await this.exchange!.fetchMyTrades(market, since, 200);
        if (fills.length === 0) {
          until = since;
          continue;
        }

        fills.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

        for (const fill of fills) {
          if ((fill.timestamp ?? 0) > until) continue;
          const signed =
            String(fill.side).toLowerCase() === 'buy'
              ? Number(fill.amount)
              : -Number(fill.amount);
          remaining -= signed;
          if (Math.abs(remaining) < 1e-6) return fill.timestamp;
        }

        until = Math.min(...fills.map((fill) => fill.timestamp ?? until)) - 1;
      }
    } catch {
      // Fills unavailable; the caller falls back rather than guessing.
    }

    return undefined;
  }

  /**
   * The price a new trail should measure its cushion back from.
   *
   * A trailing stop protects a position, so the extreme that matters is the
   * best price *the position* has seen -- not the price at the arbitrary moment
   * the operator typed the command. Placing a trail after a pullback should not
   * forfeit the run-up that already happened.
   *
   * Two things make that safe to attempt. The position's opening is established
   * from fills that add up, not inferred; and if the resulting stop would sit
   * closer to the mark than half a cushion, the high is treated as stale and
   * the mark is used instead. Without that second rule an old high would place
   * a stop just under the market and the position would be closed by ordinary
   * noise within minutes.
   */
  private async anchorForNewTrail(
    market: string,
    side: TrailSide,
    size: number,
    cushion: number,
    mark: number
  ): Promise<{ anchor: number; note: string }> {
    const openedAt = await this.findPositionOpenTime(market, side, size);
    if (openedAt === undefined) {
      return { anchor: mark, note: 'from the current mark; the position\'s opening could not be established' };
    }

    const high = await this.reconstructHighWaterMark(market, side, openedAt);
    if (high === undefined) return { anchor: mark, note: 'from the current mark' };

    const direction = side === 'long' ? 1 : -1;
    if (direction * (high - mark) <= 0) return { anchor: mark, note: 'from the current mark' };

    // Would the stop this implies leave enough room to be worth having?
    const implied = high - direction * cushion;
    if (direction * (mark - implied) < cushion / 2) {
      return {
        anchor: mark,
        note: `from the current mark; the high of ${this.formatPriceForDisplay(market, high)} would leave the stop too close to price`,
      };
    }

    const hours = (Date.now() - openedAt) / 3_600_000;
    return {
      anchor: high,
      note: `from the position's high of ${this.formatPriceForDisplay(market, high)} over ${hours.toFixed(1)}h`,
    };
  }

  /**
   * Rebuilds a trail's high-water mark after a restart.
   *
   * The mark is tracked in memory, so a restart forgets it while the stop
   * itself carries on resting at the exchange. Rather than starting the trail
   * over from the current price, the highest price since the order was placed
   * is read back out of candles.
   *
   * Getting this slightly low is safe by construction: a low high-water mark
   * can only make the trail slower to raise the stop, never willing to lower
   * one.
   */
  private async reconstructHighWaterMark(
    market: string,
    side: TrailSide,
    placedAt: number | undefined
  ): Promise<number | undefined> {
    const mark = await this.getMarkPriceForTrail(market);
    if (placedAt === undefined || !Number.isFinite(placedAt)) return mark;

    const elapsed = Date.now() - placedAt;

    // The finest candles that still reach back to when the order was placed.
    const source = ['1m', '15m', '4h', '1d'].find((timeframe) => {
      const span = this.exchange!.parseTimeframe(timeframe) * 1000 * ExchangeClient.CANDLE_LIMIT;
      return span >= elapsed;
    });
    if (!source) return mark;

    // Two series, not one. The coarse candles reach back far enough to cover
    // the whole period but are blind to the most recent part of it: exchanges
    // publish closed candles only, so an extreme set inside the candle still
    // forming is not in them yet. On a position opened hours ago that meant a
    // spike fifteen minutes old was invisible, and the reconstruction came back
    // below the high the resting stop had already been set from.
    const series = source === '1m' ? [source] : [source, '1m'];

    try {
      const extremes: number[] = [];

      for (const timeframe of series) {
        const candles = await this.getCandles(market, timeframe);
        const since = candles.filter((candle) => candle.timestamp >= placedAt);
        if (since.length === 0) continue;

        extremes.push(
          side === 'long'
            ? Math.max(...since.map((candle) => candle.high))
            : Math.min(...since.map((candle) => candle.low))
        );
      }

      if (extremes.length === 0) return mark;

      const extreme =
        side === 'long' ? Math.max(...extremes) : Math.min(...extremes);

      return advanceHighWaterMark(side, extreme, mark ?? extreme);
    } catch {
      return mark;
    }
  }

  /**
   * Replaces a managed stop with an exchange-run trailing stop.
   *
   * The new order goes on before the old one comes off. Two stops for a moment
   * is harmless -- both close the whole position, so the second finds nothing
   * to do -- whereas a gap between them is a moment with no protection at all,
   * which is not a trade worth making to keep the panel tidy.
   *
   * The extreme the exchange starts from is the current price, and that is
   * right here: arming happens because price has just reached the arming level,
   * so there is no earlier high to carry across.
   */
  private async handOverToExchangeTrail(
    market: string,
    order: Order,
    distance: number,
    side: TrailSide
  ): Promise<void> {
    const id = String(order.id ?? '');
    const info: any = (order as any).info ?? {};
    const quantity = Number(info.orderQtyRq ?? 0);

    const reference = await this.getMarkPriceForTrail(market);
    if (reference === undefined) return;

    const start = side === 'long' ? reference - distance : reference + distance;

    try {
      const replacement = await this.createStopOrder(
        market,
        start,
        quantity > 0 ? quantity : undefined,
        true,
        false,
        distance
      );

      if (!replacement?.id) throw new Error('the exchange did not return an order');

      await this.exchange!
        .cancelOrder(id, market)
        .then(() => this.forgetCancelledOrders(market, [id]))
        .catch((error: unknown) => {
        // The trail is running; the old stop is the leftover. Say so plainly
        // rather than leaving two stops on the book unexplained.
        NotificationManager.notify(
          `The exchange trail is running, but the original stop ${id.slice(0, 8)} could not be cancelled: ` +
            `${(error as Error).message}. Cancel it manually.`,
          NType.ERROR,
          'ERROR'
        );
      });

      this.trailHighWater.delete(id);
      this.trailFailures.delete(id);

      NotificationManager.notify(
        `Handed to the exchange: trailing ${this.formatPriceForDisplay(market, distance)} ` +
          `behind, from ${this.formatPriceForDisplay(market, start)}. ` +
          `It keeps trailing whether or not Tame is running.`,
        NType.SUCCESS,
        'ORDER'
      );
    } catch (error) {
      NotificationManager.notify(
        `Could not hand trail ${id.slice(0, 8)} to the exchange: ${(error as Error).message}. ` +
          `The original stop is still resting and unchanged.`,
        NType.ERROR,
        'ERROR'
      );
    }
  }

  /** How a trail's terms read in a message. */
  private describeTrailTag(tag: TrailTag): string {
    return tag.kind === 'atr'
      ? `${tag.value}x ATR(${ExchangeClient.RANGE_ATR_PERIOD}) ${tag.timeframe}`
      : `${tag.value} fixed`;
  }

  private async reviewTrail(market: string, order: Order): Promise<void> {
    const id = String(order.id ?? '');
    if (!id || this.abandonedTrails.has(id)) return;

    const info: any = (order as any).info ?? {};
    const tag = readTrailTag((order as any).clientOrderId ?? info.clOrdID);
    if (!tag) return;

    const stop = Number(info.stopPxRp);
    const side: TrailSide = String(order.side ?? '').toLowerCase() === 'sell' ? 'long' : 'short';

    const mark = await this.getMarkPriceForTrail(market);
    if (mark === undefined) return;

    const tick = await this.getMarketPrecision(market).catch(() => 0);

    // A fixed trail's distance is on the order; an ATR one is measured now.
    let cushion: number | undefined = tag.kind === 'fixed' ? tag.value : undefined;
    if (tag.kind === 'atr' && tag.timeframe) {
      const atr = await this.getAtr(
        market,
        ExchangeClient.RANGE_ATR_PERIOD,
        tag.timeframe
      ).catch(() => undefined);
      cushion = atr === undefined ? undefined : atr * tag.value;
    }
    if (cushion === undefined || !(cushion > 0)) return;
    const direction = side === 'long' ? 1 : -1;

    let high = this.trailHighWater.get(id);
    if (high === undefined) {
      // Rebuilt from the position, not the order.
      //
      // The order carries no usable record of when it was placed: Phemex moves
      // actionTimeNs and transactTimeNs together on every amendment, so after
      // the first move they all read as the moment of that move. Reconstructing
      // from them looked back only as far as the last amendment and found a
      // high of 102.39 where the real one was 103.13.
      //
      // The position's opening is the right boundary anyway -- it is the same
      // "since entry" the trail was placed against.
      const position = await this.getPositionView(market).catch(() => null);
      const resumed = position
        ? await this.anchorForNewTrail(market, side, position.size, cushion, mark)
        : { anchor: mark, note: 'from the current mark' };

      // Never behind the stop already resting. Whatever high produced that stop
      // was at least this, so starting below it would leave the trail unable to
      // account for its own order.
      const impliedByStop = stop + direction * cushion;
      high =
        direction * (impliedByStop - resumed.anchor) > 0 ? impliedByStop : resumed.anchor;

      if (!this.trailResumeAnnounced.has(id)) {
        this.trailResumeAnnounced.add(id);
        NotificationManager.notify(
          `Resumed managing trail ${id.slice(0, 8)} from a high of ${this.formatPriceForDisplay(market, high)}`,
          NType.INFO,
          'SYSTEM'
        );
      }
    }

    high = advanceHighWaterMark(side, high, mark);
    if (high === undefined) return;
    this.trailHighWater.set(id, high);

    // A delayed trail does nothing until the position has moved far enough to
    // arm it. The test is against the high-water mark rather than the current
    // price, so arming is sticky: once reached it stays reached, and a pullback
    // cannot un-arm a trail that has already begun.
    if (tag.armPrice !== undefined) {
      if (direction * (high - tag.armPrice) < 0) return;

      if (!this.armedTrails.has(id)) {
        this.armedTrails.add(id);
        // Journalled as well as announced. It is the moment a fixed stop starts
        // following the position, and it is the only transition in the system
        // that leaves no trace on the order itself -- the order is identical
        // either side of it. Without this line a record of the day cannot say
        // when, or whether, the trail ever began.
        this.guard.recordTrailArmed(market, tag.armPrice, stop, id);
        NotificationManager.notify(
          `Trail armed at ${this.formatPriceForDisplay(market, tag.armPrice)} ` +
            `(${this.describeTrailTag(tag)})`,
          NType.SUCCESS,
          'ORDER'
        );
      }

      // A fixed distance has nothing left to recalculate, so from here the
      // exchange runs it and keeps running it whether or not this process does.
      // An ATR trail stays with us, because its distance keeps changing.
      //
      // But only while price is at its high. The exchange begins trailing from
      // wherever price is when the order is placed, and knows nothing of any
      // extreme before that -- so handing over during a pullback would set the
      // stop a full distance below the current price rather than below the high
      // it should be measured from. That is not hypothetical: a trail that
      // armed while Tame was closed is discovered on restart, quite possibly
      // after a retrace, and the high we just reconstructed would be discarded
      // in the act of using it.
      //
      // So it stays managed here until price returns to its high-water mark, at
      // which point the two agree and the hand-over costs nothing. Until then
      // it trails from here, which is the same protection by a different means.
      if (tag.kind === 'fixed') {
        const room = Math.max(tick, 1e-8);
        if (direction * (mark - high) >= -room) {
          await this.handOverToExchangeTrail(market, order, tag.value, side);
          return;
        }
      }

    }

    const plan = planTrailStop(
      { side, highWaterMark: high, stop, mark },
      {
        cushion,
        tick: tick > 0 ? tick : 0.01,
        minimumImprovementFraction: ExchangeClient.TRAIL_MIN_IMPROVEMENT,
        safetyTicks: ExchangeClient.TRAIL_SAFETY_TICKS,
      }
    );

    if (plan.action === 'hold') return;

    try {
      // A trail covering the whole position carries a quantity of zero, which
      // is the marker for "all" and not a size. Passing it back is rejected
      // before the request is even sent -- amountToPrecision refuses anything
      // under the minimum tradeable amount -- so it is omitted instead, and the
      // exchange keeps whatever the order already had. A sized trail does pass
      // its quantity, so an amendment cannot silently change it.
      const quantity = Number(info.orderQtyRq ?? 0);
      const amount = quantity > 0 ? quantity : undefined;

      await this.exchange!.editOrder(id, market, 'Stop', String(order.side), amount, undefined, {
        triggerPrice: plan.stop,
        posSide: 'Merged',
      } as any);

      // Accepted is not applied. Read the order back and check the exchange
      // actually holds the new trigger -- an amendment that is accepted and
      // ignored would otherwise be retried forever, moving nothing.
      const after = (await this.findAdaptiveTrails(market, true)).find((o) => o.id === id);
      const stored = Number((after as any)?.info?.stopPxRp);

      if (!(Math.abs(stored - plan.stop) < Math.max(tick, 1e-8))) {
        throw new Error(`the exchange still holds a stop at ${stored}`);
      }

      this.trailFailures.delete(id);
      NotificationManager.notify(
        `Trail raised ${this.formatPriceForDisplay(market, stop)} -> ` +
          `${this.formatPriceForDisplay(market, plan.stop)} ` +
          `(${this.describeTrailTag(tag)} = ${this.formatPriceForDisplay(market, cushion)} behind ` +
          `${this.formatPriceForDisplay(market, high)})`,
        NType.SUCCESS,
        'ORDER'
      );
    } catch (error) {
      const failures = (this.trailFailures.get(id) ?? 0) + 1;
      this.trailFailures.set(id, failures);

      if (failures >= ExchangeClient.TRAIL_MAX_FAILURES) {
        this.abandonedTrails.add(id);
        // Loudly, and once. A trail that has silently stopped moving is the
        // failure this whole design exists to avoid, so it is never left to be
        // inferred from the absence of messages.
        NotificationManager.notify(
          `Trail ${id.slice(0, 8)} could not be moved after ${failures} attempts and is no longer being managed. ` +
            `The stop is still resting at ${this.formatPriceForDisplay(market, stop)} and will not advance. ` +
            `Restart to resume managing it. Last error: ${(error as Error).message}`,
          NType.ERROR,
          'ERROR'
        );
      } else {
        console.warn(
          `[ExchangeClient] Trail ${id.slice(0, 8)} amendment failed (${failures}): ${
            (error as Error).message
          }`
        );
      }
    }
  }

  /** The mark, for valuing a trail. Falls back to the last trade if unpublished. */
  private async getMarkPriceForTrail(market: string): Promise<number | undefined> {
    const { mark } = await this.getFundingSnapshot(market);
    if (Number.isFinite(Number(mark)) && Number(mark) > 0) return Number(mark);
    return this.getReferencePrice(market);
  }

  /**
   * Working orders on a market that this application placed as adaptive trails.
   *
   * `fresh` forces a read from the exchange rather than the cached order list.
   * Checking an amendment against a cache written before it was sent reported
   * the old value and called a successful change a failure.
   */
  private async findAdaptiveTrails(market: string, fresh = false): Promise<Order[]> {
    const orders = await this.getLiveOpenOrders(market, undefined, fresh).catch(
      () => [] as Order[]
    );
    return orders.filter((order) =>
      readTrailTag((order as any).clientOrderId ?? (order as any).info?.clOrdID)
    );
  }

  /**
   * A stop now, which becomes a trail once the position has proved itself.
   *
   * The arming price is the stop plus the trail's distance -- the point at
   * which trailing would first put the stop somewhere better than where it
   * already is. Measuring from the entry instead held the stop still through a
   * window where trailing would have raised it, and gained nothing: the two
   * rules converge the moment the entry-based one arms and are identical from
   * then on, so measuring from the entry could only ever be the same or worse.
   *
   * It also makes the order mean what it says. 'stop 98.50 trail 10' is a stop
   * at 98.50 that trails ten behind, and it starts trailing exactly when
   * trailing would move it. Nothing about the entry price comes into it.
   *
   * The distance and the arming price are both fixed at placement. Recomputing
   * either later would move the arming price after the fact: adding to a
   * position changes its average entry, and an ATR cushion changes every
   * candle.
   */
  async createDelayedTrailOrder(
    market: string,
    stopPrice: number,
    size: number | undefined,
    spec: TrailSpec
  ): Promise<Order | undefined> {
    const position = await this.getPositionView(market);
    if (!position || !(position.size > 0)) {
      throw new Error('No open position to trail.');
    }
    // No entry price needed: arming is measured from the stop being placed, not
    // from where the position was opened.
    const existing = await this.findAdaptiveTrails(market);
    if (existing.length > 0) {
      throw new Error(
        `A managed trail is already running on ${market} (${String(existing[0].id).slice(0, 8)}). ` +
          `Cancel it first. No order was placed.`
      );
    }

    const reference =
      (await this.getMarkPriceForTrail(market)) ?? (await this.getReferencePrice(market));
    if (reference === undefined) {
      throw new Error(`No price available for ${market}, so the trail cannot be placed.`);
    }

    const distance = await this.resolveTrailDistance(market, spec, reference);
    if (distance === undefined || !(distance > 0)) {
      throw new Error(
        spec.kind === 'atr'
          ? `Could not measure ATR(${spec.period}) on ${spec.timeframe} for ${market}. No order was placed.`
          : 'That trail works out to zero distance.'
      );
    }

    const isLong = position.side.toUpperCase() === 'LONG';
    const armPrice = isLong ? stopPrice + distance : stopPrice - distance;

    const clientOrderId = buildTrailTag(
      spec.kind === 'atr'
        ? { kind: 'atr', value: spec.multiple, timeframe: spec.timeframe, armPrice }
        : { kind: 'fixed', value: distance, armPrice }
    );

    const order = await this.createStopOrder(
      market,
      stopPrice,
      size,
      false,
      true,
      undefined,
      clientOrderId,
      true
    );

    if (order?.id) {
      this.adaptiveMarkets.add(market);
      this.trailHighWater.set(String(order.id), reference);
    }

    const already = isLong ? reference >= armPrice : reference <= armPrice;

    NotificationManager.notify(
      `Stop at ${this.formatPriceForDisplay(market, stopPrice)}; ` +
        `trails ${describeTrailSpec(spec)} once price reaches ` +
        `${this.formatPriceForDisplay(market, armPrice)} ` +
        `(the stop plus ${this.formatPriceForDisplay(market, distance)})` +
        (already ? '. Price is already there, so it arms on the next check.' : ''),
      NType.INFO,
      'ORDER'
    );

    return order;
  }

  async createTrailingStopOrder(
    market: string,
    spec: TrailSpec
  ): Promise<Order | undefined> {
    // One adaptive trail per market. Two managers amending one position's
    // protection would race, and replacing the existing one silently would
    // throw away the high-water mark it has built up -- so this refuses and
    // says what is already there rather than deciding for the operator.
    if (spec.kind === 'atr') {
      const existing = await this.findAdaptiveTrails(market);
      if (existing.length > 0) {
        const trigger = (existing[0] as any).triggerPrice ?? (existing[0] as any).info?.stopPxRp;
        throw new Error(
          `An adaptive trail is already running on ${market} (${String(existing[0].id).slice(0, 8)}, stop ${trigger}). ` +
            `Cancel it first if you want different terms. No order was placed.`
        );
      }
    }

    const position = await this.getPositionView(market);
    if (!position || !(position.size > 0)) {
      throw new Error('No open position to trail.');
    }

    // The mark, because that is what the trigger is measured against. Anchoring
    // on the last trade instead put the stop a tick or two off from the moment
    // it was placed, for no reason other than that two prices were in play.
    const reference =
      (await this.getMarkPriceForTrail(market)) ??
      (await this.getReferencePrice(market));

    if (reference === undefined) {
      throw new Error(
        `No price available for ${market}, so the trail cannot be placed.`
      );
    }

    const distance = await this.resolveTrailDistance(market, spec, reference);

    if (distance === undefined) {
      // Only an ATR trail can fail to resolve, and only because volatility
      // could not be measured. Saying so beats a generic zero-distance error.
      throw new Error(
        spec.kind === 'atr'
          ? `Could not measure ATR(${spec.period}) on ${spec.timeframe} for ${market}, so the trail has no width. No order was placed.`
          : 'That trail works out to zero distance.'
      );
    }

    if (!(distance > 0)) {
      throw new Error('That trail works out to zero distance.');
    }

    const isLong = position.side.toUpperCase() === 'LONG';
    // Starts one trail-width away, as a trailing stop does, and the exchange
    // moves it from there.
    const start = isLong ? reference - distance : reference + distance;

    if (!(start > 0)) {
      throw new Error(
        `A trail of ${distance} puts the stop at or below zero from ${reference}.`
      );
    }

    // Says the distance, and says it is fixed. The exchange trails a price
    // offset, not a rule: '2%' and '3atr' are ways of arriving at a number
    // once, and the number is what the order carries from then on. Reporting
    // only '2%' invites the reader to assume it stays two percent of a rising
    // price, which it does not.
    // Says what this order will do from here, which now differs by kind: a
    // fixed trail keeps its distance for life, an ATR one has its distance
    // re-derived as candles close. Reporting 'fixed once placed' on both was
    // true when it was written and became false when ATR trails started
    // adapting -- exactly the sort of stale reassurance that stops an operator
    // looking at something they should look at.
    if (spec.kind !== 'atr') {
      NotificationManager.notify(
        `Trailing ${this.formatPriceForDisplay(market, distance)} behind ` +
          `${this.formatPriceForDisplay(market, reference)} ` +
          `(${describeTrailSpec(spec)}, fixed once placed)`,
        NType.INFO,
        'ORDER'
      );
    } else {
      NotificationManager.notify(
        `Trailing ${this.formatPriceForDisplay(market, distance)} behind the high ` +
          `(${describeTrailSpec(spec)}, adjusts as volatility changes)`,
        NType.INFO,
        'ORDER'
      );
    }

    // Two different orders, deliberately.
    //
    // A fixed trail is handed to the exchange as a peg and forgotten: nothing
    // needs to recalculate it, so it is better run somewhere that keeps working
    // when this process does not.
    //
    // An adaptive one is a plain stop that this process moves. It has to be:
    // its distance changes, so it already depends on Tame running, and owning
    // the level outright is what makes the rule a single line -- the stop sits
    // one cushion behind the high-water mark and never moves backwards. Driving
    // the exchange's own trail instead meant the exchange kept advancing the
    // stop underneath us, so widening the cushion could only be bought by
    // giving back locked profit.
    if (spec.kind !== 'atr') {
      return this.createStopOrder(market, start, undefined, false, true, distance);
    }

    const clientOrderId = buildTrailTag({
      kind: 'atr',
      value: spec.multiple,
      timeframe: spec.timeframe,
    });

    // A trail protects a position, so it measures back from the best price the
    // position has seen rather than from whatever price happened to be showing
    // when the command was typed.
    const { anchor, note } = await this.anchorForNewTrail(
      market,
      isLong ? 'long' : 'short',
      position.size,
      distance,
      reference
    );

    const anchoredStart = isLong ? anchor - distance : anchor + distance;

    const order = await this.createStopOrder(
      market,
      anchoredStart,
      undefined,
      false,
      true,
      undefined,
      clientOrderId,
      true
    );

    if (order?.id) {
      this.adaptiveMarkets.add(market);
      this.trailHighWater.set(String(order.id), anchor);
    }

    NotificationManager.notify(`Measured ${note}`, NType.INFO, 'ORDER');

    return order;
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

          // Only once the replacement exists: a cancel that was not followed by
          // a new stop is a cancellation, not a move, and reporting it as a
          // move would hide the more serious of the two.
          void this.noteStopMoved(market, Number(stopOrder.stopPrice), finalStopPrice);

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
