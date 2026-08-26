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

import { formatOutput as fo, Color, FontStyle } from '../utils/formatOutput.js';

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
  /**
   * No symbol here. The market is named once, in MARKET, where its label sits
   * beside it -- repeating it in the header said the same thing twice and left
   * the reader checking whether the two agreed.
   */
  instrumentType: string;
  account: string;
  /** Wallet balance: what the exchange holds, before any open position settles. */
  balance: string;
  /** Balance plus unrealized on every open position -- the account closed out here. */
  equity: string;
  /** Unit for both, carried separately so it can be printed once. */
  fundsCurrency: string;
}

/** One period's high and low. */
export interface RangeColumnView {
  label: string;
  high: string;
  low: string;
  /** Typical bar range for this period, against which high/low can be judged. */
  atr: string;
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
  /**
   * How the order is being worked, when it is being worked at all.
   *
   * CHASE is currently the only value: it is the only thing that keeps acting
   * on an order after placing it. Orders from bracket or range commands are
   * placed and then left, so they carry nothing here rather than a label that
   * would say only where they came from.
   */
  managed?: string;
  /** Time left before a decaying chase gives up, as mm:ss. */
  expires?: string;
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

/**
 * One exchange in the coach thread, before it is wrapped to a panel width.
 *
 * Unwrapped on purpose: only the frame knows how wide the panel turned out,
 * and text wrapped anywhere else would have to be re-wrapped here anyway.
 */
export interface CoachEntryView {
  kind: 'operator' | 'coach' | 'system';
  text: string;
}

/**
 * What the guardrails currently hold to be true.
 *
 * This is the half of the guard's output that is a *condition* rather than an
 * event: a position sized past the risk limit stays sized past it until it is
 * closed. It belongs somewhere that can be rewritten in place, which is what
 * this is -- the activity log gets the moment it started and the moment it
 * ends, and nothing in between.
 */
export interface GuardStatusView {
  count: number;
  /** Already ordered worst first, e.g. 'risk-per-trade (hold), give-back'. */
  summary: string;
}

export interface TerminalView {
  header: HeaderView;
  ranges: RangeColumnView[];
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
  /**
   * The coach conversation, oldest first. An empty thread renders an invitation
   * rather than an empty box, so the panel explains itself without a help page.
   */
  coach?: CoachEntryView[];
  /** A reply is outstanding. The panel says so rather than looking finished. */
  coachBusy?: boolean;
  /** Standing guardrail conditions, shown rather than repeated into the log. */
  guard?: GuardStatusView;
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
  /** Where one block's divider closes and the next one's opens. */
  cross: string;
}

const UNICODE_BOX: BoxChars = {
  h: '─', v: '│',
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  teeDown: '┬', teeUp: '┴', teeLeft: '┤', teeRight: '├',
  cross: '┼',
};

const ASCII_BOX: BoxChars = {
  h: '-', v: '|',
  tl: '+', tr: '+', bl: '+', br: '+',
  teeDown: '+', teeUp: '+', teeLeft: '+', teeRight: '+',
  cross: '+',
};

const box: BoxChars = canRenderUnicode() ? UNICODE_BOX : ASCII_BOX;

/**
 * A styling role: colour, and optionally weight.
 *
 * Weight is part of the vocabulary because colour alone had run out. Cyan,
 * green, yellow and red all carry meaning here -- active, good, warning, bad --
 * so a heading cannot take a hue without claiming one of those meanings. Bold
 * says "this is structure, not data" without saying anything about the data.
 */
export type Paint = Color | { color: Color; font?: FontStyle };

const asPaint = (paint: Paint): { color: Color; font?: FontStyle } =>
  typeof paint === 'string' ? { color: paint } : paint;

/**
 * (5) The whole vocabulary. Four roles, and every piece of text on the screen
 * takes one of them, so the same kind of thing looks the same everywhere
 * regardless of which panel it lands in.
 *
 * The tiers are ordered by weight and brightness rather than by hue:
 *
 *   SECTION  bold, brightest   the name of a region -- MARKET, POSITION
 *   HEADLINE bright            the one number a panel exists to show
 *   VALUE    normal            data
 *   LABEL    dim               the words naming that data
 *
 * Labels are deliberately the quietest thing on screen. They are read once to
 * learn the layout and then skipped forever; the values beside them are read
 * on every glance. Anything that carries meaning -- a side, a status, a signed
 * PnL -- overrides VALUE with its semantic colour.
 */
const SECTION: Paint = { color: 'brightWhite', font: 'bold' };
const HEADLINE: Paint = 'brightWhite';
const VALUE: Paint = 'white';
const LABEL: Paint = 'gray';
/** Chrome: timestamps, empty states, the command hints. Quiet as labels. */
const MUTED: Paint = 'gray';

interface Span {
  col: number;
  length: number;
  color: Color;
  font?: FontStyle;
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

  put(col: number, text: string | undefined, paint?: Paint, limit?: number): this {
    if (text === undefined || text === null) return this;

    const stop = Math.min(limit ?? this.width - 1, this.width);
    const room = Math.max(0, stop - col);
    const clipped = String(text).slice(0, room);

    for (let i = 0; i < clipped.length; i++) this.chars[col + i] = clipped[i];
    if (paint && clipped.length > 0) {
      this.spans.push({ col, length: clipped.length, ...asPaint(paint) });
    }

    return this;
  }

  /** Right-aligns text so its last character sits at `end - 1`. */
  putRight(end: number, text: string | undefined, paint?: Paint, floor = 1): this {
    if (text === undefined || text === null) return this;
    const value = String(text);
    const col = Math.max(floor, end - value.length);
    return this.put(col, value.slice(0, end - col), paint, end);
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
      out += fo(
        this.chars.slice(span.col, span.col + span.length).join(''),
        span.color,
        span.font
      );
      cursor = span.col + span.length;
    }

    return out + this.chars.slice(cursor).join('');
  }
}

/**
 * A label and the value it names, styled as a pair.
 *
 * Every labelled field on the screen goes through here. That is the point: the
 * consistency is enforced by there being one place that decides it, rather than
 * by each panel remembering to do the same thing.
 */
function labelledAt(
  line: Line,
  col: number,
  label: string,
  valueCol: number,
  value: string | undefined,
  limit: number,
  paint: Paint = VALUE
): Line {
  line.put(col, label, LABEL, Math.min(col + label.length + 1, valueCol));
  return line.put(valueCol, value, paint, limit);
}

/**
 * Trims a value to the room available, dropping a trailing parenthetical
 * rather than cutting through it.
 *
 * A funding rate reads '0.0100% (10.95% APR)'. Cut to fit, that becomes
 * '0.0100% (10.95% APR' -- an unclosed bracket reads as a rendering fault, and
 * '0.0100% (10.' reads as a different number. Dropping the aside entirely
 * leaves the rate itself intact and obviously complete.
 */
function fitValue(text: string, room: number): string {
  if (text.length <= room) return text;

  const balanced = (value: string): boolean =>
    (value.match(/\(/g) ?? []).length === (value.match(/\)/g) ?? []).length;

  // Whole words only. Cutting mid-number turns 0.0100% into 0.010, which is not
  // a shortened value but a different one, and cutting mid-bracket leaves what
  // looks like a rendering fault.
  const words = text.split(' ');
  while (words.length > 1) {
    words.pop();
    const candidate = words.join(' ');
    if (candidate.length <= room && balanced(candidate)) return candidate;
  }

  // Not even the leading value fits. '--' says so; anything else here would be
  // a number the reader could act on and shouldn't.
  return words[0].length <= room && balanced(words[0]) ? words[0] : NO_VALUE;
}

/** The same pair, with the value following its label directly. */
function labelled(
  line: Line,
  col: number,
  label: string,
  value: string | undefined,
  limit: number,
  paint: Paint = VALUE
): Line {
  return labelledAt(line, col, label, col + label.length + 1, value, limit, paint);
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
      // Plain blue is ANSI 34, the dimmest colour in the palette and hard to
      // read on a dark background. Bright blue stays in the same family, so it
      // remains distinct from ORDER's cyan.
      return 'brightBlue';
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
/** Border, label row, high, low, atr. */
const RANGE_ROWS = 5;
/** The split block and the activity area cannot go below these. */
const MIN_SPLIT_ROWS = 4;
const MIN_ACTIVITY_ROWS = 1;

export function planHeight(height: number, hasChase: boolean) {
  const chaseRows = hasChase ? 4 : 0; // label + three rows
  const base =
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

  // Range is the panel that yields when the terminal is short. It is a
  // reference rather than something an order depends on, and the alternative is
  // a frame taller than the screen, which pushes the command line off it.
  const showRanges =
    height - base - 1 - MIN_SPLIT_ROWS - MIN_ACTIVITY_ROWS >= RANGE_ROWS;

  const fixed = base + (showRanges ? RANGE_ROWS : 0);
  const flexible = Math.max(0, height - fixed);

  // The position panel wants ten rows (label, gap, eight fields). Give it that
  // when there's room, and let activity take the remainder.
  const splitRows = Math.max(MIN_SPLIT_ROWS, Math.min(12, flexible - 4));
  const activityRows = Math.max(MIN_ACTIVITY_ROWS, flexible - splitRows - 1); // -1 for its label

  return { splitRows, activityRows, showRanges };
}

/**
 * The confirmation panel, sized to fill the block it replaces.
 *
 * Labels sit left, values at a common column so the numbers line up and the size
 * can be compared against the value at a glance.
 */
/**
 * The account figures for the identity row, widest form first.
 *
 * These share the row with the market identity, so at narrow widths something
 * has to go. Account number goes first -- it names which account, which the
 * operator already knows and cannot act on. Balance goes next: equity is the
 * figure that moves when a position does, so it is the last one standing.
 *
 * The unit is printed once, on whichever figure ends up last, rather than
 * repeated on both.
 */
interface FundsPart {
  label: string;
  value: string;
}

/** Width of a rendered run of parts, including the gaps between them. */
const fundsWidth = (parts: FundsPart[]): number =>
  parts.reduce((sum, part) => sum + part.label.length + 1 + part.value.length, 0) +
  Math.max(0, parts.length - 1) * FUNDS_GAP;

const FUNDS_GAP = 3;

function headerFunds(header: HeaderView, available: number): FundsPart[] {
  const has = (value: string): boolean =>
    value !== undefined && value !== '' && value !== NO_VALUE;

  const balance: FundsPart | null = has(header.balance)
    ? { label: 'Balance', value: header.balance }
    : null;
  const equity: FundsPart | null = has(header.equity)
    ? { label: 'Equity', value: header.equity }
    : null;
  const account: FundsPart | null = has(header.account)
    ? { label: 'Account', value: header.account }
    : null;

  // Widest form first; each fallback drops the least actionable part still
  // present. Figures are kept separate from the account so the unit can be
  // attached to the last figure actually shown -- appending it blindly would
  // leave a bare unit standing where a missing figure should have been.
  const forms: Array<Array<FundsPart | null>> = [
    [balance, equity, account],
    [balance, equity],
    [equity],
    [balance],
  ];

  for (const form of forms) {
    const parts = form.filter((part): part is FundsPart => part !== null);
    if (parts.length === 0) continue;

    const figures = parts.filter((part) => part !== account);
    const shown = parts.map((part) =>
      header.fundsCurrency && part === figures[figures.length - 1]
        ? { ...part, value: `${part.value} ${header.fundsCurrency}` }
        : { ...part }
    );

    if (fundsWidth(shown) <= available) return shown;
  }

  // No figure fits, but the account still identifies where the operator is.
  return account && fundsWidth([account]) <= available ? [account] : [];
}

/** Right-aligns a run of labelled figures, ending at `end`. */
function putFunds(line: Line, end: number, parts: FundsPart[]): Line {
  let col = end - fundsWidth(parts);
  for (const part of parts) {
    const width = part.label.length + 1 + part.value.length;
    labelled(line, col, part.label, part.value, col + width);
    col += width + FUNDS_GAP;
  }
  return line;
}

/**
 * The high/low grid.
 *
 * The section name occupies the column that labels the rows beneath it, which
 * is exactly what it is doing, so the panel costs no more height than the rows
 * of data it carries.
 *
 * High and low are where price has been over that period; ATR is what a bar of
 * that period typically covers. The pairing is the point -- a 1h range far
 * wider than the 1h ATR says this hour is not an ordinary one, which neither
 * row says by itself.
 *
 * Each period's label and its values share a column and a left edge, so a
 * column reads as one period top to bottom.
 */
function rangeBlock(
  ranges: RangeColumnView[],
  width: number,
  inner: number
): Line[] {
  // Eight, not seven: 'ATR(14)' is itself seven characters and would sit flush
  // against the first value with no gap to separate them.
  const labelWidth = 8;
  const start = 2 + labelWidth;
  const columns = Math.max(1, ranges.length);
  // Capped, not merely divided. Spreading six short prices across a wide
  // terminal puts twenty columns of nothing between them, and reading a row
  // then becomes a journey rather than a glance. The grid stays compact and
  // leaves the space to the right unused.
  const available = Math.floor((inner - start - 1) / columns);
  const span = Math.max(8, Math.min(12, available));

  const heading = new Line(width).put(2, 'RANGE', SECTION, start);
  const high = new Line(width).put(2, 'High', LABEL, start);
  const low = new Line(width).put(2, 'Low', LABEL, start);
  // Named with its period so it cannot be mistaken for a range of 14 anything.
  const atr = new Line(width).put(2, 'ATR(14)', LABEL, start);

  ranges.forEach((range, index) => {
    const col = start + index * span;
    const limit = Math.min(col + span, inner);
    if (col >= inner - 1) return;

    heading.put(col, range.label, LABEL, limit);
    high.put(col, range.high, VALUE, limit);
    low.put(col, range.low, VALUE, limit);
    atr.put(col, range.atr, VALUE, limit);
  });

  return [heading, high, low, atr];
}

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
    new Line(width).put(2, 'CONFIRM ORDER', { color: 'yellow', font: 'bold' }),
    new Line(width).put(2, confirmation.action, sideColor(confirmation.action.split(' ')[0])),
    new Line(width),
    labelledAt(new Line(width), 2, 'Size', valueCol, confirmation.size, inner),
    labelledAt(new Line(width), 2, 'Est. Value', valueCol, confirmation.estimatedValue, inner),
    labelledAt(new Line(width), 2, 'Est. Fee', valueCol, confirmation.estimatedFee, inner),
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

/**
 * Below this the coach goes under the activity log rather than beside it.
 *
 * Splitting the region costs the log its right-hand half, and the activity
 * columns run to about column 54 before the message even starts. Halving an
 * eighty-column terminal would leave the message with six characters, so the
 * threshold is set where both halves are still worth reading.
 */
const COACH_SPLIT_WIDTH = 120;

/** Content rows the stacked coach band gets, on top of its border and label. */
const COACH_BAND_ROWS = 3;

interface CoachLine {
  text: string;
  paint: Paint | undefined;
}

/**
 * Greedy word wrap.
 *
 * A token longer than the panel is broken rather than clipped: it is nearly
 * always a number, and half a number read as a whole one is the kind of mistake
 * this application exists to avoid.
 */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];

  const out: string[] = [];

  for (const paragraph of String(text).split('\n')) {
    const words: string[] = [];
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      for (let i = 0; i < word.length; i += width) words.push(word.slice(i, i + width));
    }

    let line = '';
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }

  return out;
}

/**
 * The thread flattened into paintable rows.
 *
 * The operator's own lines keep the '>' they were typed after and take the
 * command colour, so a glance separates what was asked from what came back
 * without reading either.
 */
function coachLines(view: TerminalView, width: number): CoachLine[] {
  const entries = view.coach ?? [];
  const out: CoachLine[] = [];

  if (entries.length === 0) {
    return [{ text: "Ask with 'coach <question>'", paint: MUTED }];
  }

  for (const entry of entries) {
    if (out.length > 0) out.push({ text: '', paint: undefined });

    if (entry.kind === 'operator') {
      const wrapped = wrapText(entry.text, Math.max(1, width - 2));
      wrapped.forEach((text, index) =>
        out.push({ text: `${index === 0 ? '> ' : '  '}${text}`, paint: 'cyan' })
      );
      continue;
    }

    const paint = entry.kind === 'system' ? MUTED : VALUE;
    for (const text of wrapText(entry.text, width)) out.push({ text, paint });
  }

  // Appended rather than shown in place of the thread: the previous answer
  // stays readable while the next one is being written.
  if (view.coachBusy) out.push({ text: 'thinking...', paint: MUTED });

  return out;
}

/** The tail of the thread, which is the part worth the rows. */
function tailCoach(lines: CoachLine[], rows: number): CoachLine[] {
  if (lines.length <= rows) return lines;

  // It does not all fit, so the separators go first. A blank row between two
  // exchanges is worth having when there is room and worth less than the
  // sentence it displaces when there is not -- and a tail that happens to begin
  // on one would otherwise spend the panel's first row on nothing.
  const dense = lines.filter((line) => line.text.length > 0);
  return dense.slice(Math.max(0, dense.length - rows));
}

/** Rows the stacked band would take, borders and label included. Zero if idle. */
function coachBandCost(view: TerminalView): number {
  return (view.coach ?? []).length === 0 ? 0 : COACH_BAND_ROWS + 2;
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
/**
 * Painted into a line that may already hold something else.
 *
 * `stop` is where the row must end -- the full inner width normally, the
 * divider when the coach is sitting beside it. Everything below clips to it, so
 * a long message ends at the divider instead of running through the panel next
 * to it.
 */
function paintActivity(line: Line, event: ActivityRowView, stop: number): Line {
  const inner = stop;
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
    line.put(cSide, event.message, VALUE, inner);
    return line;
  }

  if (detail.side) line.put(cSide, detail.side, sideColor(detail.side), cQty);
  if (detail.quantity) line.putRight(cPrice - 2, detail.quantity, VALUE, cQty);
  if (detail.price) line.putRight(cStatus - 2, detail.price, VALUE, cPrice);
  if (detail.status) line.put(cStatus, detail.status, statusColor(detail.status), inner);

  // Anything the columns don't cover follows them rather than being lost.
  if (event.message) {
    const after = detail.status ? cStatus + detail.status.length + 2 : cStatus;
    line.put(after, event.message, VALUE, inner);
  }

  return line;
}

function activityLabel(
  view: TerminalView,
  width: number,
  rows: number,
  divider?: number
): Line {
  const line = new Line(width).put(2, 'ACTIVITY', SECTION);
  const split = divider !== undefined && divider > 0;
  const stop = split ? (divider as number) : width - 2;

  if (split) line.divider(divider as number);

  const offset = view.activityOffset ?? 0;
  if (offset > 0) {
    const behind = Math.min(offset, Math.max(0, view.activity.length - rows));
    line.put(12, `scrolled back ${behind}`, 'yellow', stop);
  }

  if (split) line.put((divider as number) + 2, 'COACH', SECTION, width - 2);

  // Right-aligned, and the last thing painted, so a long list of standing
  // conditions gives ground to the labels rather than overwriting them.
  const guard = view.guard;
  if (guard && guard.count > 0) {
    const floor = split ? (divider as number) + 10 : 30;
    line.putRight(width - 2, `GUARD ${guard.count}: ${guard.summary}`, 'yellow', floor);
  }

  return line;
}

/** Commands that place or withdraw orders, as opposed to ones that only look. */
const EXECUTION_COMMANDS = new Set(['buy', 'sell', 'chase', 'limit', 'trail', 'cancel']);

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
  const riskColor: Paint | undefined = !position
    ? undefined
    : position.risk === NO_VALUE || position.risk.startsWith(NO_VALUE)
    ? MUTED
    : position.risk.startsWith('0.00')
    ? undefined
    : 'yellow';

  const positionFields: Array<[string, string, Paint | undefined]> = position
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
  const available = Math.max(MIN_HEIGHT, size.height);

  // Range is the panel that yields when the terminal is short. It is a
  // reference, not something an order depends on, and a block that renders
  // past the bottom of the screen would take the command line with it.
  const showRanges =
    view.ranges.length > 0 && available - fixed - 1 - RANGE_ROWS >= MIN_ACTIVITY_ROWS;

  const activityRows = Math.max(
    1,
    available - fixed - (showRanges ? RANGE_ROWS : 0) - 1
  );

  lines.push(border());
  lines.push(
    new Line(width)
      .put(2, 'TRADING TERMINAL', SECTION, inner - 22)
      .putRight(inner - 1, `${header.environment} | ${header.connection}`, LABEL, 20)
      .put(
        inner - 1 - header.connection.length,
        header.connection,
        header.connection.toUpperCase() === 'CONNECTED' ? 'green' : 'red'
      )
  );
  const identity = header.exchange;
  const stackedFunds = headerFunds(header, inner - 3 - identity.length - 2);
  const identityLine = new Line(width).put(
    2,
    identity,
    VALUE,
    inner - 1 - fundsWidth(stackedFunds) - 2
  );
  lines.push(putFunds(identityLine, inner - 1, stackedFunds));

  lines.push(border());
  lines.push(new Line(width).put(2, 'MARKET', SECTION));
  const marketRow = new Line(width);
  labelled(marketRow, 2, 'Symbol', market.symbol, 24, HEADLINE);
  labelled(marketRow, 24, 'Last', market.last, 36, HEADLINE);
  labelled(marketRow, 36, '24h', market.change, inner, signedColor(market.change) ?? VALUE);
  lines.push(marketRow);
  const secondary = new Line(width);
  labelled(secondary, 2, 'Bid', market.bid, 16);
  labelled(secondary, 16, 'Ask', market.ask, 30);
  labelled(secondary, 30, 'Mark', market.mark, 45);
  labelled(secondary, 45, 'Spread', market.spread, inner);
  lines.push(secondary);

  // Six periods will not fit in eighty columns without the numbers colliding,
  // so the narrow layout carries the shortest, an hour, and the day. Dropping
  // the panel entirely would lose more than dropping three of its columns.
  const narrowRanges = showRanges
    ? view.ranges.filter((range) => ['5m', '1h', '1d', '1w', '1mo'].includes(range.label))
    : [];
  if (narrowRanges.length > 0) {
    lines.push(border());
    lines.push(...rangeBlock(narrowRanges, width, inner));
  }

  lines.push(border());
  lines.push(new Line(width).put(2, 'POSITION', SECTION));
  if (positionFields.length === 0) {
    lines.push(new Line(width).put(2, 'No open position', MUTED, inner));
  } else {
    for (const [label, value, paint] of positionFields) {
      lines.push(labelledAt(new Line(width), 2, label, 19, value, inner, paint ?? VALUE));
    }
  }

  lines.push(border());
  lines.push(new Line(width).put(2, 'ACTIVE ORDERS', SECTION));
  const c1 = 2, c2 = 10, c3 = 17, c4 = 24, c5 = 33;
  lines.push(
    new Line(width)
      .put(c1, 'ID', LABEL, c2)
      .put(c2, 'SIDE', LABEL, c3)
      .put(c3, 'QTY', LABEL, c4)
      .put(c4, 'PRICE', LABEL, c5)
      .put(c5, 'STATUS', LABEL, inner)
  );
  if (orderRows === 0) {
    lines.push(new Line(width).put(2, 'No active orders', MUTED, inner));
  } else {
    for (const order of orders.slice(0, orderRows)) {
      lines.push(
        new Line(width)
          .put(c1, order.id, VALUE, c2)
          .put(c2, order.side, sideColor(order.side), c3)
          .put(c3, order.qty, VALUE, c4)
          .put(c4, order.price, VALUE, c5)
          .put(c5, order.status, statusColor(order.status), inner)
      );
    }
  }

  if (chase) {
    lines.push(border());
    lines.push(new Line(width).put(2, 'CHASE', SECTION));
    lines.push(new Line(width).put(2, chase.side, sideColor(chase.side), 7).put(7, chase.quantity, VALUE, inner));
    const summary = `Working ${chase.working} | Reprices ${chase.reprices} | ${chase.elapsed} | `;
    lines.push(
      new Line(width)
        .put(2, summary, LABEL, inner)
        .put(Math.min(2 + summary.length, inner - 1), chase.status, statusColor(chase.status), inner)
    );
  }

  lines.push(border());

  // Never beside the log at this width -- there is barely room for the log --
  // so the coach takes a band beneath it, and only when it has something to say.
  const bandCost = coachBandCost(view);
  const logRows = Math.max(1, activityRows - bandCost);

  lines.push(activityLabel(view, width, logRows));
  const visible = windowActivity(activity, logRows, view.activityOffset ?? 0);
  for (let row = 0; row < logRows; row++) {
    const line = new Line(width);
    const event = visible[row];
    if (event) {
      line
        .put(2, event.time.slice(0, 11), 'gray', 14)
        .put(14, event.category, categoryColor(event.category), 21)
        .put(21, event.message, VALUE, inner);
    }
    lines.push(line);
  }

  if (bandCost > 0) {
    lines.push(border());
    lines.push(new Line(width).put(2, 'COACH', SECTION));
    const band = tailCoach(coachLines(view, inner - 3), COACH_BAND_ROWS);
    for (let row = 0; row < COACH_BAND_ROWS; row++) {
      const spoken = band[row];
      lines.push(
        spoken ? new Line(width).put(2, spoken.text, spoken.paint, inner) : new Line(width)
      );
    }
  }

  lines.push(border());
  lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, HEADLINE, inner));

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
    opts: { edge?: 'top' | 'bottom'; divider?: 'down' | 'up' | 'cross' } = {}
  ): Line => {
    const left = opts.edge === 'top' ? box.tl : opts.edge === 'bottom' ? box.bl : box.teeRight;
    const right = opts.edge === 'top' ? box.tr : opts.edge === 'bottom' ? box.br : box.teeLeft;

    const line = new Line(width, false);
    line.put(0, left + box.h.repeat(width - 2) + right, undefined, width);

    if (opts.divider) {
      const glyph =
        opts.divider === 'down' ? box.teeDown : opts.divider === 'up' ? box.teeUp : box.cross;
      line.put(divider, glyph, undefined, width);
    }

    return line;
  };

  const { splitRows, activityRows, showRanges } = planHeight(
    Math.max(MIN_HEIGHT, size.height),
    chase !== null
  );

  // --- header: identity on the left, connection state on the right ------
  lines.push(border({ edge: 'top' }));

  const connectionText = `${header.environment} | ${header.connection}`;
  lines.push(
    new Line(width)
      .put(2, 'TRADING TERMINAL', SECTION)
      .putRight(inner - 1, connectionText, LABEL, 20)
      .put(
        inner - 1 - header.connection.length,
        header.connection,
        header.connection.toUpperCase() === 'CONNECTED' ? 'green' : 'red'
      )
  );

  const context = [header.exchange, header.instrumentType]
    .filter((part) => part && part.length > 0)
    .join(' | ');
  // Three columns of gap keeps the figures from reading as part of the symbol.
  const funds = headerFunds(header, inner - 3 - context.length - 3);
  const fundsLine = new Line(width).put(
    2,
    context,
    VALUE,
    inner - 1 - fundsWidth(funds) - 3
  );
  lines.push(putFunds(fundsLine, inner - 1, funds));

  // --- market: symbol and last price lead, the rest supports -------------
  lines.push(border());
  lines.push(new Line(width).put(2, 'MARKET', SECTION));

  // Four evenly spaced columns, so the primary and secondary rows line up with
  // each other and every value keeps a fixed starting position.
  // The leading column carries the labelled symbol, so it takes the room that
  // symbol actually needs rather than a fixed guess -- a fixed one wide enough
  // for a long symbol steals a column's worth of space from every short one.
  const col1 = Math.max(18, Math.min(26, 2 + 'Symbol '.length + market.symbol.length + 2));
  const span = Math.max(14, Math.floor((inner - col1) / 4));
  const col2 = col1 + span;
  const col3 = col2 + span;
  const col4 = col3 + span;

  const field = (line: Line, col: number, label: string, value: string, limit: number) =>
    labelled(line, col, label, value, limit);

  const primaryRow = new Line(width);
  labelled(primaryRow, 2, 'Symbol', market.symbol, col1, HEADLINE);
  labelled(primaryRow, col1, 'Last', market.last, col2, HEADLINE);
  field(primaryRow, col2, 'Bid', market.bid, col3);
  field(primaryRow, col3, 'Ask', market.ask, col4);
  if (market.change && market.change !== NO_VALUE) {
    labelled(primaryRow, col4, '24h', market.change, inner, signedColor(market.change) ?? VALUE);
  }
  lines.push(primaryRow);

  const secondaryRow = new Line(width);

  // Spread sits under Ask, at every width. It is the distance between bid and
  // ask, so it reads against the prices it comes from rather than against the
  // funding rate or the 24h change, and an alignment that moves as the terminal
  // is resized is not an alignment.
  //
  // Funding yields the space instead: it is the one value here carrying an
  // aside it can afford to lose.
  const spreadCol = col3;
  const fundingAt = col2 + 'Funding '.length;

  field(secondaryRow, 2, 'Mark', market.mark, col1);
  field(secondaryRow, col1, 'Index', market.index, col2);
  labelled(
    secondaryRow,
    col2,
    'Funding',
    fitValue(market.funding, Math.max(0, spreadCol - 1 - fundingAt)),
    spreadCol - 1
  );
  labelled(secondaryRow, spreadCol, 'Spread', market.spread, inner);
  lines.push(secondaryRow);

  // --- range: where price has been over each period ----------------------
  if (showRanges && view.ranges.length > 0) {
    lines.push(border());
    lines.push(...rangeBlock(view.ranges, width, inner));
  }

  // --- confirmation takes the place of position/orders when pending --------
  if (view.confirmation) {
    lines.push(...confirmationBlock(view.confirmation, width, splitRows + 1));
    lines.push(border());
    lines.push(new Line(width).put(2, 'ACTIVITY', SECTION));
    const pending = activity.slice(-activityRows);
    for (let row = 0; row < activityRows; row++) {
      const line = new Line(width);
      const event = pending[row];
      if (event) {
        line
          .put(2, event.time, 'gray', 11)
          .put(12, event.category, categoryColor(event.category), 20)
          .put(21, event.message, VALUE, inner);
      }
      lines.push(line);
    }
    lines.push(border());
    lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, HEADLINE, inner));
    lines.push(border());
    lines.push(footerRow(view, width, inner));
    lines.push(border());
    return lines;
  }

  // --- position | active orders -----------------------------------------
  lines.push(border({ divider: 'down' }));
  lines.push(
    new Line(width).divider(divider).put(2, 'POSITION', SECTION).put(divider + 2, 'ACTIVE ORDERS', SECTION)
  );

  // The full form is preferred; the short one is used only when the panel can't
  // hold it, so an unprotected quantity is never silently cut off.
  const riskRoom = divider - 21 - 1;
  const riskValue = position
    ? position.risk.length <= riskRoom
      ? position.risk
      : position.riskShort ?? position.risk
    : '';
  const riskColor: Paint | undefined = !position
    ? undefined
    : position.risk === NO_VALUE || position.risk.startsWith(NO_VALUE)
    ? MUTED
    : position.risk.startsWith('0.00')
    ? undefined
    : 'yellow';

  const positionFields: Array<[string, string, Paint | undefined]> = position
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
  const fixedWithoutExpiry = 5 + 8 + 9 + 7 + 8 + 7; // side, qty, price, type, status, mode
  const expiryWidth = 8;
  // Width decides this, not whether a chase happens to be running: a column that
  // came and went with the chase would shift every other value sideways.
  const showExpiry = panelWidth >= fixedWithoutExpiry + expiryWidth + 4;
  const fixed = fixedWithoutExpiry + (showExpiry ? expiryWidth : 0);
  const idWidth = Math.max(0, Math.min(10, panelWidth - fixed));

  const oId = panelStart;
  const oSide = oId + idWidth;
  const oQty = oSide + 5;
  const oPrice = oQty + 8;
  const oType = oPrice + 9;
  const oStatus = oType + 7;
  const oManaged = oStatus + 8;
  const oExpires = oManaged + 7;

  const valueCol = 21;
  const bodyRows = Math.max(1, splitRows - 1); // first row of the block is a gap

  for (let row = 0; row < bodyRows; row++) {
    const line = new Line(width).divider(divider);

    if (row === 0) {
      if (idWidth > 0) line.put(oId, 'ID', LABEL, oSide - 1);
      line
        .put(oSide, 'SIDE', LABEL, oQty)
        .putRight(oPrice - 2, 'QTY', LABEL, oQty)
        .putRight(oType - 2, 'PRICE', LABEL, oPrice)
        .put(oType, 'TYPE', LABEL, oStatus)
        .put(oStatus, 'STATUS', LABEL, oManaged)
        .put(oManaged, 'MODE', LABEL, showExpiry ? oExpires : inner);
      if (showExpiry) line.put(oExpires, 'EXPIRES', LABEL, inner);
    } else {
      const order = orders[row - 1];
      if (order) {
        // The id stays quiet -- it identifies an order but you don't trade on
        // it -- yet it is still a value, so it outranks the column header above.
        if (idWidth > 0) line.put(oId, order.id, VALUE, oSide - 1);
        line
          .put(oSide, order.side, sideColor(order.side), oQty)
          // Numbers right-aligned in their column so decimals line up and a
          // changing value never shifts its neighbours.
          .putRight(oPrice - 2, order.qty, VALUE, oQty)
          .putRight(oType - 2, order.price, VALUE, oPrice)
          .put(oType, order.type, VALUE, oStatus)
          .put(oStatus, order.status, statusColor(order.status), oManaged)
          // An order being worked by the chase is an active state, so it takes
          // the same accent as WORKING rather than reading as metadata.
          .put(oManaged, order.managed, order.managed ? 'cyan' : undefined,
               showExpiry ? oExpires : inner);
        if (showExpiry) {
          // Amber near the end: a chase about to give up is worth noticing
          // before it does.
          const nearlyDone = /^00:0\d$/.test(order.expires ?? '');
          line.put(oExpires, order.expires, nearlyDone ? 'yellow' : VALUE, inner);
        }
      } else if (row === 1 && orders.length === 0) {
        line.put(panelStart, 'No active orders', MUTED, inner);
      }
    }

    const field = positionFields[row];
    if (field) {
      labelledAt(line, 2, field[0], valueCol, field[1], divider, field[2] ?? VALUE);
    } else if (row === 0 && !position) {
      line.put(2, 'No open position', MUTED, divider);
    }

    lines.push(line);
  }

  // --- chase: only present while one is running --------------------------
  // The position/orders divider closes here. When the coach sits beside the log
  // a fresh one opens immediately, so the border crosses rather than caps --
  // unless a chase is in between, where it caps and reopens beneath.
  const splitCoach = width >= COACH_SPLIT_WIDTH;
  lines.push(border({ divider: !chase && splitCoach ? 'cross' : 'up' }));
  if (chase) {
    lines.push(new Line(width).put(2, 'CHASE', SECTION));
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
    lines.push(border({ divider: splitCoach ? 'down' : undefined }));
  }

  // --- activity, with the coach beside it or beneath it -------------------
  const bandCost = splitCoach ? 0 : coachBandCost(view);
  const logRows = Math.max(1, activityRows - bandCost);

  lines.push(activityLabel(view, width, logRows, splitCoach ? divider : undefined));

  const visible = windowActivity(activity, logRows, view.activityOffset ?? 0);
  // The coach panel starts two columns past the divider and runs to the frame
  // edge; the floor keeps it from collapsing to nothing on an odd width.
  const thread = splitCoach
    ? tailCoach(coachLines(view, Math.max(8, inner - divider - 3)), logRows)
    : [];

  for (let row = 0; row < logRows; row++) {
    const line = splitCoach ? new Line(width).divider(divider) : new Line(width);
    const event = visible[row];

    if (event) paintActivity(line, event, splitCoach ? divider : inner);

    const spoken = thread[row];
    if (spoken && spoken.text.length > 0) {
      line.put(divider + 2, spoken.text, spoken.paint, inner);
    }

    lines.push(line);
  }

  // Too narrow to sit beside the log, so it sits under it. Only when there is
  // something to show: an empty band would cost the log three rows to say
  // nothing.
  if (bandCost > 0) {
    lines.push(border());
    lines.push(new Line(width).put(2, 'COACH', SECTION));
    const band = tailCoach(coachLines(view, inner - 3), COACH_BAND_ROWS);
    for (let row = 0; row < COACH_BAND_ROWS; row++) {
      const spoken = band[row];
      lines.push(
        spoken ? new Line(width).put(2, spoken.text, spoken.paint, inner) : new Line(width)
      );
    }
  }

  // --- command entry, kept fixed so activity never moves it --------------
  lines.push(border({ divider: splitCoach ? 'up' : undefined }));
  lines.push(new Line(width).put(2, '>', 'cyan').put(4, view.input, HEADLINE, inner));

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
