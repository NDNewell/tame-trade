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
