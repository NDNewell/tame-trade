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
import { CoachBlock, CoachBlockType, coachBlocks, headingFor } from './coachBlocks.js';
import { wrapText } from './wrap.js';

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
  /**
   * What funding moves over a day, signed from the operator's side.
   *
   * Belongs here rather than beside the rate in MARKET, and not only because
   * the rate's cell is too narrow to hold it: the rate is a property of the
   * instrument and is true whether or not anything is held, while this is a
   * cost of holding this position at this size. It appears when there is a
   * position and disappears with it, which is exactly what the panel is for.
   *
   * A day rather than a payment. One payment reads as a rounding error at any
   * size worth taking; the daily figure is the one that can be set against the
   * move being waited for.
   */
  funding?: string;
  /**
   * The unit funding settles in, which goes in the label rather than the value.
   *
   * The value is a rate -- an amount over a period -- so it has two things to
   * carry already. Hanging the currency off it as well made the one field on
   * the panel that reads as a sentence rather than a number.
   */
  fundingCurrency?: string;
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
  /**
   * The reply as the coach divided it, when it arrived divided.
   *
   * Preferred over `text` when present. `text` remains the fallback for the
   * operator's own lines, for the panel's voice, and for a reply that came back
   * as prose because the format was refused.
   */
  blocks?: CoachBlock[];
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
  /**
   * How far the coach panel is scrolled back from the newest line. Zero follows
   * the tail. Counted in painted rows rather than in exchanges, because an
   * answer that wrapped to six rows is six rows of scrolling.
   */
  coachOffset?: number;
  /** A reply is outstanding. The panel says so rather than looking finished. */
  coachBusy?: boolean;
  /**
   * Standing guardrail conditions.
   *
   * Rendered inside the coach column as an intervention rather than as a
   * heading of its own: GUARD is something the coach is telling the operator,
   * and putting it level with COACH made the two read as rival section labels.
   */
  guard?: GuardStatusView;
  /** What has been typed at the coach prompt, kept apart from the command line. */
  coachInput?: string;
  /**
   * Which prompt a keystroke reaches.
   *
   * Two prompts need an answer to this, and the answer has to be visible: the
   * focused one keeps its cyan caret and the other dims. Defaults to the
   * command line, because that is the one an operator reaches for without
   * looking.
   */
  focus?: 'command' | 'coach';
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
    1 + // border above the input row
    1 + // the two input prompts, side by side
    1; // bottom border
  // Two rows shorter than it was. The static command-reference footer and the
  // border above it are gone: they cost two rows of a fixed-height screen to
  // repeat a list that does not change and cannot be acted on, and the activity
  // log is the region that most obviously wanted them.

  // Range is the panel that yields when the terminal is short. It is a
  // reference rather than something an order depends on, and the alternative is
  // a frame taller than the screen, which pushes the command line off it.
  const showRanges =
    height - base - 1 - MIN_SPLIT_ROWS - MIN_ACTIVITY_ROWS >= RANGE_ROWS;

  const fixed = base + (showRanges ? RANGE_ROWS : 0);
  const flexible = Math.max(0, height - fixed);

  // The position panel wants ten rows (label, gap, eight fields). Give it that
  // when there's room, and let activity take the remainder.
  const splitRows = Math.max(MIN_SPLIT_ROWS, Math.min(13, flexible - 4));
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
  rows: number,
  stop = width - 1
): Line[] {
  const inner = stop;
  const lines: Line[] = [];
  const valueCol = 21;

  const border = (edge?: 'top' | 'bottom'): Line => {
    const left = edge === 'top' ? box.tl : edge === 'bottom' ? box.bl : box.teeRight;
    const right = edge === 'top' ? box.tr : edge === 'bottom' ? box.br : box.teeLeft;
    const line = new Line(width, false);
    // Runs to the column's own edge, not the frame's: when the coach sits
    // beside it this rule must close against the divider like every other one.
    const run = Math.max(0, stop - 1);
    line.put(0, left + box.h.repeat(run) + right, undefined, width);
    if (stop < width - 1) line.put(width - 1, box.v, undefined, width);
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

  // Exactly `rows`, no more: the caller has budgeted them out of a fixed-height
  // frame, and a block that returns more than it was given pushes the command
  // line off the bottom of the screen.
  lines.push(border());
  for (let row = 0; row < rows; row++) lines.push(body[row] ?? new Line(width));

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

/**
 * The coach sidebar's share of the terminal, and what the left column needs.
 *
 * The share is a ceiling rather than a target. What actually decides the split
 * is the trading side's content: the position panel needs room for its longest
 * label and value, the orders table needs room for eight columns, and whatever
 * is left over is the coach's.
 */
const COACH_MAX_SHARE = 0.32;
/** Prose narrower than this wraps to a tall thin wall and is harder to read. */
const COACH_MIN_PANE = 28;

/**
 * Columns POSITION needs: values start at 21 and the widest of them -- a signed
 * PnL with its unit -- runs to about sixteen, with a couple to spare so nothing
 * sits flush against the divider.
 */
const POSITION_NEED = 40;
/** An order id trimmed to where it still identifies an order at a glance. */
const ORDER_ID_MIN = 4;

/**
 * Where the vertical divider sits, or null when the terminal cannot afford one.
 *
 * The sidebar is permanent by design, but permanence cannot conjure columns: on
 * a terminal narrow enough that a quarter of it is unreadable, the coach goes
 * back under the log rather than making both halves useless.
 */
function coachColumn(width: number): number | null {
  if (width < COACH_SPLIT_WIDTH) return null;

  const wanted = POSITION_NEED + 2 + ORDER_COLUMNS + ORDER_EXPIRY_WIDTH + ORDER_ID_MIN;
  const minimum = POSITION_NEED + 2 + ORDER_COLUMNS + ORDER_ID_MIN;

  const ceiling = Math.round(width * COACH_MAX_SHARE);
  let column = Math.max(wanted, width - 1 - ceiling);

  // Where honouring the full table would leave the coach unreadable, the table
  // gives the columns back -- it degrades by dropping EXPIRES, which it already
  // knows how to do, whereas the coach has no graceful way to be too narrow.
  if (width - 1 - column < COACH_MIN_PANE) {
    column = Math.max(minimum, width - 1 - COACH_MIN_PANE);
  }

  return column;
}

/** One run of text inside a coach row, with the role it plays. */
interface CoachSegment {
  text: string;
  paint: Paint | undefined;
}

/**
 * A row of the coach pane.
 *
 * Segments rather than one string and one colour, because a sentence in the
 * coach's own voice may quote a value that already means something elsewhere on
 * screen. '+5,599.47 USDT' is green wherever it appears; the sentence around it
 * is not, and colouring the whole line green to accommodate one token would
 * make an observation about profit look like a profit.
 */
interface CoachLine {
  segments: CoachSegment[];
}

/** Coach prose: legible, and one step below the operator's own text. */
const COACH_TEXT: Paint = 'white';
/** What the operator said. The brightest ordinary prose in the pane. */
const COACH_YOU_TEXT: Paint = 'brightWhite';
/** Speaker labels. Small, uppercase, and never competing with trading data. */
const COACH_YOU_LABEL: Paint = 'cyan';
const COACH_LABEL: Paint = { color: 'gray', font: 'bold' };
/** Autonomous interventions, in the colour caution already has here. */
const COACH_GUARD: Paint = { color: 'yellow', font: 'bold' };

/**
 * How a section label inside a response is painted.
 *
 * Unbolded, so it sits below the speaker label above it -- who is talking
 * outranks what they are talking about. Two of them borrow a hue the
 * application already spends on that meaning: a RISK heading is cautionary
 * information like Position Risk, and an ACTION heading names something live
 * like WORKING. The rest stay neutral, because inventing a colour for
 * 'STRUCTURE' would put a fifth meaning into a palette that has four.
 */
const coachSectionPaint = (type: CoachBlockType): Paint => {
  if (type === 'risk') return 'yellow';
  if (type === 'action') return 'cyan';
  return 'gray';
};

const blankCoachLine = (): CoachLine => ({ segments: [] });
const plainCoachLine = (text: string, paint: Paint | undefined): CoachLine => ({
  segments: [{ text, paint }],
});
const coachLineText = (line: CoachLine): string =>
  line.segments.map((segment) => segment.text).join('');

/**
 * Values inside coach prose that already carry a meaning elsewhere on screen.
 *
 * Deliberately narrow. Only tokens whose colour is unambiguous anywhere they
 * appear are listed: a signed amount, a side, a lifecycle state. Words like
 * 'risk' or 'stop' are not here, because they are ordinary English in a
 * sentence far more often than they are a reference to the Position Risk field,
 * and a renderer guessing at that would paint half the paragraph amber.
 */
const COACH_TOKENS: Array<{ pattern: RegExp; paint: (match: string) => Paint | undefined }> = [
  {
    pattern: /[+−-][\d,]+(?:\.\d+)?(?:\s*(?:USDT|USD|SOL|BTC|ETH))?/g,
    paint: (match) => (match.trim().startsWith('+') ? 'green' : 'red'),
  },
  {
    pattern: /Position Risk\s+[\d,]+(?:\.\d+)?(?:\s*(?:USDT|USD))?/g,
    paint: () => 'yellow',
  },
  { pattern: /\b(?:LONG|BUY)\b/g, paint: () => 'green' },
  { pattern: /\b(?:SHORT|SELL|ERROR|REJECTED)\b/g, paint: () => 'red' },
  { pattern: /\b(?:WORKING|PARTIAL|TRAIL|ARM|CHASE)\b/g, paint: () => 'cyan' },
];

/**
 * Splits a line into segments, letting known values take their own colour.
 *
 * Earlier patterns win where two overlap, which is why the signed amount is
 * listed first: '-26.16 USDT' is a negative amount before it is anything else.
 */
function coachSegments(text: string, base: Paint | undefined): CoachSegment[] {
  const claims: Array<{ start: number; end: number; paint: Paint | undefined }> = [];

  for (const { pattern, paint } of COACH_TOKENS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (claims.some((claim) => start < claim.end && end > claim.start)) continue;
      claims.push({ start, end, paint: paint(match[0]) });
    }
  }

  if (claims.length === 0) return [{ text, paint: base }];

  claims.sort((a, b) => a.start - b.start);

  const segments: CoachSegment[] = [];
  let cursor = 0;
  for (const claim of claims) {
    if (claim.start > cursor) {
      segments.push({ text: text.slice(cursor, claim.start), paint: base });
    }
    segments.push({ text: text.slice(claim.start, claim.end), paint: claim.paint });
    cursor = claim.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), paint: base });

  return segments;
}

/** Lays one block into rows: its label, if it has one, then its prose. */
function putCoachBlock(out: CoachLine[], block: CoachBlock, width: number): void {
  const heading = headingFor(block.type);
  if (heading) out.push(plainCoachLine(heading, coachSectionPaint(block.type)));
  for (const row of wrapText(block.text, width)) {
    out.push({ segments: coachSegments(row, COACH_TEXT) });
  }
}

/**
 * A speaker's turn: who said it, then what they said.
 *
 * The operator's own line is one block -- it is a question, and questions are
 * not structured. The coach's is however many blocks it separated its answer
 * into, one blank row between each, and that blank row is inserted here rather
 * than taken from the reply: the application owns the spacing, so a response
 * that arrived with none still reads with the same rhythm as one that did.
 */
function coachTurn(
  out: CoachLine[],
  label: string,
  labelPaint: Paint,
  text: string,
  width: number,
  structured: boolean,
  given?: CoachBlock[]
): void {
  out.push(plainCoachLine(label, labelPaint));

  if (!structured) {
    for (const row of wrapText(text, width)) {
      out.push({ segments: coachSegments(row, COACH_YOU_TEXT) });
    }
    return;
  }

  // Divided by the coach where it said so, and by the block layer where it did
  // not. Either way the blank row between blocks is put in here.
  const blocks = given && given.length > 0 ? given : coachBlocks(text, width);
  blocks.forEach((block, index) => {
    if (index > 0) out.push(blankCoachLine());
    putCoachBlock(out, block, width);
  });
}

/**
 * The pane's contents, top to bottom.
 *
 * A standing guard condition leads, because it is the one thing here that was
 * not asked for and is therefore the one thing that has to announce itself. It
 * is not given a speaker label: GUARD already says what kind of thing it is,
 * and 'COACH / GUARD 2' would read as two headings arguing about which is the
 * heading.
 */
function coachPaneLines(view: TerminalView, width: number): CoachLine[] {
  const out: CoachLine[] = [];
  const guard = view.guard;

  if (guard && guard.count > 0) {
    // Hyphens out: 'leverage-creep' is an identifier and 'LEVERAGE CREEP' is
    // what it means, and this line is read rather than matched against.
    const headline = `GUARD ${guard.count} · ${guard.summary.toUpperCase().replace(/-/g, ' ')}`;
    for (const line of wrapText(headline, width)) out.push(plainCoachLine(line, COACH_GUARD));
    // A wider gap after an intervention than between ordinary turns: it arrived
    // uninvited and the conversation resumes underneath it.
    out.push(blankCoachLine());
  }

  const entries = view.coach ?? [];

  if (entries.length === 0 && out.length === 0) {
    out.push(plainCoachLine('Ask below.', MUTED));
    return out;
  }

  for (const entry of entries) {
    if (out.length > 0) out.push(blankCoachLine());

    if (entry.kind === 'operator') {
      coachTurn(out, 'YOU', COACH_YOU_LABEL, entry.text, width, false);
    } else if (entry.kind === 'system') {
      // The panel's own voice takes no speaker label. It is not a party to the
      // conversation and giving it one implies it is.
      for (const row of wrapText(entry.text, width)) out.push(plainCoachLine(row, MUTED));
    } else {
      coachTurn(out, 'COACH', COACH_LABEL, entry.text, width, true, entry.blocks);
    }
  }

  if (view.coachBusy) {
    out.push(blankCoachLine());
    out.push(plainCoachLine('thinking...', MUTED));
  }

  return out;
}

/**
 * The thread flattened for the narrow stacked band.
 *
 * Kept separate from the pane because the band is three rows: speaker labels
 * and paragraph breaks would spend all three on structure and leave none for
 * what was said.
 */
function coachLines(view: TerminalView, width: number): CoachLine[] {
  const entries = view.coach ?? [];
  const out: CoachLine[] = [];

  if (entries.length === 0) {
    return [plainCoachLine("Ask with 'coach <question>'", MUTED)];
  }

  for (const entry of entries) {
    if (out.length > 0) out.push(blankCoachLine());

    if (entry.kind === 'operator') {
      const wrapped = wrapText(entry.text, Math.max(1, width - 2));
      wrapped.forEach((text, index) =>
        out.push(plainCoachLine(`${index === 0 ? '> ' : '  '}${text}`, 'cyan'))
      );
      continue;
    }

    const paint = entry.kind === 'system' ? MUTED : VALUE;
    for (const text of wrapText(entry.text, width)) {
      out.push({ segments: coachSegments(text, paint) });
    }
  }

  if (view.coachBusy) out.push(plainCoachLine('thinking...', MUTED));

  return out;
}

/**
 * How many rows the coach prompt may grow to before it starts scrolling.
 *
 * It grows upward into its own column, which costs the conversation a row for
 * each one it takes. A few is worth it -- a question you cannot read back is a
 * question you retype -- but a pasted paragraph must not swallow the pane, so
 * past this the block shows its tail and the earlier text scrolls out of sight
 * above, exactly as an over-long line does in a shell.
 */
const COACH_INPUT_MAX_ROWS = 6;

/**
 * The coach prompt's text, wrapped to its column.
 *
 * Exported because two places need the same answer and must not compute it
 * twice: the frame paints these rows, and the screen puts the real cursor at
 * the end of the last of them. A wrap that disagreed between the two would park
 * the cursor somewhere other than where the next character lands.
 */
export function coachInputRows(
  size: Size,
  text: string
): { rows: string[]; truncated: boolean } {
  const width = Math.max(MIN_WIDTH, size.width);
  const column = coachColumn(width);
  if (column === null) return { rows: [text], truncated: false };

  // The marker sits at the pane's left padding and the text two columns past
  // it, so a wrapped line hangs under the first rather than under the '>'. The
  // trailing column is the same one the conversation above leaves: text flush
  // against a border reads as though it has been cut off.
  const room = Math.max(1, width - column - 6);
  const wrapped = wrapText(text, room);
  if (wrapped.length === 0) return { rows: [''], truncated: false };

  return {
    rows: wrapped.slice(-COACH_INPUT_MAX_ROWS),
    truncated: wrapped.length > COACH_INPUT_MAX_ROWS,
  };
}

/** Paints one coach row into a line, segment by segment. */
function putCoachLine(line: Line, col: number, row: CoachLine, limit: number): Line {
  let cursor = col;
  for (const segment of row.segments) {
    if (cursor >= limit) break;
    line.put(cursor, segment.text, segment.paint, limit);
    cursor += segment.text.length;
  }
  return line;
}

/**
 * The slice of the thread to show, given how far back the panel is scrolled.
 *
 * Zero offset shows the tail, which is the part worth the rows.
 */
function windowCoach(lines: CoachLine[], rows: number, offset = 0): CoachLine[] {
  if (lines.length <= rows) return lines;

  // The separators stay.
  //
  // They used to be dropped once the thread outgrew the pane, on the reasoning
  // that a blank row is worth less than the sentence it displaces. That was
  // wrong, and wrong in a way that only showed up in use: the thread outgrows
  // the pane after about two exchanges, so in practice the blank rows were
  // almost never there. Every separator this file carefully inserts -- between
  // blocks, between speakers, after a guard -- was being filtered out one step
  // before it reached the screen, and the panel collapsed into the slab it was
  // built to avoid.
  //
  // The rows a separator costs are the cheapest rows in the pane. What they buy
  // is the only structure the panel has.
  const back = Math.min(Math.max(0, offset), Math.max(0, lines.length - rows));
  const end = lines.length - back;
  const window = lines.slice(Math.max(0, end - rows), end);

  // A window that happens to begin on a separator would spend its first row on
  // nothing, so that one is dropped and the row goes back to the text above it.
  while (window.length > 0 && coachLineText(window[0]).length === 0) {
    const earlier = lines[end - window.length - 1];
    window.shift();
    if (earlier !== undefined) window.unshift(earlier);
    else break;
  }

  return window;
}

/**
 * How far back the panel can be scrolled, so the caller can say so.
 *
 * Measured the same way `windowCoach` measures it -- separators dropped -- or
 * the panel would report rows that scrolling cannot reach.
 */
function coachDepth(lines: CoachLine[], rows: number): number {
  if (lines.length <= rows) return 0;
  return Math.max(0, lines.length - rows);
}

/** Rows the stacked band would take, borders and label included. Zero if idle. */
function coachBandCost(view: TerminalView): number {
  return (view.coach ?? []).length === 0 ? 0 : COACH_BAND_ROWS + 2;
}

/** side, qty, price, type, status, mode -- everything but the id and the expiry. */
const ORDER_COLUMNS = 5 + 8 + 9 + 7 + 8 + 7;
const ORDER_EXPIRY_WIDTH = 8;

/** How many rows one event may occupy in the log. */
const ACTIVITY_MAX_ROWS = 2;

/** Where an event's message begins, which is where a wrapped tail lines up. */
const ACT_TIME = 2;
const ACT_EVENT = 18;
const ACT_SIDE = 26;
const ACT_QTY = 32;
const ACT_PRICE = 43;
const ACT_STATUS = 54;

/** The message column of a wide-layout row, columns included or not. */
function messageColumn(event: ActivityRowView): number {
  const detail = event.detail;
  if (!detail) return ACT_SIDE;
  return detail.status ? ACT_STATUS + detail.status.length + 2 : ACT_STATUS;
}

/**
 * One painted row: an event, or the continuation of one whose message ran past
 * the region.
 */
interface ActivityLine {
  event: ActivityRowView;
  /** The part of the message this row carries. */
  text: string;
  /** False on continuation rows, which repeat neither the time nor the columns. */
  head: boolean;
}

/**
 * Events expanded into the rows they will occupy.
 *
 * A guardrail warning is a sentence rather than a field, and clipping it at the
 * region's edge loses the half that says what to do about it. Wrapping happens
 * here, before the region is windowed, so the row count and the scroll offset
 * both count what is actually on screen rather than what was logged.
 */
function wrapActivity(
  activity: ActivityRowView[],
  stop: number,
  column: (event: ActivityRowView) => number
): ActivityLine[] {
  const out: ActivityLine[] = [];

  for (const event of activity) {
    const pieces = wrapText(event.message, Math.max(1, stop - column(event)));
    // No message, but the columns of a trade event still have something to say.
    if (pieces.length === 0) {
      out.push({ event, text: '', head: true });
      continue;
    }

    // Two rows at most. Messages are condensed before they get here, so this is
    // a backstop rather than the mechanism -- but the log's value is that a
    // session can be scanned, and one event that takes six rows destroys that
    // for the twenty events it pushes off the top.
    const shown = pieces.slice(0, ACTIVITY_MAX_ROWS);
    if (pieces.length > ACTIVITY_MAX_ROWS) {
      const last = shown.length - 1;
      const room = Math.max(1, stop - column(event));
      shown[last] = `${shown[last].slice(0, Math.max(0, room - 1)).trimEnd()}…`;
    }

    shown.forEach((text, index) => out.push({ event, text, head: index === 0 }));
  }

  return out;
}

/** The slice of activity to show, given how far back the view is scrolled. */
function windowActivity(
  rows: ActivityLine[],
  height: number,
  offset: number
): ActivityLine[] {
  const maxOffset = Math.max(0, rows.length - height);
  const back = Math.min(Math.max(0, offset), maxOffset);
  const end = rows.length - back;
  return rows.slice(Math.max(0, end - height), end);
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
 * a message wraps against the divider instead of running through the panel next
 * to it.
 */
function paintActivity(line: Line, row: ActivityLine, stop: number): Line {
  const inner = stop;
  const event = row.event;

  // A continuation sits under the message it belongs to with its columns left
  // empty, so one event reads as one block rather than as several events.
  if (!row.head) return line.put(messageColumn(event), row.text, VALUE, inner);

  line
    .put(ACT_TIME, event.time, MUTED, ACT_EVENT)
    .put(ACT_EVENT, event.category, categoryColor(event.category), ACT_SIDE);

  const detail = event.detail;
  if (!detail) {
    line.put(ACT_SIDE, row.text, VALUE, inner);
    return line;
  }

  if (detail.side) line.put(ACT_SIDE, detail.side, sideColor(detail.side), ACT_QTY);
  if (detail.quantity) line.putRight(ACT_PRICE - 2, detail.quantity, VALUE, ACT_QTY);
  if (detail.price) line.putRight(ACT_STATUS - 2, detail.price, VALUE, ACT_PRICE);
  if (detail.status) line.put(ACT_STATUS, detail.status, statusColor(detail.status), inner);

  // Anything the columns don't cover follows them rather than being lost.
  if (row.text) line.put(messageColumn(event), row.text, VALUE, inner);

  return line;
}

/**
 * The ACTIVITY heading, and how far back the log is scrolled.
 *
 * It used to carry the coach's label and the standing guard conditions as well,
 * because the coach shared this row's block and there was nowhere else to put
 * them. Both now live in the coach column -- the label at its own top, the
 * guard as the intervention it is -- so this row says one thing again.
 */
function activityLabel(
  view: TerminalView,
  width: number,
  rows: number,
  total: number,
  stop: number = width - 2,
  divider?: number
): Line {
  const line = new Line(width).put(2, 'ACTIVITY', SECTION, stop);
  if (divider !== undefined && divider > 0) line.divider(divider);

  const offset = view.activityOffset ?? 0;
  if (offset > 0) {
    const behind = Math.min(offset, Math.max(0, total - rows));
    line.put(12, `scrolled back ${behind}`, 'yellow', stop);
  }

  return line;
}

/** The stacked band's own label, which carries the same scroll marker. */
function coachBandLabel(width: number, behind: number): Line {
  const line = new Line(width).put(2, 'COACH', SECTION);
  if (behind > 0) line.put(10, `scrolled back ${behind}`, 'yellow', width - 2);
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
    // The coach band, when there is a conversation to put in it. It was left
    // out, so a thread on a short terminal grew the frame past the bottom of
    // the screen and took the command line with it.
    coachBandCost(view) +
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
  // The band's rows are already out of the budget above, so the log takes what
  // is left rather than subtracting them a second time.
  const bandCost = coachBandCost(view);
  const logRows = Math.max(1, activityRows);

  const wrapped = wrapActivity(activity, inner, () => 21);
  lines.push(activityLabel(view, width, logRows, wrapped.length));
  const visible = windowActivity(wrapped, logRows, view.activityOffset ?? 0);
  for (let row = 0; row < logRows; row++) {
    const line = new Line(width);
    const entry = visible[row];
    if (entry) {
      if (entry.head) {
        line
          .put(2, entry.event.time.slice(0, 11), 'gray', 14)
          .put(14, entry.event.category, categoryColor(entry.event.category), 21);
      }
      line.put(21, entry.text, VALUE, inner);
    }
    lines.push(line);
  }

  if (bandCost > 0) {
    const spoken = coachLines(view, inner - 3);
    const offset = view.coachOffset ?? 0;
    lines.push(border());
    lines.push(
      coachBandLabel(width, Math.min(offset, coachDepth(spoken, COACH_BAND_ROWS)))
    );
    const band = windowCoach(spoken, COACH_BAND_ROWS, offset);
    for (let row = 0; row < COACH_BAND_ROWS; row++) {
      const said = band[row];
      lines.push(
        said ? putCoachLine(new Line(width), 2, said, inner) : new Line(width)
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

/**
 * Where the coach panel begins, or null when it is not beside the log.
 *
 * Only the frame knows how it laid itself out, and the screen has to know to
 * send a wheel event to the panel the pointer is actually over. Kept next to
 * the layout choice it mirrors so the two cannot drift apart.
 */
export function coachPanelColumn(size: Size): number | null {
  if (size.width < STACK_BELOW_WIDTH) return null;
  return coachColumn(Math.max(MIN_WIDTH, size.width));
}

/**
 * How wide the coach's prose column is, in characters.
 *
 * Told to the coach so that 'no longer than five rows' means five rows of the
 * panel it is actually going into. Only the frame knows how it laid itself out,
 * so the number comes from here rather than being assumed at the other end.
 */
export function coachProseWidth(size: Size): number {
  const width = Math.max(MIN_WIDTH, size.width);
  const column = coachColumn(width);
  if (column === null) return Math.max(8, width - 4);
  return Math.max(8, width - 1 - (column + 2) - 1);
}

export function buildFrame(view: TerminalView, size: Size): Line[] {
  if (size.width < STACK_BELOW_WIDTH) return buildStackedFrame(view, size);
  return buildWideFrame(view, size);
}

function buildWideFrame(view: TerminalView, size: Size): Line[] {
  const width = Math.max(MIN_WIDTH, size.width);
  const inner = width - 1;
  const lines: Line[] = [];
  const { header, market, position, orders, chase, activity } = view;

  // --- the two columns ----------------------------------------------------
  //
  // One divider, running from just below the shared header to the bottom
  // border, with the trading workspace on the left and the coach on the right.
  // Everything below is expressed against `leftEnd` rather than against the
  // frame edge, so the trading side lays itself out inside its own column and
  // never has to know what is beside it.
  const coachCol = coachColumn(width);
  const sidebar = coachCol !== null;
  const leftEnd = sidebar ? (coachCol as number) : inner;
  /**
   * Where POSITION gives way to ACTIVE ORDERS, inside the left column.
   *
   * The position panel takes what its content requires and no more; the orders
   * table takes the rest. It used to be an even split, which gave the panel
   * about twenty columns of whitespace to the right of every value while the
   * table next to it was dropping a column for want of two.
   */
  const splitCol = Math.max(24, Math.min(POSITION_NEED, leftEnd - 24));
  const coachTextCol = sidebar ? (coachCol as number) + 2 : 0;
  // One column short of the edge: text flush against a border reads as though
  // it has been cut off, whether or not it has.
  const coachWidth = sidebar ? Math.max(8, inner - coachTextCol - 1) : 0;

  // What has been typed at the coach prompt, wrapped to its column. Computed
  // once: the row below paints its tail and the rows above paint the rest.
  const typedIntoCoach = (view.coachInput ?? '').length > 0;
  const typedWrap = sidebar
    ? coachInputRows(size, typedIntoCoach ? (view.coachInput as string) : 'Ask coach...')
    : { rows: [''], truncated: false };
  const coachInput = typedWrap.rows;

  const teeGlyph = (kind: 'down' | 'up' | 'cross'): string =>
    kind === 'down' ? box.teeDown : kind === 'up' ? box.teeUp : box.cross;

  /** A rule across the whole application: above the columns, and below them. */
  const fullBorder = (
    opts: { edge?: 'top' | 'bottom'; coachTee?: 'down' | 'up' | 'cross' } = {}
  ): Line => {
    const left = opts.edge === 'top' ? box.tl : opts.edge === 'bottom' ? box.bl : box.teeRight;
    const right = opts.edge === 'top' ? box.tr : opts.edge === 'bottom' ? box.br : box.teeLeft;

    const line = new Line(width, false);
    line.put(0, left + box.h.repeat(width - 2) + right, undefined, width);
    if (sidebar && opts.coachTee) {
      line.put(coachCol as number, teeGlyph(opts.coachTee), undefined, width);
    }
    return line;
  };

  /**
   * A rule across the trading workspace only, stopping at the divider.
   *
   * This is what makes the two sides read differently. The left is a stack of
   * structured modules and its rules close against the divider; the coach
   * column runs past them uninterrupted, so it reads as one continuous
   * workspace rather than as a set of panels that happen to be empty.
   */
  const leftBorder = (opts: { divider?: 'down' | 'up' | 'cross' } = {}): Line => {
    const line = new Line(width, false);

    if (!sidebar) {
      line.put(0, box.teeRight + box.h.repeat(width - 2) + box.teeLeft, undefined, width);
      if (opts.divider) line.put(splitCol, teeGlyph(opts.divider), undefined, width);
      return line;
    }

    const col = coachCol as number;
    line.put(
      0,
      box.teeRight + box.h.repeat(Math.max(0, col - 1)) + box.teeLeft,
      undefined,
      width
    );
    if (opts.divider) line.put(splitCol, teeGlyph(opts.divider), undefined, width);
    // The coach side of the row is empty, but the frame still has an edge.
    line.put(width - 1, box.v, undefined, width);
    return line;
  };

  /** A content row, with the divider already in place. */
  const row = (): Line => {
    const line = new Line(width);
    if (sidebar) line.divider(coachCol as number);
    return line;
  };

  const { splitRows, activityRows, showRanges } = planHeight(
    Math.max(MIN_HEIGHT, size.height),
    chase !== null
  );

  // --- shared application header, above both columns ----------------------
  //
  // Balance, equity, the connection state and the account describe the trading
  // session rather than either column, so they stay full width and above the
  // divider. Nothing here belongs to the coach and nothing here belongs to the
  // workspace.
  lines.push(fullBorder({ edge: 'top' }));

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

  lines.push(fullBorder({ coachTee: 'down' }));

  // Everything from here to the input row shares its rows with the coach pane.
  const coachTop = lines.length;

  // --- market: symbol and last price lead, the rest supports -------------
  lines.push(row().put(2, 'MARKET', SECTION, leftEnd));

  // Four evenly spaced columns, so the primary and secondary rows line up with
  // each other and every value keeps a fixed starting position. Measured across
  // the left column now rather than the terminal, so the sidebar narrowing the
  // workspace tightens the market row instead of pushing it under the divider.
  const col1 = Math.max(18, Math.min(26, 2 + 'Symbol '.length + market.symbol.length + 2));
  const span = Math.max(12, Math.floor((leftEnd - col1) / 4));
  const col2 = col1 + span;
  const col3 = col2 + span;
  const col4 = col3 + span;

  const field = (line: Line, col: number, label: string, value: string, limit: number) =>
    labelled(line, col, label, value, Math.min(limit, leftEnd));

  const primaryRow = row();
  labelled(primaryRow, 2, 'Symbol', market.symbol, col1, HEADLINE);
  labelled(primaryRow, col1, 'Last', market.last, col2, HEADLINE);
  field(primaryRow, col2, 'Bid', market.bid, col3);
  field(primaryRow, col3, 'Ask', market.ask, col4);
  if (market.change && market.change !== NO_VALUE && col4 < leftEnd - 6) {
    labelled(primaryRow, col4, '24h', market.change, leftEnd, signedColor(market.change) ?? VALUE);
  }
  lines.push(primaryRow);

  const secondaryRow = row();

  // Funding takes two of the four cells; spread takes the last one.
  //
  // It used to sit in one cell with spread beneath Ask, and that was fine while
  // the row ran the width of the terminal. Once the coach took a quarter of it
  // a cell was about twelve columns, and '0.0100% (10.95% APR)' is twenty --
  // so the annualised figure was quietly dropped on every redraw. The rate on
  // its own is the half of that value that looks like nothing: a hundredth of a
  // percent reads as negligible until it is annualised.
  //
  // So spread moves one cell right, to sit under 24h. It is still on the row
  // and still beside the prices it comes from, which is what its position was
  // there to say.
  const spreadCol = col4;
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
  labelled(secondaryRow, spreadCol, 'Spread', market.spread, leftEnd);
  lines.push(secondaryRow);

  // --- range: where price has been over each period ----------------------
  //
  // Rendered whenever there is height for it, whether or not the numbers have
  // arrived. It used to appear only once `ranges` was non-empty, which meant
  // the first seconds of a session had no RANGE block -- and POSITION, ACTIVE
  // ORDERS and ACTIVITY all sat five rows higher than where they were about to
  // end up, then jumped. A region's existence is a property of the layout; only
  // its contents are a property of the data.
  if (showRanges) {
    lines.push(leftBorder());
    for (const line of rangeBlock(view.ranges, width, leftEnd)) {
      if (sidebar) line.divider(coachCol as number);
      lines.push(line);
    }
  }

  // --- confirmation takes the place of position/orders when pending --------
  if (view.confirmation) {
    // The panel wants nine rows and must not be cut short -- it is the last
    // thing read before something irreversible is sent. So it borrows from the
    // log rather than from the frame: the two together spend exactly what the
    // position block and the log would have spent, which is what keeps the
    // frame the height of the terminal.
    const wanted = 9;
    const budget = splitRows + activityRows;
    const confirmRows = Math.min(Math.max(splitRows, wanted), budget - 1);
    const logRows = Math.max(1, budget - confirmRows);

    for (const line of confirmationBlock(view.confirmation, width, confirmRows, leftEnd)) {
      if (sidebar) line.divider(coachCol as number);
      lines.push(line);
    }

    lines.push(leftBorder());
    lines.push(row().put(2, 'ACTIVITY', SECTION, leftEnd));

    const pending = wrapActivity(activity, leftEnd, messageColumn).slice(-logRows);
    for (let index = 0; index < logRows; index++) {
      const line = row();
      const entry = pending[index];
      if (entry) paintActivity(line, entry, leftEnd);
      lines.push(line);
    }

    lines.push(coachInput.length === 1 ? fullBorder({ coachTee: 'cross' }) : leftBorder());
    lines.push(inputRow());
    lines.push(fullBorder({ edge: 'bottom', coachTee: 'up' }));
    paintCoach(lines, coachTop, lines.length - 2 - coachInput.length);
    paintCoachInput(lines, lines.length - 2);
    return lines;
  }

  // --- position | active orders -----------------------------------------
  lines.push(leftBorder({ divider: 'down' }));
  lines.push(
    row()
      .divider(splitCol)
      .put(2, 'POSITION', SECTION, splitCol)
      .put(splitCol + 2, 'ACTIVE ORDERS', SECTION, leftEnd)
  );

  // The full form is preferred; the short one is used only when the panel can't
  // hold it, so an unprotected quantity is never silently cut off.
  const riskRoom = splitCol - 21 - 1;
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
        // A cost of carrying the position, so it sits with the other one rather
        // than among the leverage figures.
        ...(position.funding
          ? ([
              [
                `Funding(${position.fundingCurrency || 'quote'})`,
                position.funding,
                signedColor(position.funding),
              ],
            ] as Array<[string, string, Paint | undefined]>)
          : []),
        ['Leverage', position.leverage, undefined],
        ['Effective Leverage', position.effectiveLeverage, undefined],
        ['Liquidation', position.liquidation, undefined],
      ]
    : [];

  // Columns run left to right across the panel. Widths come from the space
  // available, and the order id gives up room first: it identifies an order but
  // you don't trade on it, whereas side, size, price, type and status are what
  // you read when deciding whether to act.
  const panelStart = splitCol + 2;
  const panelWidth = Math.max(20, leftEnd - panelStart);
  // Width decides this, not whether a chase happens to be running: a column that
  // came and went with the chase would shift every other value sideways.
  const showExpiry = panelWidth >= ORDER_COLUMNS + ORDER_EXPIRY_WIDTH + 4;
  const fixed = ORDER_COLUMNS + (showExpiry ? ORDER_EXPIRY_WIDTH : 0);
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

  for (let index = 0; index < bodyRows; index++) {
    const line = row().divider(splitCol);

    if (index === 0) {
      if (idWidth > 0) line.put(oId, 'ID', LABEL, oSide - 1);
      line
        .put(oSide, 'SIDE', LABEL, oQty)
        .putRight(oPrice - 2, 'QTY', LABEL, oQty)
        .putRight(oType - 2, 'PRICE', LABEL, oPrice)
        .put(oType, 'TYPE', LABEL, oStatus)
        .put(oStatus, 'STATUS', LABEL, oManaged)
        .put(oManaged, 'MODE', LABEL, showExpiry ? oExpires : leftEnd);
      if (showExpiry) line.put(oExpires, 'EXPIRES', LABEL, leftEnd);
    } else {
      const order = orders[index - 1];
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
               showExpiry ? oExpires : leftEnd);
        if (showExpiry) {
          // Amber near the end: a chase about to give up is worth noticing
          // before it does.
          const nearlyDone = /^00:0\d$/.test(order.expires ?? '');
          line.put(oExpires, order.expires, nearlyDone ? 'yellow' : VALUE, leftEnd);
        }
      } else if (index === 1 && orders.length === 0) {
        line.put(panelStart, 'No active orders', MUTED, leftEnd);
      }
    }

    const entry = positionFields[index];
    if (entry) {
      labelledAt(line, 2, entry[0], valueCol, entry[1], splitCol, entry[2] ?? VALUE);
    } else if (index === 0 && !position) {
      line.put(2, 'No open position', MUTED, splitCol);
    }

    lines.push(line);
  }

  // --- chase: only present while one is running --------------------------
  lines.push(leftBorder({ divider: 'up' }));
  if (chase) {
    lines.push(row().put(2, 'CHASE', SECTION, leftEnd));
    lines.push(
      row().put(2, chase.side, sideColor(chase.side), 7).put(7, chase.quantity, VALUE, leftEnd)
    );

    const q1 = 2;
    const q2 = Math.floor(leftEnd * 0.34);
    const q3 = Math.floor(leftEnd * 0.58);
    const q4 = Math.floor(leftEnd * 0.80);
    lines.push(
      row()
        .put(q1, 'Target', LABEL, q1 + 11)
        .put(q1 + 12, chase.target, VALUE, q2)
        .put(q2, 'Working', LABEL, q2 + 8)
        .put(q2 + 8, chase.working, VALUE, q3)
        .put(q3, 'Reprices', LABEL, q3 + 9)
        .put(q3 + 9, chase.reprices, VALUE, q4)
        .put(q4, 'Elapsed', LABEL, q4 + 8)
        .put(q4 + 8, chase.elapsed, VALUE, leftEnd)
    );
    lines.push(
      row().put(2, 'Status', LABEL).put(14, chase.status, statusColor(chase.status), leftEnd)
    );
    lines.push(leftBorder());
  }

  // --- activity, full width of the trading workspace ----------------------
  //
  // The coach no longer takes its right half, so the log gets one uninterrupted
  // rectangle from the frame edge to the divider -- plus the two rows the
  // static command footer used to occupy.
  const logRows = Math.max(1, activityRows);
  const wrapped = wrapActivity(activity, leftEnd, messageColumn);

  lines.push(activityLabel(view, width, logRows, wrapped.length, leftEnd, sidebar ? (coachCol as number) : undefined));

  const visible = windowActivity(wrapped, logRows, view.activityOffset ?? 0);

  for (let index = 0; index < logRows; index++) {
    const line = row();
    const entry = visible[index];
    if (entry) paintActivity(line, entry, leftEnd);
    lines.push(line);
  }

  // --- the two prompts, forming the bottom edge of the application --------
  // A rule over both prompts, not just the left one.
  //
  // The trading prompt has always had one and the coach prompt had none, so the
  // conversation ran straight into the thing being typed and the two halves of
  // the bottom edge did not match. When the question is one line -- which it
  // usually is -- this is a single rule across the frame with the divider
  // crossing it, and the two prompts sit under it level with each other.
  lines.push(coachInput.length === 1 ? fullBorder({ coachTee: 'cross' }) : leftBorder());
  lines.push(inputRow());
  lines.push(fullBorder({ edge: 'bottom', coachTee: 'up' }));

  paintCoach(lines, coachTop, lines.length - 2 - coachInput.length);
  paintCoachInput(lines, lines.length - 2);

  return lines;

  /**
   * The execution prompt and the coach prompt, side by side.
   *
   * Two prompts rather than one, because they do categorically different
   * things: the left one sends orders and the right one asks questions, and a
   * shared prompt would make the difference a matter of remembering which mode
   * it was in. The focused one keeps the cyan caret; the other dims, so which
   * one a keystroke will reach is visible without typing anything.
   */
  function inputRow(): Line {
    const line = row();
    const focused = (view.focus ?? 'command') === 'command';

    line.put(2, '>', focused ? 'cyan' : MUTED).put(4, view.input, HEADLINE, leftEnd);

    if (sidebar) {
      // The marker leads the block, so on the usual one-line question it sits
      // on this row level with the trading prompt, and on a wrapped one it
      // leads from the top like any other prompt. The last row is here either
      // way, which is what keeps the bottom edge of the two columns aligned.
      const single = coachInput.length <= 1;
      line.put(coachTextCol, single ? '>' : ' ', focused ? MUTED : 'cyan');
      line.put(
        coachTextCol + 2,
        coachInput[coachInput.length - 1],
        typedIntoCoach ? COACH_YOU_TEXT : MUTED,
        inner
      );
    }

    return line;
  }

  /**
   * The rows a wrapped question takes above the prompt row.
   *
   * Painted after the frame is built, into the bottom of the coach column,
   * because that is the only region that can afford them: the left column's
   * rows are all spoken for and its prompt must not move. The conversation
   * above gives up a row for each one, and gets it back the moment the question
   * is sent.
   */
  function paintCoachInput(rows: Line[], promptIndex: number): void {
    if (!sidebar) return;

    // A wrapped question grows upward and its rule rises with it, so the text
    // being typed always sits inside its own region rather than being cut off
    // from its prompt by a line through the middle of it. At one row the rule
    // is the frame-wide one already drawn above, and there is nothing to do.
    if (coachInput.length > 1) {
      const column = coachCol as number;
      const rule = rows[promptIndex - coachInput.length];
      if (rule) {
        rule.put(
          column,
          box.teeRight + box.h.repeat(Math.max(0, width - column - 2)) + box.teeLeft,
          undefined,
          width
        );
      }
    }

    for (let index = 0; index < coachInput.length - 1; index++) {
      const target = promptIndex - (coachInput.length - 1) + index;
      if (target < coachTop) continue;

      // A question long enough to scroll shows where it was cut, or the row it
      // continues from reads as the row it began on.
      const marker = index === 0 ? (typedWrap.truncated ? '…' : '>') : ' ';
      rows[target].put(
        coachTextCol,
        marker,
        index === 0 && typedWrap.truncated
          ? MUTED
          : (view.focus ?? 'command') === 'command'
            ? MUTED
            : 'cyan'
      );
      rows[target].put(coachTextCol + 2, coachInput[index], COACH_YOU_TEXT, inner);
    }
  }

  /**
   * Fills the coach column, from its heading down to the last row above the
   * prompts.
   *
   * Painted last, over rows the trading side has already finished with. The
   * alternative -- interleaving it as the left column is built -- would tie the
   * two sides' row counts together, and the whole point of the composition is
   * that the coach does not care how many sections the workspace has.
   */
  function paintCoach(rows: Line[], from: number, until: number): void {
    if (!sidebar) return;

    const height = until - from;
    if (height <= 2) return;

    rows[from].put(coachTextCol, 'COACH', SECTION, inner);

    // The heading keeps its row and the conversation starts under it.
    const bodyTop = from + 2;
    const bodyRows = until - bodyTop;
    if (bodyRows <= 0) return;

    const spoken = coachPaneLines(view, coachWidth);
    const offset = view.coachOffset ?? 0;

    const behind = Math.min(offset, coachDepth(spoken, bodyRows));
    if (behind > 0) {
      rows[from].put(coachTextCol + 6, `scrolled back ${behind}`, 'yellow', inner);
    }

    const window = windowCoach(spoken, bodyRows, offset);
    for (let index = 0; index < window.length; index++) {
      putCoachLine(rows[bodyTop + index], coachTextCol, window[index], inner);
    }
  }
}

export function renderPlain(view: TerminalView, size: Size): string[] {
  return buildFrame(view, size).map((line) => line.plain());
}

export function renderPainted(view: TerminalView, size: Size): string[] {
  return buildFrame(view, size).map((line) => line.painted());
}
