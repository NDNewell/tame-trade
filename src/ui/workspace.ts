// src/ui/workspace.ts
//
// Connects the terminal workspace to the exchange client: turns what the client
// knows into the view the screen renders, and keeps it current.

import { ExchangeClient } from '../exchange/exchangeClient.js';
import { ActivityLog } from './activityLog.js';
import { Screen } from './screen.js';
import { NO_VALUE, TerminalView } from './frame.js';
import { PositionRiskResult } from '../trading/positionRisk.js';
import { readTrailTag } from '../trading/trailTag.js';

const FOOTER = [
  'buy',
  'sell',
  'chase',
  'limit',
  'trail',
  'cancel',
  'orders',
  'positions',
  'market',
  'help',
];

const dash = (value: unknown, suffix = ''): string =>
  value === undefined || value === null || value === '' ? NO_VALUE : `${value}${suffix}`;

/** Trims trailing zeros so 1.000 shows as 1 but 0.5 keeps its precision. */
const formatQuantity = (value: number): string => {
  if (!Number.isFinite(value)) return NO_VALUE;
  return String(Number(value.toFixed(8)));
};

/**
 * Position size with digit grouping and its base asset, so a four-figure size is
 * readable at a glance and the panel says what it is holding without the reader
 * looking back at the header. No trailing zeros are added for alignment.
 */
const formatPositionSize = (value: number, base?: string): string => {
  if (!Number.isFinite(value)) return NO_VALUE;

  const grouped = Number(value.toFixed(8)).toLocaleString('en-US', {
    maximumFractionDigits: 8,
  });

  return base ? `${grouped} ${base}` : grouped;
};

/** Time remaining as mm:ss, floored at zero. */
const countdown = (deadline: number): string => {
  const remaining = Math.max(0, deadline - Date.now());
  const total = Math.ceil(remaining / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/** Two decimals with digit grouping, so a four-figure balance stays readable. */
const formatMoney = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const signed = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return NO_VALUE;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NO_VALUE;
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}`;
};

export function emptyView(): TerminalView {
  return {
    header: {
      environment: 'LIVE',
      connection: 'CONNECTING',
      exchange: NO_VALUE,
      instrumentType: '',
      account: NO_VALUE,
      balance: NO_VALUE,
      equity: NO_VALUE,
      fundsCurrency: '',
    },
    market: {
      symbol: NO_VALUE,
      last: NO_VALUE,
      change: NO_VALUE,
      bid: NO_VALUE,
      ask: NO_VALUE,
      mark: NO_VALUE,
      index: NO_VALUE,
      funding: NO_VALUE,
      spread: NO_VALUE,
    },
    ranges: [],
    position: null,
    orders: [],
    chase: null,
    activity: [],
    confirmation: null,
    input: '',
    footer: FOOTER,
    footerRight: 'Ctrl+C',
  };
}

/**
 * Three states that must stay distinct:
 *   '--'            no protective coverage, so no risk can be stated
 *   '0.00 USDT'     covered, and the stops sit beyond breakeven
 *   '1,000.00 USDT' a real planned downside
 *
 * Partial coverage names the unprotected quantity rather than implying the
 * whole position carries the stated risk.
 */
const formatRisk = (
  risk: PositionRiskResult | undefined,
  base?: string,
  short = false
): string => {
  if (!risk || risk.totalRisk === undefined) {
    // Ambiguous coverage is flagged rather than resolved into a number that
    // would look precise and be wrong.
    return risk?.isAmbiguous ? `${NO_VALUE} [AMBIGUOUS STOPS]` : NO_VALUE;
  }

  const amount = risk.totalRisk.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const value = `${amount} ${risk.currency}`.trim();

  if (risk.isFullyProtected) return value;

  const unprotected = Number(risk.unprotectedQuantity.toFixed(8)).toLocaleString('en-US');
  return short
    ? `${value} [PARTIAL]`
    : `${value} + ${unprotected}${base ? ` ${base}` : ''} unprotected`;
};

export class Workspace {
  private screen: Screen | null = null;
  private market = '';
  private accountLabel: string | undefined;
  private funds: { balance?: number; equity?: number; currency: string } = {
    currency: '',
  };
  private refreshTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastOrders: TerminalView['orders'] = [];

  constructor(
    private client: ExchangeClient,
    private onCommand: (command: string) => Promise<void>,
    private onQuit: () => void
  ) {}

  start(market: string): void {
    this.market = market;

    // Looked up once; the header shows '--' until it arrives rather than
    // blocking the workspace from opening.
    void this.client.getAccountLabel().then((account) => {
      if (!account) return;
      this.accountLabel = account;
      this.screen?.update({ header: this.header() });
    });

    const view = emptyView();
    view.header.exchange = this.client.getSelectedExchangeName() ?? NO_VALUE;
    view.header.connection = 'CONNECTED';

    this.screen = new Screen(view, this.onCommand, this.onQuit);
    this.screen.start();

    ActivityLog.getInstance().add('SYSTEM', `Connected to ${view.header.exchange}`);
    if (market) {
      ActivityLog.getInstance().add('MARKET', `${market.split(':')[0]} selected`);
    }

    // The feeds push prices and order events; this refresh covers what only REST
    // can tell us, chiefly the position.
    // Adaptive trails are the exchange's to run and ours to adjust; the monitor
    // reconsiders them as candles close.
    this.client.startTrailMonitor();

    this.refreshTimer = setInterval(() => void this.refresh(), 2000);
    this.tickTimer = setInterval(() => this.tickCountdown(), 1000);
    void this.refresh();
  }

  /** The header as it currently stands, for partial updates. */
  private header() {
    return {
      ...emptyView().header,
      exchange: this.client.getSelectedExchangeName() ?? NO_VALUE,
      connection: 'CONNECTED',
      account: this.accountLabel ?? NO_VALUE,
      balance: formatMoney(this.funds.balance),
      equity: formatMoney(this.funds.equity),
      fundsCurrency: this.funds.currency,
    };
  }

  setMarket(market: string): void {
    this.market = market;
    // The figures are account-level but their unit follows the market's
    // settlement currency, so they are cleared until the next refresh rather
    // than shown against the previous market's unit.
    this.funds = { currency: '' };
    this.screen?.update({ header: this.header() });
    void this.refresh();
  }

  get isRunning(): boolean {
    return this.screen?.isRunning === true;
  }

  getScreen(): Screen | null {
    return this.screen;
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.refreshTimer = null;
    this.tickTimer = null;
    this.client.stopTrailMonitor();
    this.screen?.stop();
    this.screen = null;
  }

  /**
   * Advances the countdown between data refreshes.
   *
   * Only repaints while a decaying chase is running, and only rewrites the
   * countdown from what is already known -- a clock is not worth an API call a
   * second, and repainting a static screen every second is not worth it either.
   */
  private tickCountdown(): void {
    const deadline = this.client.getChaseDeadline();
    const chaseOrderId = this.client.getCurrentChaseOrderId();
    if (!deadline || !chaseOrderId || !this.screen) return;

    this.screen.update({
      orders: this.lastOrders.map((order) =>
        order.managed === 'CHASE'
          ? { ...order, expires: countdown(deadline) }
          : order
      ),
    });
  }

  private async refresh(): Promise<void> {
    if (!this.screen || !this.market) return;

    // The full form, settlement suffix included. It is the only place the
    // market is named now, so it names it completely.
    const symbol = this.market;

    try {
      const [position, orders, risk, funds, ranges] = await Promise.all([
        this.client.getPositionView(this.market).catch(() => null),
        this.client.getOpenOrdersForDisplay(this.market).catch(() => []),
        this.client.getPositionRisk(this.market).catch(() => undefined),
        this.client.getAccountFunds(this.market).catch(() => undefined),
        this.client.getPriceRanges(this.market).catch(() => []),
      ]);

      // A failed read leaves the last known figures in place rather than
      // blanking them: a momentary gap in the balance endpoint is not news,
      // and a flickering equity figure invites misreading.
      if (funds) this.funds = funds;

      const price = await this.client.getDisplayPrice(this.market);

      // Quoted prices follow the instrument's tick, so the column doesn't mix
      // 95.1 with 94.59. Calculated values keep their own precision.
      const tick = (value: unknown): string =>
        value === undefined || value === null || value === ''
          ? NO_VALUE
          : this.client.formatPriceForDisplay(this.market, Number(value));

      const base = this.client.getBaseAsset(this.market);
      const chaseOrderId = this.client.getCurrentChaseOrderId();
      const chaseDeadline = this.client.getChaseDeadline();

      this.screen.update({
        header: this.header(),
        ranges: ranges.map(({ label, high, low, atr }) => ({
          label,
          high: tick(high),
          low: tick(low),
          atr: tick(atr),
        })),
        market: {
          symbol,
          last: tick(price.last),
          change: price.change ?? NO_VALUE,
          bid: tick(price.bid),
          ask: tick(price.ask),
          mark: tick(price.mark),
          index: tick(price.index),
          funding: dash(price.funding),
          spread: dash(price.spread),
        },
        position: position
          ? {
              side: position.side || NO_VALUE,
              size: formatPositionSize(position.size, base),
              // Average entry is a calculated value and keeps the precision
              // needed to represent the true average, unlike a quoted price.
              entry:
                position.entry !== undefined
                  ? String(Number(position.entry.toFixed(6)))
                  : NO_VALUE,
              // The mark the position was valued at, so entry, mark and
              // unrealized on this panel all describe the same instant and can
              // be checked against each other. The MARKET panel's mark is a
              // separate, fresher reading of the same thing.
              mark: tick(position.mark),
              unrealizedPnl:
                position.unrealizedPnl !== undefined
                  ? `${signed(position.unrealizedPnl)}${position.currency ? ` ${position.currency}` : ''}`
                  : NO_VALUE,
              realizedPnl:
                position.realizedPnl !== undefined
                  ? `${signed(position.realizedPnl)}${position.currency ? ` ${position.currency}` : ''}`
                  : NO_VALUE,
              risk: formatRisk(risk, base),
              riskShort: formatRisk(risk, base, true),
              leverage: dash(position.leverage, 'x'),
              effectiveLeverage:
                position.effectiveLeverage !== undefined
                  ? `${position.effectiveLeverage.toFixed(2)}x`
                  : NO_VALUE,
              liquidation: dash(position.liquidation),
            }
          : null,
        orders: (this.lastOrders = orders.map((order) => {
          const info = (order as any).info ?? {};
          const trigger = (order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp;
          const size = Number(order.remaining ?? order.amount ?? 0);
          const isTrigger = trigger !== undefined && Number(trigger) > 0;

          // What the order is, kept separate from where it is in its life. The
          // exchange conflates the two; the distinction is ours to present.
          const type = isTrigger
            ? 'STOP'
            : String(order.type ?? 'LIMIT').toUpperCase();

          // A trailing stop is a stop the exchange keeps moving. Without this
          // it is indistinguishable from a fixed one in the panel, so there is
          // no way to tell from the screen whether the trail actually took.
          const peg = Number(info.pegOffsetValueRp ?? info.pegOffsetValueEp ?? 0);
          const isTrailing =
            peg !== 0 &&
            String(info.pegPriceType ?? '').toLowerCase().includes('trailing');

          // A trail this application moves, as opposed to one the exchange
          // runs at a fixed distance. It carries no peg -- to the exchange it
          // is an ordinary stop -- so the tag is the only thing that
          // distinguishes it, and the distinction matters: only one of the two
          // adjusts itself.
          // A trail this application is responsible for. Before it arms it is
          // an ordinary stop that will become a trail; after, it is one being
          // moved. Those are different enough to show differently, since only
          // one of them is going anywhere.
          const tag = readTrailTag((order as any).clientOrderId ?? info.clOrdID);
          const waiting =
            tag?.armPrice !== undefined && !this.client.isTrailArmed(String(order.id));

          const filled = Number(order.filled ?? 0);
          const status = isTrigger
            ? 'WORKING'
            : filled > 0 && size > 0
            ? 'PARTIAL'
            : String(order.status ?? 'open').toLowerCase() === 'open'
            ? 'WORKING'
            : String(order.status ?? '').toUpperCase();

          return {
            id: String(order.id ?? '').slice(0, 8),
            side: String(order.side ?? '').toUpperCase(),
            // An order covering the whole position carries a quantity of zero.
            // 'ALL' says what that means; '0' reads as an empty order.
            qty: size > 0 ? formatQuantity(size) : isTrigger ? 'ALL' : NO_VALUE,
            price: isTrigger
              ? tick(trigger)
              : order.price !== undefined
              ? tick(order.price)
              : NO_VALUE,
            type,
            status,
            // Only while a chase is actually running and working this order.
            // CHASE is checked first: it means this process is working the
            // order, which is a stronger claim than the exchange trailing it.
            managed:
              chaseOrderId && order.id === chaseOrderId
                ? 'CHASE'
                : waiting
                ? 'ARM'
                : tag?.kind === 'atr'
                ? 'ATR'
                : tag !== undefined || isTrailing
                ? 'TRAIL'
                : undefined,
            expires:
              chaseOrderId && order.id === chaseOrderId && chaseDeadline
                ? countdown(chaseDeadline)
                : undefined,
          };
        })),
      });
    } catch (error) {
      ActivityLog.getInstance().add('WARNING', `Could not refresh: ${(error as Error).message}`);
    }
  }
}
