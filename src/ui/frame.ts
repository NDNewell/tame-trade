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

/**
 * The single representation for a value that is unavailable, unloaded or not
 * applicable. Deliberately two characters so it cannot be mistaken for the minus
 * sign of a negative number: '-2.13' is a value, '--' is the absence of one.
 */
export const NO_VALUE = '--';

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
  /** Planned downside to the protective stops. */
  risk: string;
  /** Shorter form, used when the panel can't fit the full one. */
  riskShort?: string;
  leverage: string;
  /** What the position is actually levered at now, as against the setting. */
  effectiveLeverage: string;
  liquidation: string;
}

export interface OrderRowView {
  id: string;
  side: string;
  qty: string;
  price: string;
  /** What the order is: LIMIT, STOP, MARKET. */
  type: string;
  /** Where it is in its life: WORKING, PARTIAL, FILLED, CANCELLED, REJECTED. */
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
  /** Present on trade events; renders as columns rather than prose. */
  detail?: {
    side?: string;
    quantity?: string;
    price?: string;
    status?: string;
  };
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
  /**
   * How far the activity region is scrolled back from the newest event. Zero
   * follows the tail.
   */
  activityOffset?: number;
  footer: string[];
  footerRight: string;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Box-drawing characters, if the environment can render them. A terminal that
 * can't would show replacement glyphs and break every column, so ASCII stays the
 * fallback rather than the risk being taken.
 */
const canRenderUnicode = (): boolean => {
  const term = process.env.TERM ?? '';
  if (term === '' || term === 'dumb') return false;

  const encoding = `${process.env.LC_ALL ?? ''}${process.env.LC_CTYPE ?? ''}${process.env.LANG ?? ''}`;
  return /UTF-?8/i.test(encoding);
};

interface BoxChars {
  h: string; v: string;
  tl: string; tr: string; bl: string; br: string;
  teeDown: string; teeUp: string; teeLeft: string; teeRight: string;
}

const UNICODE_BOX: BoxChars = {
  h: '─', v: '│',
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  teeDown: '┬', teeUp: '┴', teeLeft: '┤', teeRight: '├',
};

const ASCII_BOX: BoxChars = {
  h: '-', v: '|',
  tl: '+', tr: '+', bl: '+', br: '+',
  teeDown: '+', teeUp: '+', teeLeft: '+', teeRight: '+',
};

const box: BoxChars = canRenderUnicode() ? UNICODE_BOX : ASCII_BOX;

/**
 * (5) Three levels of prominence, so headings are findable without competing
 * with the numbers: muted for metadata and empty states, plain white for
 * section headings, bright for the values actually being traded on.
 */
const MUTED: Color = 'gray';
const HEADING_COLOR: Color = 'white';
const PRIMARY: Color = 'brightWhite';

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
      this.chars[0] = box.v;
      this.chars[width - 1] = box.v;
    }
  }

  divider(col: number): this {
    if (col > 0 && col < this.width - 1) this.chars[col] = box.v;
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
    // Active and healthy: the accent, not the warning colour.
    case 'WORKING':
    case 'TRACKING':
      return 'cyan';
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
  const splitRows = Math.max(4, Math.min(12, flexible - 4));
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
  const valueCol = 21;

  const border = (edge?: 'top' | 'bottom'): Line => {
    const left = edge === 'top' ? box.tl : edge === 'bottom' ? box.bl : box.teeRight;
    const right = edge === 'top' ? box.tr : edge === 'bottom' ? box.br : box.teeLeft;
    const line = new Line(width, false);
    line.put(0, left + box.h.repeat(width - 2) + right, undefined, width);
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

/** The slice of activity to show, given how far back the view is scrolled. */
function windowActivity(
  activity: ActivityRowView[],
  rows: number,
  offset: number
): ActivityRowView[] {
  const maxOffset = Math.max(0, activity.length - rows);
  const back = Math.min(Math.max(0, offset), maxOffset);
  const end = activity.length - back;
  return activity.slice(Math.max(0, end - rows), end);
}

/**
 * (11)(12)(15) An activity row.
 *
 * Trade events are laid out in fixed columns so they can be scanned rather than
 * read. The event type says what happened and the side carries the direction
 * colour -- colouring a whole FILL row green would make a sell fill look like a
 * buy, which is the one thing a trader must never misread.
 *
 * Events without structured data keep their message, rather than being padded
 * with placeholders into a shape they don't have.
 */
function activityRow(
  event: ActivityRowView,
  width: number,
  inner: number
): Line {
  const line = new Line(width);
  const cTime = 2;
  const cEvent = 18;
  const cSide = 26;
  const cQty = 32;
  const cPrice = 43;
  const cStatus = 54;

  line
    .put(cTime, event.time, MUTED, cEvent)
    .put(cEvent, event.category, categoryColor(event.category), cSide);

  const detail = event.detail;
  if (!detail) {
    line.put(cSide, event.message, undefined, inner);
    return line;
  }

  if (detail.side) line.put(cSide, detail.side, sideColor(detail.side), cQty);
  if (detail.quantity) line.putRight(cPrice - 2, detail.quantity, undefined, cQty);
  if (detail.price) line.putRight(cStatus - 2, detail.price, undefined, cPrice);
  if (detail.status) line.put(cStatus, detail.status, statusColor(detail.status), inner);

  // Anything the columns don't cover follows them rather than being lost.
  if (event.message) {
    const after = detail.status ? cStatus + detail.status.length + 2 : cStatus;
    line.put(after, event.message, MUTED, inner);
  }

  return line;
}

function activityLabel(view: TerminalView, width: number, rows: number): Line {
  const line = new Line(width).put(2, 'ACTIVITY', HEADING_COLOR);
  const offset = view.activityOffset ?? 0;

  if (offset > 0) {
    const behind = Math.min(offset, Math.max(0, view.activity.length - rows));
    line.put(12, `scrolled back ${behind}`, 'yellow', width - 2);
  }

  return line;
}

/** Commands that place or withdraw orders, as opposed to ones that only look. */
const EXECUTION_COMMANDS = new Set(['buy', 'sell', 'chase', 'limit', 'cancel']);

function footerRow(view: TerminalView, width: number, inner: number): Line {
  const line = new Line(width);
  const right = view.footerRight ?? '';
  let col = 2;
  let crossed = false;

  for (const command of view.footer) {
    // A wider gap where the list stops being about acting on the market and
    // starts being about looking at it. Whitespace does the grouping; no labels
    // are needed to say so.
    if (!crossed && !EXECUTION_COMMANDS.has(command)) {
      col += 4;
      crossed = true;
    }

    if (col + command.length >= inner - right.length - 2) break;
    line.put(col, command, MUTED);
    col += command.length + 2;
  }

  line.putRight(inner - 1, right, MUTED, col);
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

  const border = (edge?: 'top' | 'bottom'): Line => {
    const left = edge === 'top' ? box.tl : edge === 'bottom' ? box.bl : box.teeRight;
    const right = edge === 'top' ? box.tr : edge === 'bottom' ? box.br : box.teeLeft;
    const line = new Line(width, false);
    line.put(0, left + box.h.repeat(width - 2) + right, undefined, width);
    return line;
  };

  // Narrow keeps the values you trade on and drops the reference ones.
  const riskRoom = inner - 19 - 1;
  const riskValue = position
    ? position.risk.length <= riskRoom
      ? position.risk
      : position.riskShort ?? position.risk
    : '';
  const riskColor: Color | undefined = !position
    ? undefined
    : position.risk === NO_VALUE || position.risk.startsWith(NO_VALUE)
    ? MUTED
    : position.risk.startsWith('0.00')
    ? undefined
    : 'yellow';

  const positionFields: Array<[string, string, Color | undefined]> = position
    ? [
        ['Side', position.side, sideColor(position.side)],
        ['Size', position.size, undefined],
        ['Entry', position.entry, undefined],
        ['Mark', position.mark, undefined],
        ['Unrealized PnL', position.unrealizedPnl, signedColor(position.unrealizedPnl)],
        ['Position Risk', riskValue, riskColor],
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
  lines.push(new Line(width).put(2, 'MARKET', HEADING_COLOR));
  lines.push(
    new Line(width)
      .put(2, market.symbol, HEADING_COLOR, 16)
      .put(16, market.last, PRIMARY, 26)
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
  lines.push(new Line(width).put(2, 'POSITION', HEADING_COLOR));
  if (positionFields.length === 0) {
    lines.push(new Line(width).put(2, 'No open position', MUTED, inner));
  } else {
    for (const [label, value, color] of positionFields) {
      lines.push(new Line(width).put(2, label, undefined, 19).put(19, value, color, inner));
    }
  }

  lines.push(border());
  lines.push(new Line(width).put(2, 'ACTIVE ORDERS', HEADING_COLOR));
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
    lines.push(new Line(width).put(2, 'No active orders', MUTED, inner));
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
    lines.push(new Line(width).put(2, 'CHASE', HEADING_COLOR));
    lines.push(new Line(width).put(2, chase.side, sideColor(chase.side), 7).put(7, chase.quantity, undefined, inner));
    const summary = `Working ${chase.working} | Reprices ${chase.reprices} | ${chase.elapsed} | `;
    lines.push(
      new Line(width)
        .put(2, summary, undefined, inner)
        .put(Math.min(2 + summary.length, inner - 1), chase.status, statusColor(chase.status), inner)
    );
  }

  lines.push(border());
  lines.push(activityLabel(view, width, activityRows));
  const visible = windowActivity(activity, activityRows, view.activityOffset ?? 0);
  for (let row = 0; row < activityRows; row++) {
    const line = new Line(width);
    const event = visible[row];
    if (event) {
      line
        .put(2, event.time.slice(0, 11), 'gray', 14)
        .put(14, event.category, categoryColor(event.category), 21)
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

  const border = (
    opts: { edge?: 'top' | 'bottom'; divider?: 'down' | 'up' } = {}
  ): Line => {
    const left = opts.edge === 'top' ? box.tl : opts.edge === 'bottom' ? box.bl : box.teeRight;
    const right = opts.edge === 'top' ? box.tr : opts.edge === 'bottom' ? box.br : box.teeLeft;

    const line = new Line(width, false);
    line.put(0, left + box.h.repeat(width - 2) + right, undefined, width);

    if (opts.divider) {
      line.put(divider, opts.divider === 'down' ? box.teeDown : box.teeUp, undefined, width);
    }

    return line;
  };

  const { splitRows, activityRows } = planHeight(
    Math.max(MIN_HEIGHT, size.height),
    chase !== null
  );

  // --- header: identity on the left, connection state on the right ------
  lines.push(border({ edge: 'top' }));

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
  lines.push(new Line(width).put(2, 'MARKET', HEADING_COLOR));

  // Four evenly spaced columns, so the primary and secondary rows line up with
  // each other and every value keeps a fixed starting position.
  const span = Math.max(16, Math.floor((inner - 18) / 4));
  const col1 = 18;
  const col2 = col1 + span;
  const col3 = col2 + span;
  const col4 = col3 + span;

  const field = (line: Line, col: number, label: string, value: string, limit: number) =>
    line
      .put(col, label, MUTED, col + label.length + 1)
      .put(col + label.length + 1, value, undefined, limit);

  const primaryRow = new Line(width).put(2, market.symbol, HEADING_COLOR, col1);
  primaryRow
    .put(col1, 'Last', MUTED, col1 + 5)
    .put(col1 + 5, market.last, PRIMARY, col2);
  field(primaryRow, col2, 'Bid', market.bid, col3);
  field(primaryRow, col3, 'Ask', market.ask, col4);
  if (market.change && market.change !== NO_VALUE) {
    primaryRow
      .put(col4, '24h', MUTED, col4 + 4)
      .put(col4 + 4, market.change, signedColor(market.change), inner);
  }
  lines.push(primaryRow);

  const secondaryRow = new Line(width);
  field(secondaryRow, 2, 'Mark', market.mark, col1);
  field(secondaryRow, col1, 'Index', market.index, col2);
  field(secondaryRow, col2, 'Funding', market.funding, col3);
  field(secondaryRow, col3, 'Spread', market.spread, col4);
  lines.push(secondaryRow);

  // --- confirmation takes the place of position/orders when pending --------
  if (view.confirmation) {
    lines.push(...confirmationBlock(view.confirmation, width, splitRows + 1));
    lines.push(border());
    lines.push(new Line(width).put(2, 'ACTIVITY', HEADING_COLOR));
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
  lines.push(border({ divider: 'down' }));
  lines.push(
    new Line(width).divider(divider).put(2, 'POSITION', HEADING_COLOR).put(divider + 2, 'ACTIVE ORDERS', HEADING_COLOR)
  );

  // The full form is preferred; the short one is used only when the panel can't
  // hold it, so an unprotected quantity is never silently cut off.
  const riskRoom = divider - 21 - 1;
  const riskValue = position
    ? position.risk.length <= riskRoom
      ? position.risk
      : position.riskShort ?? position.risk
    : '';
  const riskColor: Color | undefined = !position
    ? undefined
    : position.risk === NO_VALUE || position.risk.startsWith(NO_VALUE)
    ? MUTED
    : position.risk.startsWith('0.00')
    ? undefined
    : 'yellow';

  const positionFields: Array<[string, string, Color | undefined]> = position
    ? [
        ['Side', position.side, sideColor(position.side)],
        ['Size', position.size, undefined],
        ['Entry', position.entry, undefined],
        ['Mark', position.mark, undefined],
        ['Unrealized PnL', position.unrealizedPnl, signedColor(position.unrealizedPnl)],
        ['Realized PnL', position.realizedPnl, signedColor(position.realizedPnl)],
        // Risk is not profit: a positive number here is exposure, so it takes
        // the warning treatment rather than the green a positive PnL earns.
        ['Position Risk', riskValue, riskColor],
        ['Leverage', position.leverage, undefined],
        ['Effective Leverage', position.effectiveLeverage, undefined],
        ['Liquidation', position.liquidation, undefined],
      ]
    : [];

  // Columns run left to right across the panel. Widths come from the space
  // available, and the order id gives up room first: it identifies an order but
  // you don't trade on it, whereas side, size, price, type and status are what
  // you read when deciding whether to act.
  const panelStart = divider + 2;
  const panelWidth = Math.max(20, inner - panelStart);
  const fixed = 5 + 8 + 9 + 7 + 8; // side, qty, price, type, status
  const idWidth = Math.max(0, Math.min(10, panelWidth - fixed));

  const oId = panelStart;
  const oSide = oId + idWidth;
  const oQty = oSide + 5;
  const oPrice = oQty + 8;
  const oType = oPrice + 9;
  const oStatus = oType + 7;

  const valueCol = 21;
  const bodyRows = Math.max(1, splitRows - 1); // first row of the block is a gap

  for (let row = 0; row < bodyRows; row++) {
    const line = new Line(width).divider(divider);

    if (row === 0) {
      if (idWidth > 0) line.put(oId, 'ID', MUTED, oSide - 1);
      line
        .put(oSide, 'SIDE', MUTED, oQty)
        .putRight(oPrice - 2, 'QTY', MUTED, oQty)
        .putRight(oType - 2, 'PRICE', MUTED, oPrice)
        .put(oType, 'TYPE', MUTED, oStatus)
        .put(oStatus, 'STATUS', MUTED, inner);
    } else {
      const order = orders[row - 1];
      if (order) {
        if (idWidth > 0) line.put(oId, order.id, MUTED, oSide - 1);
        line
          .put(oSide, order.side, sideColor(order.side), oQty)
          // Numbers right-aligned in their column so decimals line up and a
          // changing value never shifts its neighbours.
          .putRight(oPrice - 2, order.qty, undefined, oQty)
          .putRight(oType - 2, order.price, undefined, oPrice)
          .put(oType, order.type, MUTED, oStatus)
          .put(oStatus, order.status, statusColor(order.status), inner);
      } else if (row === 1 && orders.length === 0) {
        line.put(panelStart, 'No active orders', MUTED, inner);
      }
    }

    const field = positionFields[row];
    if (field) {
      line.put(2, field[0], undefined, valueCol).put(valueCol, field[1], field[2], divider);
    } else if (row === 0 && !position) {
      line.put(2, 'No open position', MUTED, divider);
    }

    lines.push(line);
  }

  // --- chase: only present while one is running --------------------------
  lines.push(border({ divider: 'up' }));
  if (chase) {
    lines.push(new Line(width).put(2, 'CHASE', HEADING_COLOR));
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
    lines.push(border());
  }

  // --- activity ----------------------------------------------------------
  lines.push(activityLabel(view, width, activityRows));

  const visible = windowActivity(activity, activityRows, view.activityOffset ?? 0);
  for (let row = 0; row < activityRows; row++) {
    const line = new Line(width);
    const event = visible[row];

    if (event) {
      lines.push(activityRow(event, width, inner));
      continue;
    }

    lines.push(line);
  }

  // --- command entry, kept fixed so activity never moves it --------------
  lines.push(border());
  lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, undefined, inner));

  // --- footer ------------------------------------------------------------
  lines.push(border());

  lines.push(footerRow(view, width, inner));

  lines.push(border({ edge: 'bottom' }));

  return lines;
}

export function renderPlain(view: TerminalView, size: Size): string[] {
  return buildFrame(view, size).map((line) => line.plain());
}

export function renderPainted(view: TerminalView, size: Size): string[] {
  return buildFrame(view, size).map((line) => line.painted());
}
