// src/ui/workspace.ts
//
// Connects the terminal workspace to the exchange client: turns what the client
// knows into the view the screen renders, and keeps it current.

import { ExchangeClient } from '../exchange/exchangeClient.js';
import { ActivityLog } from './activityLog.js';
import { Screen } from './screen.js';
import { ConfirmationView, NO_VALUE, TerminalView } from './frame.js';
import { PositionRiskResult } from '../trading/positionRisk.js';
import { RANGE_WINDOWS } from '../trading/volatility.js';
import { describeOrders } from '../trading/orderView.js';

const FOOTER = [
  'buy',
  'sell',
  'chase',
  'limit',
  'trail',
  'cancel',
  'guard',
  'coach',
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

/**
 * Every period the panel will ever show, with nothing in it yet.
 *
 * The shell has to be the final shape from the first frame, so the columns come
 * from the window definitions rather than from whatever the exchange has
 * answered so far. Cells fill in individually as their timeframe arrives; one
 * slow or failed daily request leaves one column reading '--' instead of
 * withholding the whole block.
 */
const pendingRanges = (): TerminalView['ranges'] =>
  RANGE_WINDOWS.map(({ label }) => ({
    label,
    high: NO_VALUE,
    low: NO_VALUE,
    atr: NO_VALUE,
  }));

/** What has arrived, laid into the full set of columns. */
const mergeRanges = (
  measured: Array<{ label: string; high?: number; low?: number; atr?: number }>,
  tick: (value: unknown) => string
): TerminalView['ranges'] => {
  const byLabel = new Map(measured.map((range) => [range.label, range]));

  return RANGE_WINDOWS.map(({ label }) => {
    const range = byLabel.get(label);
    return {
      label,
      high: range?.high === undefined ? NO_VALUE : tick(range.high),
      low: range?.low === undefined ? NO_VALUE : tick(range.low),
      atr: range?.atr === undefined ? NO_VALUE : tick(range.atr),
    };
  });
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
    ranges: pendingRanges(),
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
    private onQuit: () => void,
    /**
     * A question typed at the coach prompt.
     *
     * Routed separately from the command line all the way down. The two
     * prompts mean different things and merging them anywhere -- including
     * here, where it would be convenient -- is how a question ends up being
     * parsed as an order.
     */
    private onCoach: (question: string) => Promise<void> = async () => {}
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

    this.screen = new Screen(view, this.onCommand, this.onQuit, this.onCoach);
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
    // The guardrails sweep for things no order is being placed about: a
    // position left unprotected, a day quietly giving back its profit.
    this.client.startGuardSweep();

    this.refreshTimer = setInterval(() => void this.refresh(), 2000);
    this.tickTimer = setInterval(() => this.tickCountdown(), 1000);
    void this.refresh();
  }

  /**
   * Puts an order in front of the operator, or takes the panel away.
   *
   * The confirmation panel replaces the position/orders block rather than
   * overlaying it, so there is no reading of a held order against a background
   * of numbers that are about to change. Passing null restores the block.
   */
  showConfirmation(confirmation: ConfirmationView | null): void {
    this.screen?.update({ confirmation });
  }

  /**
   * The coach thread and the standing guardrail conditions, as the panel takes
   * them.
   *
   * Pulled from the guard rather than pushed into the workspace, so the panel
   * cannot drift out of step with what the guard actually holds. Both are in
   * memory, so this costs nothing and is safe on the redraw path.
   */
  private coachState(): Pick<TerminalView, 'coach' | 'coachBusy' | 'guard'> {
    const guard = this.client.getGuard();
    const thread = guard.getThread();
    const active = guard.activeFindings();


    return {
      coach: thread.all().map(({ kind, text }) => ({ kind, text })),
      coachBusy: thread.busy(),
      guard: {
        count: active.length,
        // Behaviour ids rather than titles: the status line is read at a glance
        // and re-read all session, and the id is what `guard explain` takes.
        // Severity is named only when it is worth acting on.
        summary: active
          .map(({ finding }) =>
            finding.severity === 'notice'
              ? finding.behaviour.id
              : `${finding.behaviour.id} (${finding.severity})`
          )
          .join(', '),
      },
    };
  }

  /**
   * Repaints the coach panel now, for a change that must not wait for the
   * two-second refresh -- a question the operator just typed, or the answer
   * landing. Everything else arrives on the next cycle.
   */
  showCoach(): void {
    this.screen?.update(this.coachState());
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
    // The transcript says what was being traded while it was being said. A
    // conversation about sizing reads very differently against SOL than
    // against BTC, and the market is not in the words.
    this.client.getGuard().getThread().setSubject(market);
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
    this.client.stopGuardSweep();
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

      // Signed from the operator's side, so the panel can say whether the next
      // payment is money leaving or arriving rather than only how much it is.
      const signedNotional =
        position && position.notional !== undefined
          ? position.side === 'SHORT'
            ? -position.notional
            : position.notional
          : undefined;
      const cost = this.client.fundingCost(this.market, signedNotional);
      // The period stays on the value even though it is always a day: every
      // other figure in POSITION is a point-in-time reading, and a rate sitting
      // among them with no period reads as a total.
      const fundingCost = cost ? `${signed(cost.daily)}/24h` : undefined;

      this.screen.update({
        ...this.coachState(),
        header: this.header(),
        ranges: mergeRanges(ranges, tick),
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
              funding: fundingCost,
              fundingCurrency: cost?.currency,
            }
          : null,
        orders: (this.lastOrders = describeOrders(orders, {
          isTrailArmed: (id) => this.client.isTrailArmed(id),
          chaseOrderId,
        }).map((view) => ({
          id: view.id.slice(0, 8),
          side: view.side,
          // An order covering the whole position carries a quantity of zero.
          // 'ALL' says what that means; '0' reads as an empty order.
          qty: view.wholePosition
            ? 'ALL'
            : view.quantity !== undefined
              ? formatQuantity(view.quantity)
              : NO_VALUE,
          price:
            view.trigger !== undefined
              ? tick(view.trigger)
              : view.price !== undefined
                ? tick(view.price)
                : NO_VALUE,
          type: view.type,
          status: view.status,
          managed: view.managed,
          expires:
            view.managed === 'CHASE' && chaseDeadline ? countdown(chaseDeadline) : undefined,
        }))),
      });
    } catch (error) {
      ActivityLog.getInstance().add('WARNING', `Could not refresh: ${(error as Error).message}`);
    }
  }
}
