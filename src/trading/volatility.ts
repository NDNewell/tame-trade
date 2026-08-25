// src/trading/volatility.ts
//
// Volatility measurement, and the trail distances derived from it.
//
// Pure functions over candles: no exchange, no clock, no I/O. A trailing stop
// sized from these decides when a position is closed, so the arithmetic is kept
// somewhere it can be tested directly rather than inferred from live behaviour.

/** One closed candle. Open and volume are not needed to measure range. */
export interface Candle {
  timestamp: number;
  high: number;
  low: number;
  close: number;
}

/**
 * True range for a candle, given the close before it.
 *
 * The plain high-low span understates a bar that gapped: if price opened well
 * away from the previous close, the distance travelled includes that gap. Taking
 * the widest of the three measures is what makes this "true" range rather than
 * just range.
 */
export function trueRange(candle: Candle, previousClose?: number): number {
  const span = candle.high - candle.low;
  if (previousClose === undefined || !Number.isFinite(previousClose)) return span;

  return Math.max(
    span,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose)
  );
}

/**
 * Average true range, using Wilder's smoothing.
 *
 * Wilder's is not a plain moving average: it seeds with the mean of the first
 * `period` ranges and then folds each later range in at weight 1/period. That is
 * what "ATR(14)" means everywhere it is quoted, and a simple rolling mean would
 * give a visibly different number for the same input.
 *
 * Returns undefined rather than a partial figure when there are not enough
 * candles to fill the period. A trail sized from three candles of history is not
 * a smaller ATR, it is a meaningless one.
 */
export function averageTrueRange(
  candles: Candle[],
  period: number
): number | undefined {
  if (!Number.isInteger(period) || period < 1) return undefined;
  // One extra candle is needed at the front: the first true range is measured
  // against the close before it.
  if (candles.length < period + 1) return undefined;

  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const range = trueRange(candles[i], candles[i - 1].close);
    if (!Number.isFinite(range) || range < 0) return undefined;
    ranges.push(range);
  }

  if (ranges.length < period) return undefined;

  let atr = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (let i = period; i < ranges.length; i++) {
    atr = (atr * (period - 1) + ranges[i]) / period;
  }

  return Number.isFinite(atr) && atr > 0 ? atr : undefined;
}

/**
 * Drops the candle still being formed.
 *
 * Exchanges return the in-progress candle as the last element. Its range only
 * grows as the period runs, so including it makes ATR drift upward through every
 * period and jump back on each close -- an adaptive trail reading that would
 * chase an artefact of when it happened to look.
 */
export function closedCandles(candles: Candle[], now: number, intervalMs: number): Candle[] {
  if (!(intervalMs > 0)) return candles;
  return candles.filter((candle) => candle.timestamp + intervalMs <= now);
}

export interface TrailSizing {
  /** Multiple of ATR the trail should stand off by. */
  multiple: number;
  /** Never trail closer than this, whatever volatility says. */
  minimumOffset?: number;
  /** Never trail wider than this. */
  maximumOffset?: number;
}

/**
 * The trail distance implied by current volatility.
 *
 * Bounds are applied after the multiple: a quiet market can otherwise produce a
 * trail so tight that ordinary spread noise closes the position, and a violent
 * one can produce a trail so wide it is no longer protection.
 */
export function atrTrailOffset(
  atr: number | undefined,
  sizing: TrailSizing
): number | undefined {
  if (atr === undefined || !Number.isFinite(atr) || atr <= 0) return undefined;
  if (!Number.isFinite(sizing.multiple) || sizing.multiple <= 0) return undefined;

  let offset = atr * sizing.multiple;

  if (sizing.minimumOffset !== undefined && Number.isFinite(sizing.minimumOffset)) {
    offset = Math.max(offset, sizing.minimumOffset);
  }
  if (sizing.maximumOffset !== undefined && Number.isFinite(sizing.maximumOffset)) {
    offset = Math.min(offset, sizing.maximumOffset);
  }

  return offset > 0 ? offset : undefined;
}

export interface RatchetInput {
  /** The offset the trail is currently working with. */
  current: number;
  /** What current volatility suggests it should be. */
  candidate: number | undefined;
  /**
   * How much tighter the candidate must be before it is worth acting on, as a
   * fraction of the current offset. Every change costs an amendment the exchange
   * can reject, and a trail that twitches on each candle is a trail that spends
   * its time being rewritten rather than protecting anything.
   */
  minimumChangeFraction?: number;
}

/**
 * The next trail offset, or undefined to leave it alone.
 *
 * The rule is that an adaptive trail tightens and never widens.
 *
 * Widening is wrong twice over. It increases the risk on a position already
 * open, which is the opposite of what a stop is for -- and for a long it means
 * moving the stop down, which a trailing stop by definition never does. It is
 * also the unsafe direction against a server-side trail: the exchange tracks the
 * extreme internally and we cannot read it, so tightening is predictable in a
 * way widening is not. Tightening can only improve the resulting level whatever
 * extreme the exchange is holding.
 *
 * So volatility collapsing pulls the stop in; volatility expanding leaves it
 * where it is.
 */
export function nextTrailOffset(input: RatchetInput): number | undefined {
  const { current, candidate } = input;
  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) {
    return undefined;
  }
  if (!Number.isFinite(current) || current <= 0) return undefined;

  // Wider, or the same: nothing to do.
  if (candidate >= current) return undefined;

  const threshold = input.minimumChangeFraction ?? 0;
  if (threshold > 0 && current - candidate < current * threshold) return undefined;

  return candidate;
}

/** A period the high/low panel reports over. */
export interface RangeWindow {
  label: string;
  minutes: number;
  /**
   * The candle size this window is measured on.
   *
   * Always the finest that still reaches back far enough, given a hundred
   * candles. Fine candles resolve the trailing edge of the window precisely but
   * run out of history quickly; coarse ones reach back a long way but would make
   * a five-minute window mean "the last five-minute candle", which is not the
   * same thing at all.
   */
  source: string;
  /**
   * The candle size ATR is measured on for this column, which is the column's
   * own period.
   *
   * Note that the two rows answer related but different questions. High and low
   * are the extremes over the last five minutes; ATR is what a five-minute bar
   * typically covers. Read together they say whether the range right now is
   * ordinary for this timeframe or not, which neither says alone.
   */
  atrTimeframe: string;
}

/**
 * Shortest first, as they are read left to right.
 *
 * The longer two are rolling spans, not calendar ones: 1w is the last seven
 * days and 1mo the last thirty, both measured from now rather than from a
 * Monday or the first of the month.
 */
export const RANGE_WINDOWS: RangeWindow[] = [
  { label: '5m', minutes: 5, source: '1m', atrTimeframe: '5m' },
  { label: '15m', minutes: 15, source: '1m', atrTimeframe: '15m' },
  { label: '30m', minutes: 30, source: '1m', atrTimeframe: '30m' },
  { label: '1h', minutes: 60, source: '1m', atrTimeframe: '1h' },
  { label: '4h', minutes: 240, source: '15m', atrTimeframe: '4h' },
  { label: '1d', minutes: 1440, source: '15m', atrTimeframe: '1d' },
  { label: '1w', minutes: 7 * 1440, source: '4h', atrTimeframe: '1w' },
  // The exchange spells a monthly candle '1M'; '1m' is a minute.
  { label: '1mo', minutes: 30 * 1440, source: '1d', atrTimeframe: '1M' },
];

export interface PriceRange {
  high: number;
  low: number;
}

/**
 * Highest high and lowest low over a trailing window.
 *
 * The window is rolling rather than the current candle of that size: "the last
 * hour" is what a reader means by 1h, whereas the current hourly candle resets
 * on the hour and would show a range of almost nothing at one minute past.
 *
 * `latest` is the current price, folded in so the range always contains it.
 * Exchanges publish closed candles only, so without this a fresh high sits
 * outside the range it belongs to until the candle closes -- a high of 101.20
 * printed while price trades at 101.50 reads as a fault, and correctly so.
 */
export function rangeOver(
  candles: Candle[],
  windowMs: number,
  now: number,
  latest?: number
): PriceRange | undefined {
  if (!(windowMs > 0)) return undefined;

  const since = now - windowMs;
  let high = -Infinity;
  let low = Infinity;

  for (const candle of candles) {
    // A candle is in the window if any part of it is, so the oldest one is
    // included rather than the window silently starting late.
    if (candle.timestamp < since) continue;
    if (Number.isFinite(candle.high)) high = Math.max(high, candle.high);
    if (Number.isFinite(candle.low)) low = Math.min(low, candle.low);
  }

  if (latest !== undefined && Number.isFinite(latest) && latest > 0) {
    high = Math.max(high, latest);
    low = Math.min(low, latest);
  }

  if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  return { high, low };
}

/** Extremes for one window, as the panel holds them. */
export interface WindowExtremes {
  high?: number;
  low?: number;
}

/**
 * Makes each window's extremes account for the narrower windows inside it.
 *
 * The windows all end at now and grow, so they nest: the last day contains the
 * last hour, which contains the last five minutes. A wider window's high can
 * therefore never be lower than a narrower one's, and if it is, the wider one is
 * simply out of date.
 *
 * Which it will be, because each window is measured on candles coarse enough to
 * span it. A spike that retraces enters the 1h column as soon as its minute
 * candle closes, but does not reach the 1d column until the fifteen-minute
 * candle holding it closes. The month is worse: measured on daily candles, it
 * would not show today's high until the day ended.
 *
 * Carrying the running extreme outward fixes both. It is not a smoothing or a
 * fudge -- the narrower window is a subset of the wider one, so its high is
 * genuinely part of the wider one's range, and the fine candles are simply
 * better evidence about recent time than the coarse ones have yet recorded.
 *
 * Expects windows ordered narrowest first.
 */
export function nestRanges(ranges: WindowExtremes[]): WindowExtremes[] {
  let high: number | undefined;
  let low: number | undefined;

  return ranges.map((range) => {
    if (range.high !== undefined && Number.isFinite(range.high)) {
      high = high === undefined ? range.high : Math.max(high, range.high);
    }
    if (range.low !== undefined && Number.isFinite(range.low)) {
      low = low === undefined ? range.low : Math.min(low, range.low);
    }

    // A window whose own data is missing stays missing. It still contributes
    // nothing and inherits nothing: showing a narrower window's extreme in its
    // place would read as a measurement of this window rather than an absence.
    return {
      high: range.high === undefined ? undefined : high,
      low: range.low === undefined ? undefined : low,
    };
  });
}
