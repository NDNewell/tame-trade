// src/ui/workspace.ts
//
// Connects the terminal workspace to the exchange client: turns what the client
// knows into the view the screen renders, and keeps it current.

import { ExchangeClient } from '../exchange/exchangeClient.js';
import { ActivityLog } from './activityLog.js';
import { Screen } from './screen.js';
import { NO_VALUE, TerminalView } from './frame.js';
import { PositionRiskResult } from '../trading/positionRisk.js';

const FOOTER = [
  'buy',
  'sell',
  'chase',
  'limit',
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
      symbol: NO_VALUE,
      instrumentType: '',
      account: NO_VALUE,
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
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private client: ExchangeClient,
    private onCommand: (command: string) => Promise<void>,
    private onQuit: () => void
  ) {}

  start(market: string): void {
    this.market = market;

    const view = emptyView();
    view.header.exchange = this.client.getSelectedExchangeName() ?? NO_VALUE;
    view.header.symbol = market;
    view.header.connection = 'CONNECTED';

    this.screen = new Screen(view, this.onCommand, this.onQuit);
    this.screen.start();

    ActivityLog.getInstance().add('SYSTEM', `Connected to ${view.header.exchange}`);
    if (market) {
      ActivityLog.getInstance().add('MARKET', `${market.split(':')[0]} selected`);
    }

    // The feeds push prices and order events; this refresh covers what only REST
    // can tell us, chiefly the position.
    this.refreshTimer = setInterval(() => void this.refresh(), 2000);
    void this.refresh();
  }

  setMarket(market: string): void {
    this.market = market;
    this.screen?.update({
      header: { ...emptyView().header, exchange: this.client.getSelectedExchangeName() ?? NO_VALUE, symbol: market, connection: 'CONNECTED' },
    });
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
    this.refreshTimer = null;
    this.screen?.stop();
    this.screen = null;
  }

  private async refresh(): Promise<void> {
    if (!this.screen || !this.market) return;

    // 'SOL/USDT' rather than 'SOL/USDT:USDT': the settlement suffix is exchange
    // notation and adds nothing once the market is named in the header.
    const symbol = this.market.split(':')[0];

    try {
      const [position, orders, risk] = await Promise.all([
        this.client.getPositionView(this.market).catch(() => null),
        this.client.getOpenOrdersForDisplay(this.market).catch(() => []),
        this.client.getPositionRisk(this.market).catch(() => undefined),
      ]);

      const price = await this.client.getDisplayPrice(this.market);

      // Quoted prices follow the instrument's tick, so the column doesn't mix
      // 95.1 with 94.59. Calculated values keep their own precision.
      const tick = (value: unknown): string =>
        value === undefined || value === null || value === ''
          ? NO_VALUE
          : this.client.formatPriceForDisplay(this.market, Number(value));

      const base = this.client.getBaseAsset(this.market);

      this.screen.update({
        market: {
          symbol,
          last: tick(price.last),
          change: price.change ?? NO_VALUE,
          bid: tick(price.bid),
          ask: tick(price.ask),
          mark: NO_VALUE,
          index: NO_VALUE,
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
              mark: tick(price.last),
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
              liquidation: dash(position.liquidation),
            }
          : null,
        orders: orders.map((order) => {
          const info = (order as any).info ?? {};
          const trigger = (order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp;
          const size = Number(order.remaining ?? order.amount ?? 0);
          const isTrigger = trigger !== undefined && Number(trigger) > 0;

          // What the order is, kept separate from where it is in its life. The
          // exchange conflates the two; the distinction is ours to present.
          const type = isTrigger
            ? 'STOP'
            : String(order.type ?? 'LIMIT').toUpperCase();

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
          };
        }),
      });
    } catch (error) {
      ActivityLog.getInstance().add('WARNING', `Could not refresh: ${(error as Error).message}`);
    }
  }
}
