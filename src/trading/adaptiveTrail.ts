// src/trading/adaptiveTrail.ts
//
// Where a managed trailing stop should sit.
//
// Pure: no exchange, no clock, no I/O. This function can close a position at
// the wrong price if it is wrong, so it lives somewhere it can be tested
// directly rather than inferred from live behaviour.
//
// The whole rule is two numbers and one constraint:
//
//   high-water mark   the best price reached since the trail was placed
//   cushion           how far behind it the stop sits, from volatility
//
//   stop = high-water mark - cushion, and the stop never moves backwards.
//
// The stop being a ratchet is what makes volatility expansion free. When the
// market gets wilder the cushion wants to grow, which would put the stop lower;
// that is refused, so the stop simply stays where it is while new highs carry
// the high-water mark away from it. The gap widens on its own, without ever
// giving back protection already earned.

export type TrailSide = 'long' | 'short';

export interface TrailStopState {
  side: TrailSide;
  /**
   * Best price reached since the trail was placed: the highest mark for a long,
   * the lowest for a short. Tracked by this application rather than the
   * exchange, which is the point -- nothing else moves the stop.
   */
  highWaterMark: number;
  /** The trigger price currently resting on the exchange. */
  stop: number;
  /** Current mark price. Trails are triggered on the mark. */
  mark: number;
}

export interface TrailStopPolicy {
  /** How far behind the high-water mark the stop should sit: multiple x ATR. */
  cushion: number;
  /** Smallest price step this market can express. */
  tick: number;
  /**
   * How far the stop must improve, as a fraction of the cushion, before an
   * amendment is worth sending. Every amendment is a request the exchange can
   * reject, and moving a stop two cents is not worth one.
   */
  minimumImprovementFraction: number;
  /** How far a moved stop must stay clear of the mark. */
  safetyTicks: number;
}

export type TrailStopPlan =
  | { action: 'hold'; reason: string }
  | { action: 'move'; stop: number; reason: string };

const round = (value: number, tick: number): number =>
  tick > 0 ? Math.round(value / tick) * tick : value;

/**
 * Advances the high-water mark, which only ever moves one way.
 *
 * A price that fails to beat it leaves it alone -- that is what makes the trail
 * a trail rather than a stop that follows price back down.
 */
export function advanceHighWaterMark(
  side: TrailSide,
  current: number | undefined,
  mark: number
): number | undefined {
  if (!Number.isFinite(mark) || mark <= 0) return current;
  if (current === undefined || !Number.isFinite(current)) return mark;
  return side === 'long' ? Math.max(current, mark) : Math.min(current, mark);
}

/**
 * Where the stop should be moved to, or why it should be left alone.
 *
 * Three things stop a move:
 *
 *   - the new stop would be no better than the one already resting
 *   - the improvement is too small to be worth an amendment
 *   - it would put the stop at or through the current mark
 *
 * The third is the dangerous one and the reason the mark is an input at all. A
 * collapse in volatility shrinks the cushion sharply while the high-water mark
 * does not fall, so the computed stop can land above the current price -- which
 * would close the position immediately, at market, because volatility went
 * *down*. The stop is clamped to a safe distance below the mark instead.
 */
export function planTrailStop(
  state: TrailStopState,
  policy: TrailStopPolicy
): TrailStopPlan {
  const { side, highWaterMark, stop, mark } = state;
  const { cushion, tick, minimumImprovementFraction, safetyTicks } = policy;

  if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
    return { action: 'hold', reason: 'no high-water mark yet' };
  }
  if (!Number.isFinite(stop) || !Number.isFinite(mark) || mark <= 0) {
    return { action: 'hold', reason: 'no usable price for this order' };
  }
  if (!(cushion > 0) || !Number.isFinite(cushion)) {
    return { action: 'hold', reason: 'volatility could not be measured' };
  }

  // 1 for a long, where better means higher; -1 for a short, where it means
  // lower. Everything below is written once and works for both.
  const direction = side === 'long' ? 1 : -1;

  let target = highWaterMark - direction * cushion;

  // Never at or through the mark.
  const safetyGap = Math.max(safetyTicks, 1) * (tick > 0 ? tick : 0);
  const nearest = mark - direction * safetyGap;

  if (direction * (nearest - stop) <= 0) {
    return {
      action: 'hold',
      reason: 'price is too close to the stop to move it safely',
    };
  }

  if (direction * (target - nearest) > 0) target = nearest;

  const improvement = direction * (target - stop);

  if (improvement <= 0) {
    // The cushion is wider than the gap the stop already has. Leaving the stop
    // alone is what lets that gap widen by itself as new extremes arrive.
    return { action: 'hold', reason: 'the stop is already closer than the cushion asks for' };
  }

  if (improvement < cushion * minimumImprovementFraction) {
    return { action: 'hold', reason: 'improvement too small to be worth an amendment' };
  }

  const nextStop = round(target, tick);

  if (direction * (nextStop - stop) <= 0) {
    return { action: 'hold', reason: 'improvement disappears once rounded to the tick' };
  }

  return {
    action: 'move',
    stop: nextStop,
    reason:
      direction * (highWaterMark - stop) > cushion
        ? 'the high-water mark has moved ahead of the cushion'
        : 'volatility fell, so the cushion tightened',
  };
}
