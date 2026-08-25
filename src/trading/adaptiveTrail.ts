// src/trading/adaptiveTrail.ts
//
// Decides whether a working trailing stop should be moved, and where to.
//
// Pure: no exchange, no clock, no I/O. This is the function that can close a
// position at the wrong price if it is wrong, so it is kept somewhere it can be
// tested directly rather than inferred from live behaviour.

export type TrailSide = 'long' | 'short';

export interface TrailState {
  side: TrailSide;
  /**
   * The trail distance currently on the order, as a positive number.
   *
   * The exchange stores this signed -- negative for a sell-side trail -- but the
   * sign is direction, which `side` already carries.
   */
  peg: number;
  /** The trigger price currently on the order. */
  stop: number;
  /** Current mark price. Trails are triggered on the mark. */
  mark: number;
}

export interface TrailPolicy {
  /** What volatility says the distance from the extreme should be. */
  desiredDistance: number;
  /** Smallest price step this market can express. */
  tick: number;
  /**
   * How much the stop must improve, as a fraction of the current distance,
   * before an amendment is worth sending. Every amendment is a request the
   * exchange can reject; moving the stop two cents an hour is not worth one.
   */
  minimumImprovementFraction: number;
  /** How far a new stop must stay from the mark, in ticks. */
  safetyTicks: number;
}

export type TrailPlan =
  | { action: 'hold'; reason: string }
  | { action: 'move'; peg: number; stop: number; reason: string };

const round = (value: number, tick: number): number =>
  tick > 0 ? Math.round(value / tick) * tick : value;

/**
 * Where the exchange's high-water mark must be.
 *
 * Phemex tracks the extreme internally and does not report it, but it is
 * recoverable: the trigger it publishes is the extreme less the trail distance,
 * so the extreme is the trigger plus that distance back again. Verified against
 * a live order -- trigger 97.57 with a 5.08 trail implies a 102.65 high, which
 * matched the session high.
 */
export function impliedExtreme(state: TrailState): number {
  const direction = state.side === 'long' ? 1 : -1;
  return state.stop + direction * state.peg;
}

/**
 * Whether to move a working trail, and where to.
 *
 * The rule is that the stop level ratchets: it may rise for a long and fall for
 * a short, never the reverse. The peg is only the means -- it is free to widen,
 * provided the extreme has risen enough to pay for the widening and still leave
 * the stop better than it was. That is what lets the trail loosen when
 * volatility expands without ever giving back protection already earned.
 *
 * Three things stop a move:
 *
 *   - it would not improve the stop, so there is nothing to gain
 *   - the improvement is too small to be worth an amendment
 *   - it would put the stop at or through the mark
 *
 * The third is the dangerous one. A collapse in volatility produces a very
 * short desired distance, and the extreme does not fall, so the resulting
 * trigger can land above the current price -- closing the position instantly at
 * market. That is a stop-out caused by volatility *falling*, which is the exact
 * opposite of what a trail is for. The stop is clamped to a safe distance from
 * the mark instead.
 */
export function planTrailAdjustment(
  state: TrailState,
  policy: TrailPolicy
): TrailPlan {
  const { side, peg, stop, mark } = state;
  const { desiredDistance, tick, minimumImprovementFraction, safetyTicks } = policy;

  if (!(peg > 0) || !Number.isFinite(peg)) {
    return { action: 'hold', reason: 'the order carries no usable trail distance' };
  }
  if (!Number.isFinite(stop) || !Number.isFinite(mark) || mark <= 0) {
    return { action: 'hold', reason: 'no usable price for this order' };
  }
  if (!(desiredDistance > 0) || !Number.isFinite(desiredDistance)) {
    return { action: 'hold', reason: 'volatility could not be measured' };
  }

  // 1 for a long, where better means higher; -1 for a short, where it means
  // lower. Everything below is written once and works for both.
  const direction = side === 'long' ? 1 : -1;
  const extreme = impliedExtreme(state);

  let target = extreme - direction * desiredDistance;

  // The stop may never end up at or through the mark.
  const safetyGap = Math.max(safetyTicks, 1) * (tick > 0 ? tick : 0);
  const ceiling = mark - direction * safetyGap;

  if (direction * (ceiling - stop) <= 0) {
    // Even the closest safe stop is no better than the one already there.
    return {
      action: 'hold',
      reason: 'price is too close to the stop to move it safely',
    };
  }

  if (direction * (target - ceiling) > 0) {
    target = ceiling;
  }

  const improvement = direction * (target - stop);
  if (improvement <= 0) {
    return {
      action: 'hold',
      reason: 'volatility would widen the trail without a new extreme to pay for it',
    };
  }

  if (improvement < peg * minimumImprovementFraction) {
    return { action: 'hold', reason: 'improvement too small to be worth an amendment' };
  }

  const nextStop = round(target, tick);
  const nextPeg = round(direction * (extreme - nextStop), tick);

  if (!(nextPeg > 0)) {
    return { action: 'hold', reason: 'the resulting trail distance would be zero' };
  }

  // Rounding is to the tick and could in principle land back on the old stop.
  if (direction * (nextStop - stop) <= 0) {
    return { action: 'hold', reason: 'improvement disappears once rounded to the tick' };
  }

  return {
    action: 'move',
    peg: nextPeg,
    stop: nextStop,
    reason:
      nextPeg < peg
        ? 'volatility fell, tightening the trail'
        : 'a new extreme allows a wider trail with a better stop',
  };
}
