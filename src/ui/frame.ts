// src/ui/frame.ts
//
// Renders the trading terminal workspace.
//
// Every column position here is taken from the approved ASCII mockup rather than
// chosen. The frame is a fixed 80x40 grid: the mockup's border rows put the
// vertical divider at column 40 and the frame edges at 0 and 79.
//
// Colour is carried as spans over the character grid rather than embedded in the
// strings, so styling can never move a column.

import { formatOutput as fo, Color } from '../utils/formatOutput.js';

export const FRAME_WIDTH = 80;
export const FRAME_HEIGHT = 40;
export const DIVIDER_COL = 40;

/** Shown where a value exists in the layout but the exchange gives us nothing. */
export const NO_VALUE = '-';

export interface HeaderView {
  environment: string;
  connection: string;
  exchange: string;
  symbol: string;
  instrumentType: string;
  account: string;
}

export interface MarketView {
  symbol: string;
  last: string;
  change: string;
  bid: string;
  ask: string;
  mark: string;
  index: string;
  funding: string;
  spread: string;
}

export interface PositionView {
  side: string;
  size: string;
  entry: string;
  mark: string;
  unrealizedPnl: string;
  realizedPnl: string;
  leverage: string;
  liquidation: string;
}

export interface OrderRowView {
  id: string;
  side: string;
  qty: string;
  price: string;
  status: string;
}

export interface ChaseView {
  side: string;
  quantity: string;
  target: string;
  working: string;
  reprices: string;
  elapsed: string;
  status: string;
}

export interface ActivityRowView {
  time: string;
  category: string;
  message: string;
}

export interface TerminalView {
  header: HeaderView;
  market: MarketView;
  position: PositionView | null;
  orders: OrderRowView[];
  chase: ChaseView | null;
  activity: ActivityRowView[];
  input: string;
  footer: string[];
  footerRight: string;
}

interface Span {
  col: number;
  length: number;
  color: Color;
}

// A single row of the frame: a character grid plus the colour spans over it.
class Line {
  private chars: string[] = new Array(FRAME_WIDTH).fill(' ');
  private spans: Span[] = [];

  constructor(edges = true) {
    if (edges) {
      this.chars[0] = '|';
      this.chars[FRAME_WIDTH - 1] = '|';
    }
  }

  divider(): this {
    this.chars[DIVIDER_COL] = '|';
    return this;
  }

  // Writes `text` at `col`, clipped so it can never run past `limit` and break
  // the frame. Returns this for chaining.
  put(col: number, text: string, color?: Color, limit = FRAME_WIDTH - 1): this {
    if (text === undefined || text === null) return this;

    const room = Math.max(0, limit - col);
    const clipped = String(text).slice(0, room);

    for (let i = 0; i < clipped.length; i++) {
      this.chars[col + i] = clipped[i];
    }

    if (color && clipped.length > 0) {
      this.spans.push({ col, length: clipped.length, color });
    }

    return this;
  }

  plain(): string {
    return this.chars.join('');
  }

  painted(): string {
    if (this.spans.length === 0) return this.plain();

    const ordered = [...this.spans].sort((a, b) => a.col - b.col);
    let out = '';
    let cursor = 0;

    for (const span of ordered) {
      if (span.col < cursor) continue; // overlapping spans: first one wins
      out += this.chars.slice(cursor, span.col).join('');
      out += fo(this.chars.slice(span.col, span.col + span.length).join(''), span.color);
      cursor = span.col + span.length;
    }

    return out + this.chars.slice(cursor).join('');
  }
}

const border = (withDivider = false): Line => {
  const line = new Line(false);
  const chars = '+' + '-'.repeat(FRAME_WIDTH - 2) + '+';
  line.put(0, chars, undefined, FRAME_WIDTH);
  if (withDivider) line.put(DIVIDER_COL, '+', undefined, FRAME_WIDTH);
  return line;
};

// Semantic colours. Textual labels always remain, so colour is never the only
// carrier of meaning.
const sideColor = (side: string): Color | undefined => {
  const value = side.trim().toUpperCase();
  if (value === 'BUY' || value === 'LONG') return 'green';
  if (value === 'SELL' || value === 'SHORT') return 'red';
  return undefined;
};

const signedColor = (value: string): Color | undefined => {
  const trimmed = value.trim();
  if (trimmed.startsWith('+')) return 'green';
  if (trimmed.startsWith('-')) return 'red';
  return undefined;
};

const statusColor = (status: string): Color | undefined => {
  switch (status.trim().toUpperCase()) {
    case 'FILLED':
      return 'green';
    case 'WORKING':
    case 'TRACKING':
    case 'PARTIAL':
      return 'yellow';
    case 'REJECTED':
      return 'red';
    case 'CANCELLED':
    case 'CANCELED':
      return 'gray';
    default:
      return undefined;
  }
};

const categoryColor = (category: string): Color | undefined => {
  switch (category.trim().toUpperCase()) {
    case 'FILL':
      return 'green';
    case 'ERROR':
      return 'red';
    case 'WARNING':
      return 'yellow';
    case 'ORDER':
      return 'cyan';
    case 'MARKET':
      return 'blue';
    case 'SYSTEM':
      return 'gray';
    default:
      return undefined;
  }
};

export function buildFrame(view: TerminalView): Line[] {
  const lines: Line[] = [];
  const { header, market, position, orders, chase, activity } = view;

  // --- header ------------------------------------------------------------
  lines.push(border());

  lines.push(
    new Line()
      .put(2, 'TRADING TERMINAL')
      .put(59, header.environment, 'cyan')
      .put(64, '|')
      .put(66, header.connection, header.connection.toUpperCase() === 'CONNECTED' ? 'green' : 'red')
  );

  lines.push(
    new Line()
      .put(2, header.exchange, undefined, 9)
      .put(9, '|')
      .put(11, header.symbol, undefined, 25)
      .put(25, '|')
      .put(27, header.instrumentType, undefined, 57)
      .put(57, 'Account:')
      .put(66, header.account)
  );

  // --- market ------------------------------------------------------------
  lines.push(border());
  lines.push(new Line().put(2, 'MARKET', 'gray'));

  lines.push(
    new Line()
      .put(2, market.symbol, 'white', 20)
      .put(20, market.last, 'white', 34)
      .put(34, market.change, signedColor(market.change), 47)
      .put(47, 'Bid')
      .put(51, market.bid, undefined, 64)
      .put(64, 'Ask')
      .put(68, market.ask)
  );

  lines.push(
    new Line()
      .put(2, 'Mark')
      .put(7, market.mark, undefined, 20)
      .put(20, 'Index')
      .put(26, market.index, undefined, 48)
      .put(48, 'Funding')
      .put(56, market.funding, undefined, 66)
      .put(66, 'Spread')
      .put(73, market.spread)
  );

  // --- position / active orders -----------------------------------------
  lines.push(border(true));

  lines.push(
    new Line()
      .divider()
      .put(2, 'POSITION', 'gray')
      .put(42, 'ACTIVE ORDERS', 'gray')
  );

  lines.push(new Line().divider());

  const positionRows: Array<[string, string, Color | undefined]> = position
    ? [
        ['Side', position.side, sideColor(position.side)],
        ['Size', position.size, undefined],
        ['Entry', position.entry, undefined],
        ['Mark', position.mark, undefined],
        ['Unrealized PnL', position.unrealizedPnl, signedColor(position.unrealizedPnl)],
        ['Realized PnL', position.realizedPnl, signedColor(position.realizedPnl)],
        ['Leverage', position.leverage, undefined],
        ['Liquidation', position.liquidation, undefined],
      ]
    : [];

  // The right panel's first row is the column header; orders begin beneath it.
  const orderHeader = new Line()
    .put(41, 'ID')
    .put(50, 'SIDE')
    .put(57, 'QTY')
    .put(64, 'PRICE')
    .put(72, 'STATUS');

  for (let row = 0; row < 8; row++) {
    const line = row === 0 ? orderHeader : new Line();
    line.divider();

    const field = positionRows[row];
    if (field) {
      line.put(2, field[0], undefined, 19).put(19, field[1], field[2], DIVIDER_COL);
    }

    if (row > 0) {
      const order = orders[row - 1];
      if (order) {
        line
          .put(41, order.id, undefined, 50)
          .put(50, order.side, sideColor(order.side), 57)
          .put(57, order.qty, undefined, 64)
          .put(64, order.price, undefined, 72)
          .put(72, order.status, statusColor(order.status));
      }
    }

    lines.push(line);
  }

  // --- chase -------------------------------------------------------------
  lines.push(border(true));
  lines.push(new Line().put(2, 'CHASE', 'gray'));

  if (chase) {
    lines.push(
      new Line()
        .put(2, chase.side, sideColor(chase.side), 7)
        .put(7, chase.quantity)
    );
    lines.push(
      new Line()
        .put(2, 'Target')
        .put(14, chase.target, undefined, 28)
        .put(28, 'Working')
        .put(36, chase.working, undefined, 48)
        .put(48, 'Reprices')
        .put(57, chase.reprices, undefined, 65)
        .put(65, 'Elapsed')
        .put(73, chase.elapsed)
    );
    lines.push(new Line().put(2, 'Status').put(14, chase.status, statusColor(chase.status)));
  } else {
    lines.push(new Line());
    lines.push(new Line());
    lines.push(new Line());
  }

  // --- activity ----------------------------------------------------------
  lines.push(border());
  lines.push(new Line().put(2, 'ACTIVITY', 'gray'));

  for (let row = 0; row < 10; row++) {
    const line = new Line();
    const event = activity[row];

    if (event) {
      line
        .put(2, event.time, 'gray', 12)
        .put(12, event.category, categoryColor(event.category), 21)
        .put(21, event.message, undefined, FRAME_WIDTH - 1);
    }

    lines.push(line);
  }

  // --- command entry -----------------------------------------------------
  lines.push(border());
  lines.push(new Line().put(2, '>', 'cyan').put(4, view.input));

  // --- footer ------------------------------------------------------------
  lines.push(border());

  const footerLine = new Line();
  const footerColumns = [2, 7, 13, 20, 27, 35, 43, 54, 62];
  view.footer.slice(0, footerColumns.length).forEach((command, index) => {
    footerLine.put(footerColumns[index], command, 'gray', footerColumns[index + 1] ?? 72);
  });
  footerLine.put(72, view.footerRight, 'gray');
  lines.push(footerLine);

  lines.push(border());

  return lines;
}

export function renderPlain(view: TerminalView): string[] {
  return buildFrame(view).map((line) => line.plain());
}

export function renderPainted(view: TerminalView): string[] {
  return buildFrame(view).map((line) => line.painted());
}
