// src/ui/frame.ts
//
// Renders the trading terminal workspace.
//
// The wireframe in docs/mockups/desktop-default.txt defines the intent: which
// regions exist, their order, what belongs in each, and the relative prominence
// of values. Dimensions come from the terminal, not the drawing — columns are
// derived from content widths and the rest is given to whatever should breathe.
//
// Colour is carried as spans over the character grid rather than embedded in the
// strings, so styling can never shift a column, and every coloured value keeps a
// textual label so colour is never the only carrier of meaning.

import { formatOutput as fo, Color } from '../utils/formatOutput.js';

/** Below this the desktop composition can't hold together. */
export const MIN_WIDTH = 72;
export const MIN_HEIGHT = 24;

/** Shown where the layout has a slot but the exchange gives us no value. */
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

export interface ConfirmationView {
  /** e.g. 'SELL MARKET' */
  action: string;
  size: string;
  estimatedValue: string;
  estimatedFee: string;
  warning: string;
  prompt: string;
}

export interface TerminalView {
  header: HeaderView;
  market: MarketView;
  position: PositionView | null;
  orders: OrderRowView[];
  chase: ChaseView | null;
  activity: ActivityRowView[];
  /**
   * When set, the confirmation panel takes the place of the position/orders
   * block. The header and market region stay visible: the price and the
   * position you already hold are exactly what you want in front of you while
   * deciding whether to send something large.
   */
  confirmation: ConfirmationView | null;
  input: string;
  footer: string[];
  footerRight: string;
}

export interface Size {
  width: number;
  height: number;
}

interface Span {
  col: number;
  length: number;
  color: Color;
}

class Line {
  private chars: string[];
  private spans: Span[] = [];

  constructor(private width: number, edges = true) {
    this.chars = new Array(width).fill(' ');
    if (edges) {
      this.chars[0] = '|';
      this.chars[width - 1] = '|';
    }
  }

  divider(col: number): this {
    if (col > 0 && col < this.width - 1) this.chars[col] = '|';
    return this;
  }

  put(col: number, text: string | undefined, color?: Color, limit?: number): this {
    if (text === undefined || text === null) return this;

    const stop = Math.min(limit ?? this.width - 1, this.width);
    const room = Math.max(0, stop - col);
    const clipped = String(text).slice(0, room);

    for (let i = 0; i < clipped.length; i++) this.chars[col + i] = clipped[i];
    if (color && clipped.length > 0) this.spans.push({ col, length: clipped.length, color });

    return this;
  }

  /** Right-aligns text so its last character sits at `end - 1`. */
  putRight(end: number, text: string | undefined, color?: Color, floor = 1): this {
    if (text === undefined || text === null) return this;
    const value = String(text);
    const col = Math.max(floor, end - value.length);
    return this.put(col, value.slice(0, end - col), color, end);
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
      if (span.col < cursor) continue;
      out += this.chars.slice(cursor, span.col).join('');
      out += fo(this.chars.slice(span.col, span.col + span.length).join(''), span.color);
      cursor = span.col + span.length;
    }

    return out + this.chars.slice(cursor).join('');
  }
}

const sideColor = (side: string): Color | undefined => {
  const value = side.trim().toUpperCase();
  if (value === 'BUY' || value === 'LONG') return 'green';
  if (value === 'SELL' || value === 'SHORT') return 'red';
  return undefined;
};

const signedColor = (value: string): Color | undefined => {
  const trimmed = value.trim();
  if (trimmed.startsWith('+')) return 'green';
  if (trimmed.startsWith('-') && trimmed !== NO_VALUE) return 'red';
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

/**
 * How the vertical space is divided.
 *
 * Fixed regions take what they need; the position/orders block and the activity
 * log share whatever is left, because those are the two that genuinely benefit
 * from more room.
 */
export function planHeight(height: number, hasChase: boolean) {
  const chaseRows = hasChase ? 4 : 0; // label + three rows
  const fixed =
    1 + // top border
    2 + // header
    1 + // border
    3 + // market label + two rows
    1 + // border
    1 + // border under the split block
    (hasChase ? chaseRows + 1 : 0) + // chase + its border
    1 + // border above command
    1 + // command entry
    1 + // border
    1 + // footer
    1; // bottom border

  const flexible = Math.max(0, height - fixed);

  // The position panel wants ten rows (label, gap, eight fields). Give it that
  // when there's room, and let activity take the remainder.
  const splitRows = Math.max(4, Math.min(10, flexible - 4));
  const activityRows = Math.max(1, flexible - splitRows - 1); // -1 for its label

  return { splitRows, activityRows };
}

/**
 * The confirmation panel, sized to fill the block it replaces.
 *
 * Labels sit left, values at a common column so the numbers line up and the size
 * can be compared against the value at a glance.
 */
function confirmationBlock(
  confirmation: ConfirmationView,
  width: number,
  rows: number
): Line[] {
  const inner = width - 1;
  const lines: Line[] = [];
  const valueCol = 20;

  const border = (): Line => {
    const line = new Line(width, false);
    line.put(0, '+' + '-'.repeat(width - 2) + '+', undefined, width);
    return line;
  };

  const body: Line[] = [
    new Line(width).put(2, 'CONFIRM ORDER', 'yellow'),
    new Line(width).put(2, confirmation.action, sideColor(confirmation.action.split(' ')[0])),
    new Line(width),
    new Line(width).put(2, 'Size', undefined, valueCol).put(valueCol, confirmation.size, undefined, inner),
    new Line(width)
      .put(2, 'Est. Value', undefined, valueCol)
      .put(valueCol, confirmation.estimatedValue, undefined, inner),
    new Line(width)
      .put(2, 'Est. Fee', undefined, valueCol)
      .put(valueCol, confirmation.estimatedFee, undefined, inner),
    new Line(width),
    new Line(width).put(2, confirmation.warning, 'yellow', inner),
    new Line(width).put(2, confirmation.prompt, 'yellow', inner),
  ];

  lines.push(border());
  for (let row = 0; row < Math.max(rows, body.length); row++) {
    if (body[row]) lines.push(body[row]);
    else if (row < rows) lines.push(new Line(width));
  }

  return lines;
}

function footerRow(view: TerminalView, width: number, inner: number): Line {
  const line = new Line(width);
  const right = view.footerRight ?? '';
  let col = 2;

  for (const command of view.footer) {
    if (col + command.length >= inner - right.length - 2) break;
    line.put(col, command, 'gray');
    col += command.length + 2;
  }

  line.putRight(inner - 1, right, 'gray', col);
  return line;
}

/**
 * Below this the side-by-side composition stops working and the stacked one
 * takes over: regions run full width, and the values that matter least are
 * dropped rather than squeezed.
 */
export const STACK_BELOW_WIDTH = 80;

function buildStackedFrame(view: TerminalView, size: Size): Line[] {
  const width = Math.max(MIN_WIDTH, size.width);
  const inner = width - 1;
  const lines: Line[] = [];
  const { header, market, position, orders, chase, activity } = view;

  const border = (): Line => {
    const line = new Line(width, false);
    line.put(0, '+' + '-'.repeat(width - 2) + '+', undefined, width);
    return line;
  };

  // Narrow keeps the values you trade on and drops the reference ones.
  const positionFields: Array<[string, string, Color | undefined]> = position
    ? [
        ['Side', position.side, sideColor(position.side)],
        ['Size', position.size, undefined],
        ['Entry', position.entry, undefined],
        ['Mark', position.mark, undefined],
        ['Unrealized PnL', position.unrealizedPnl, signedColor(position.unrealizedPnl)],
      ]
    : [];

  const orderRows = Math.min(orders.length, 3);
  const chaseRows = chase ? 4 : 0;
  const fixed =
    1 + 2 + 1 + 3 + 1 + // header + market
    (1 + Math.max(1, positionFields.length)) + 1 + // position
    (2 + Math.max(1, orderRows)) + 1 + // orders
    chaseRows +
    1 + 1 + 1 + 1 + 1; // activity label, command, borders, footer
  const activityRows = Math.max(1, Math.max(MIN_HEIGHT, size.height) - fixed - 1);

  lines.push(border());
  lines.push(
    new Line(width)
      .put(2, 'TRADING TERMINAL', undefined, inner - 22)
      .putRight(inner - 1, `${header.environment} | ${header.connection}`, undefined, 20)
      .put(
        inner - 1 - header.connection.length,
        header.connection,
        header.connection.toUpperCase() === 'CONNECTED' ? 'green' : 'red'
      )
  );
  lines.push(new Line(width).put(2, `${header.exchange} | ${header.symbol}`, undefined, inner));

  lines.push(border());
  lines.push(new Line(width).put(2, 'MARKET', 'gray'));
  lines.push(
    new Line(width)
      .put(2, market.symbol, 'white', 16)
      .put(16, market.last, 'white', 26)
      .put(26, market.change, signedColor(market.change), inner)
  );
  lines.push(
    new Line(width)
      .put(2, `Bid ${market.bid}`, undefined, 16)
      .put(16, `Ask ${market.ask}`, undefined, 30)
      .put(30, `Mark ${market.mark}`, undefined, 45)
      .put(45, `Spread ${market.spread}`, undefined, inner)
  );

  lines.push(border());
  lines.push(new Line(width).put(2, 'POSITION', 'gray'));
  if (positionFields.length === 0) {
    lines.push(new Line(width).put(2, 'No open position', 'gray', inner));
  } else {
    for (const [label, value, color] of positionFields) {
      lines.push(new Line(width).put(2, label, undefined, 19).put(19, value, color, inner));
    }
  }

  lines.push(border());
  lines.push(new Line(width).put(2, 'ACTIVE ORDERS', 'gray'));
  const c1 = 2, c2 = 10, c3 = 17, c4 = 24, c5 = 33;
  lines.push(
    new Line(width)
      .put(c1, 'ID', 'gray', c2)
      .put(c2, 'SIDE', 'gray', c3)
      .put(c3, 'QTY', 'gray', c4)
      .put(c4, 'PRICE', 'gray', c5)
      .put(c5, 'STATUS', 'gray', inner)
  );
  if (orderRows === 0) {
    lines.push(new Line(width).put(2, 'No active orders', 'gray', inner));
  } else {
    for (const order of orders.slice(0, orderRows)) {
      lines.push(
        new Line(width)
          .put(c1, order.id, undefined, c2)
          .put(c2, order.side, sideColor(order.side), c3)
          .put(c3, order.qty, undefined, c4)
          .put(c4, order.price, undefined, c5)
          .put(c5, order.status, statusColor(order.status), inner)
      );
    }
  }

  if (chase) {
    lines.push(border());
    lines.push(new Line(width).put(2, 'CHASE', 'gray'));
    lines.push(new Line(width).put(2, chase.side, sideColor(chase.side), 7).put(7, chase.quantity, undefined, inner));
    const summary = `Working ${chase.working} | Reprices ${chase.reprices} | ${chase.elapsed} | `;
    lines.push(
      new Line(width)
        .put(2, summary, undefined, inner)
        .put(Math.min(2 + summary.length, inner - 1), chase.status, statusColor(chase.status), inner)
    );
  }

  lines.push(border());
  lines.push(new Line(width).put(2, 'ACTIVITY', 'gray'));
  const visible = activity.slice(-activityRows);
  for (let row = 0; row < activityRows; row++) {
    const line = new Line(width);
    const event = visible[row];
    if (event) {
      line
        .put(2, event.time, 'gray', 11)
        .put(11, event.category, categoryColor(event.category), 18)
        .put(18, event.message, undefined, inner);
    }
    lines.push(line);
  }

  lines.push(border());
  lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, undefined, inner));

  lines.push(border());
  const footerLine = new Line(width);
  let col = 2;
  for (const command of view.footer) {
    if (col + command.length >= inner - 1) break;
    footerLine.put(col, command, 'gray');
    col += command.length + 1;
  }
  if (col + view.footerRight.length < inner) footerLine.put(col, view.footerRight, 'gray');
  lines.push(footerLine);

  lines.push(border());
  return lines;
}

export function buildFrame(view: TerminalView, size: Size): Line[] {
  if (size.width < STACK_BELOW_WIDTH) return buildStackedFrame(view, size);
  return buildWideFrame(view, size);
}

function buildWideFrame(view: TerminalView, size: Size): Line[] {
  const width = Math.max(MIN_WIDTH, size.width);
  const inner = width - 1;
  const divider = Math.floor(width / 2);
  const lines: Line[] = [];
  const { header, market, position, orders, chase, activity } = view;

  const border = (withDivider = false): Line => {
    const line = new Line(width, false);
    line.put(0, '+' + '-'.repeat(width - 2) + '+', undefined, width);
    if (withDivider) line.put(divider, '+', undefined, width);
    return line;
  };

  const { splitRows, activityRows } = planHeight(
    Math.max(MIN_HEIGHT, size.height),
    chase !== null
  );

  // --- header: identity on the left, connection state on the right ------
  lines.push(border());

  const connectionText = `${header.environment} | ${header.connection}`;
  lines.push(
    new Line(width)
      .put(2, 'TRADING TERMINAL')
      .putRight(inner - 1, connectionText, undefined, 20)
      .put(
        inner - 1 - header.connection.length,
        header.connection,
        header.connection.toUpperCase() === 'CONNECTED' ? 'green' : 'red'
      )
  );

  const context = [header.exchange, header.symbol, header.instrumentType]
    .filter((part) => part && part.length > 0)
    .join(' | ');
  lines.push(
    new Line(width)
      .put(2, context, undefined, inner - 20)
      .putRight(inner - 1, `Account: ${header.account}`, undefined, inner - 20)
  );

  // --- market: symbol and last price lead, the rest supports -------------
  lines.push(border());
  lines.push(new Line(width).put(2, 'MARKET', 'gray'));

  lines.push(
    new Line(width)
      .put(2, market.symbol, 'white', 20)
      .put(20, market.last, 'white', 34)
      .put(34, market.change, signedColor(market.change), 46)
      .put(46, `Bid ${market.bid}`, undefined, Math.floor(inner * 0.8))
      .putRight(inner - 1, `Ask ${market.ask}`, undefined, Math.floor(inner * 0.8))
  );

  lines.push(
    new Line(width)
      .put(2, `Mark ${market.mark}`, undefined, 20)
      .put(20, `Index ${market.index}`, undefined, 46)
      .put(46, `Funding ${market.funding}`, undefined, Math.floor(inner * 0.82))
      .putRight(inner - 1, `Spread ${market.spread}`, undefined, Math.floor(inner * 0.82))
  );

  // --- confirmation takes the place of position/orders when pending --------
  if (view.confirmation) {
    lines.push(...confirmationBlock(view.confirmation, width, splitRows + 1));
    lines.push(border());
    lines.push(new Line(width).put(2, 'ACTIVITY', 'gray'));
    const pending = activity.slice(-activityRows);
    for (let row = 0; row < activityRows; row++) {
      const line = new Line(width);
      const event = pending[row];
      if (event) {
        line
          .put(2, event.time, 'gray', 11)
          .put(12, event.category, categoryColor(event.category), 20)
          .put(21, event.message, undefined, inner);
      }
      lines.push(line);
    }
    lines.push(border());
    lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, undefined, inner));
    lines.push(border());
    lines.push(footerRow(view, width, inner));
    lines.push(border());
    return lines;
  }

  // --- position | active orders -----------------------------------------
  lines.push(border(true));
  lines.push(
    new Line(width).divider(divider).put(2, 'POSITION', 'gray').put(divider + 2, 'ACTIVE ORDERS', 'gray')
  );

  const positionFields: Array<[string, string, Color | undefined]> = position
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

  // Order columns are anchored from the right edge, so status and price — the
  // values that matter when scanning — keep their room and the order id gives up
  // width first as the panel narrows.
  const oStatus = inner - 7;
  const oPrice = oStatus - 8;
  const oQty = oPrice - 6;
  const oSide = oQty - 5;
  const oId = divider + 2;

  const valueCol = 19;
  const bodyRows = Math.max(1, splitRows - 1); // first row of the block is a gap

  for (let row = 0; row < bodyRows; row++) {
    const line = new Line(width).divider(divider);

    if (row === 0) {
      line
        .put(oId, 'ID', 'gray', oSide)
        .put(oSide, 'SIDE', 'gray', oQty)
        .put(oQty, 'QTY', 'gray', oPrice)
        .put(oPrice, 'PRICE', 'gray', oStatus)
        .put(oStatus, 'STATUS', 'gray');
    } else {
      const order = orders[row - 1];
      if (order) {
        line
          .put(oId, order.id, undefined, oSide)
          .put(oSide, order.side, sideColor(order.side), oQty)
          .put(oQty, order.qty, undefined, oPrice)
          .put(oPrice, order.price, undefined, oStatus)
          .put(oStatus, order.status, statusColor(order.status));
      } else if (row === 1 && orders.length === 0) {
        line.put(oId, 'No active orders', 'gray', divider + Math.floor(width / 2) - 2);
      }
    }

    const field = positionFields[row];
    if (field) {
      line.put(2, field[0], undefined, valueCol).put(valueCol, field[1], field[2], divider);
    } else if (row === 0 && !position) {
      line.put(2, 'No open position', 'gray', divider);
    }

    lines.push(line);
  }

  // --- chase: only present while one is running --------------------------
  if (chase) {
    lines.push(border());
    lines.push(new Line(width).put(2, 'CHASE', 'gray'));
    lines.push(
      new Line(width).put(2, chase.side, sideColor(chase.side), 7).put(7, chase.quantity)
    );

    const q1 = 2;
    const q2 = Math.floor(inner * 0.34);
    const q3 = Math.floor(inner * 0.58);
    const q4 = Math.floor(inner * 0.80);
    lines.push(
      new Line(width)
        .put(q1, 'Target', undefined, q1 + 11)
        .put(q1 + 12, chase.target, undefined, q2)
        .put(q2, 'Working', undefined, q2 + 8)
        .put(q2 + 8, chase.working, undefined, q3)
        .put(q3, 'Reprices', undefined, q3 + 9)
        .put(q3 + 9, chase.reprices, undefined, q4)
        .put(q4, 'Elapsed', undefined, q4 + 8)
        .put(q4 + 8, chase.elapsed)
    );
    lines.push(
      new Line(width).put(2, 'Status').put(14, chase.status, statusColor(chase.status))
    );
  }

  // --- activity ----------------------------------------------------------
  lines.push(border());
  lines.push(new Line(width).put(2, 'ACTIVITY', 'gray'));

  const visible = activity.slice(-activityRows);
  for (let row = 0; row < activityRows; row++) {
    const line = new Line(width);
    const event = visible[row];

    if (event) {
      line
        .put(2, event.time, 'gray', 11)
        .put(12, event.category, categoryColor(event.category), 20)
        .put(21, event.message, undefined, inner);
    }

    lines.push(line);
  }

  // --- command entry, kept fixed so activity never moves it --------------
  lines.push(border());
  lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, undefined, inner));

  // --- footer ------------------------------------------------------------
  lines.push(border());

  const footerLine = new Line(width);
  const right = view.footerRight ?? '';
  let col = 2;
  for (const command of view.footer) {
    if (col + command.length >= inner - right.length - 2) break;
    footerLine.put(col, command, 'gray');
    col += command.length + 2;
  }
  footerLine.putRight(inner - 1, right, 'gray', col);
  lines.push(footerLine);

  lines.push(border());

  return lines;
}

export function renderPlain(view: TerminalView, size: Size): string[] {
  return buildFrame(view, size).map((line) => line.plain());
}

export function renderPainted(view: TerminalView, size: Size): string[] {
  return buildFrame(view, size).map((line) => line.painted());
}
