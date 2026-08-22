// src/ui/workspace.ts
//
// Connects the terminal workspace to the exchange client: turns what the client
// knows into the view the screen renders, and keeps it current.

import { ExchangeClient } from '../exchange/exchangeClient.js';
import { ActivityLog } from './activityLog.js';
import { Screen } from './screen.js';
import { NO_VALUE, TerminalView } from './frame.js';

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

    const symbol = this.market.split(':')[0];

    try {
      const [position, orders] = await Promise.all([
        this.client.getPositionView(this.market).catch(() => null),
        this.client.getOpenOrdersForDisplay(this.market).catch(() => []),
      ]);

      const price = await this.client.getDisplayPrice(this.market);

      this.screen.update({
        market: {
          symbol,
          last: dash(price.last),
          change: price.change ?? NO_VALUE,
          bid: dash(price.bid),
          ask: dash(price.ask),
          mark: NO_VALUE,
          index: NO_VALUE,
          funding: dash(price.funding),
          spread: dash(price.spread),
        },
        position: position
          ? {
              side: position.side || NO_VALUE,
              size: `${position.size}`,
              entry: position.entry !== undefined ? position.entry.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : NO_VALUE,
              mark: dash(price.last),
              unrealizedPnl:
                position.unrealizedPnl !== undefined
                  ? `${signed(position.unrealizedPnl)}${position.currency ? ` ${position.currency}` : ''}`
                  : NO_VALUE,
              realizedPnl:
                position.realizedPnl !== undefined
                  ? `${signed(position.realizedPnl)}${position.currency ? ` ${position.currency}` : ''}`
                  : NO_VALUE,
              leverage: dash(position.leverage, 'x'),
              liquidation: dash(position.liquidation),
            }
          : null,
        orders: orders.map((order) => {
          const info = (order as any).info ?? {};
          const trigger = (order as any).triggerPrice ?? info.stopPxRp ?? info.stopPxEp;
          const size = Number(order.remaining ?? order.amount ?? 0);
          const isTrigger = trigger !== undefined && Number(trigger) > 0;

          return {
            id: String(order.id ?? '').slice(0, 8),
            side: String(order.side ?? '').toUpperCase(),
            // A conditional order sized to the whole position carries a
            // quantity of zero; showing '0' reads as an empty order.
            qty: size > 0 ? String(size) : isTrigger ? 'POSITION' : NO_VALUE,
            price: isTrigger ? String(trigger) : String(order.price ?? NO_VALUE),
            status: isTrigger && !size ? 'STOP' : String(order.status ?? 'WORKING').toUpperCase(),
          };
        }),
      });
    } catch (error) {
      ActivityLog.getInstance().add('WARNING', `Could not refresh: ${(error as Error).message}`);
    }
  }
}
