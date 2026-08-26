// src/trading/exitPlan.ts
//
// How to get out of a position that should not be held any longer.
//
// The naive version of an intervention is a market order for the whole size.
// That is the one exit that is guaranteed to be available and it is almost
// never the cheapest: it pays the full spread, walks whatever depth is at the
// touch, and prints the entire position into the tape at once. On an illiquid
// perp that is a meaningful fraction of the loss the guard was trying to
// prevent.
//
// So this plans the exit instead. Three results from the execution literature
// do the work, and it is worth being explicit about which, because each one is
// the reason for a specific decision below:
//
//   Almgren-Chriss (2000). Liquidating a position trades market impact against
//   timing risk: go fast and you pay impact, go slow and the price moves while
//   you are still holding. Minimising expected cost plus lambda times its
//   variance gives a trajectory x(t) = X sinh(k(T-t)) / sinh(kT). The shape of
//   that result is what matters here: a risk-neutral trader (k -> 0) slices
//   evenly, which is TWAP, and a risk-averse one front-loads. We are always
//   risk-averse -- we are leaving because something is wrong -- so the schedule
//   below is front-weighted, and how sharply is the one knob urgency turns.
//
//   The square-root law of market impact. Impact grows roughly with the square
//   root of the fraction of volume taken, not linearly, which is why capping
//   participation matters much more than shaving the last few percent off it.
//   Child orders are sized against available liquidity for this reason.
//
//   Adverse selection on passive fills. A resting order is filled preferentially
//   when the market is about to move through it. Posting is not free: it saves
//   the half-spread and costs optionality. That is why passive slices carry a
//   patience limit and escalate rather than resting indefinitely.
//
// What is NOT modelled: a calibrated impact coefficient. Fitting eta and gamma
// needs execution history this application does not keep, and a made-up
// coefficient dressed up in the right equation is worse than an honest
// heuristic -- it looks authoritative and is not. So urgency parameterises the
// trajectory directly, and the numbers it produces are checkable by eye.
//
// Pure: no exchange, no clock, no I/O. Everything the plan needs is an argument.

export type Direction = 'long' | 'short';

/**
 * How much the exit is willing to pay for certainty.
 *
 *   measured   something should be closed, but nothing is on fire. Work the
 *              order, save the spread, accept that it takes a few minutes.
 *   firm       the reason for leaving is live and getting worse. Front-load
 *              hard, take liquidity when it is there.
 *   immediate  being flat now is worth more than any price improvement.
 */
export type ExitUrgency = 'measured' | 'firm' | 'immediate';

export interface ExitConditions {
  /** The side of the position being closed, not the side of the orders. */
  side: Direction;
  /** Quantity to be exited. */
  size: number;
  markPrice: number;
  bestBid: number;
  bestAsk: number;
  tick: number;
  /**
   * Quantity resting at the price we would have to hit.
   *
   * The cheapest proxy for 'how much can leave at once without walking the
   * book'. Absent on exchanges or feeds that don't give it, in which case the
   * plan falls back to time-based slicing only.
   */
  touchDepth?: number;
  /** Recent traded volume per minute, in the same units as `size`. */
  volumePerMinute?: number;
  /** ATR in price units, for judging how much can happen while we work. */
  atr?: number;
}

export interface ExitPolicy {
  /** The largest share of typical volume this exit will be. */
  maxParticipation: number;
  /** The longest the whole exit may take. */
  maxHorizonMs: number;
  /** The shortest gap between child orders. */
  minIntervalMs: number;
  /** A ceiling on child orders, whatever the arithmetic asks for. */
  maxSlices: number;
}

/**
 * Defaults chosen to be unremarkable.
 *
 * 15% participation is the conventional ceiling above which impact stops being
 * a rounding error; four minutes is long enough to work a retail-sized position
 * and short enough that the reason for leaving is probably still true when it
 * finishes.
 */
export const DEFAULT_EXIT_POLICY: ExitPolicy = {
  maxParticipation: 0.15,
  maxHorizonMs: 4 * 60_000,
  minIntervalMs: 5_000,
  maxSlices: 12,
};

/**
 * How a child order is priced.
 *
 *   passive  rest one tick inside the touch on our own side; earns the spread
 *   join     sit at the touch we would have to hit; fills against takers
 *   cross    cross the spread as a limit, which is a market order with a cap
 *   market   whatever is there
 *
 * 'cross' rather than a bare market order wherever possible: a marketable limit
 * gets the same immediacy with a bound on how far through the book it can go,
 * which is the difference between paying the spread and paying for a gap.
 */
export type SliceStyle = 'passive' | 'join' | 'cross' | 'market';

export interface ExitSlice {
  index: number;
  /** Milliseconds after the plan starts. */
  offsetMs: number;
  size: number;
  style: SliceStyle;
  /**
   * How long this child may rest before it is repriced more aggressively.
   *
   * The answer to adverse selection: a passive order that has not filled is
   * either mispriced or about to be run over, and both are answered by not
   * leaving it there.
   */
  patienceMs: number;
}

export interface ExitPlan {
  urgency: ExitUrgency;
  slices: ExitSlice[];
  /** When the last slice is scheduled. */
  horizonMs: number;
  /**
   * After this, anything still open is sent to market.
   *
   * The plan has to terminate. A clever exit that is still working an hour
   * later has become the thing it was preventing.
   */
  deadlineMs: number;
  /** Why this shape, in one line, for the log and the operator. */
  rationale: string;
  /**
   * Rough expected cost against the mark, in price units per unit of size.
   *
   * A comparison figure, not a forecast: its job is to show that working the
   * order is expected to beat crossing everything, and by roughly how much.
   */
  estimatedCost: number;
}

/**
 * Front-loading, from the Almgren-Chriss trajectory.
 *
 * `kappaT` is the whole risk-aversion story: at 0 the schedule is flat (TWAP,
 * the risk-neutral answer), and as it grows the early slices take more. Values
 * beyond about 3 are indistinguishable from 'send most of it immediately', so
 * urgency stops there.
 */
function trajectory(total: number, slices: number, kappaT: number): number[] {
  if (slices <= 1) return [total];

  const remaining = (fraction: number): number => {
    if (kappaT <= 1e-6) return total * (1 - fraction);
    return (total * Math.sinh(kappaT * (1 - fraction))) / Math.sinh(kappaT);
  };

  const sizes: number[] = [];
  for (let i = 0; i < slices; i++) {
    sizes.push(remaining(i / slices) - remaining((i + 1) / slices));
  }

  // Rounding must not lose or invent quantity: the last slice absorbs the
  // difference, because an exit that leaves a dust position behind has not
  // finished and an exit that oversells has opened a new one.
  const sum = sizes.reduce((a, b) => a + b, 0);
  sizes[sizes.length - 1] += total - sum;

  return sizes;
}

const KAPPA: Record<ExitUrgency, number> = {
  measured: 0.5,
  firm: 2,
  immediate: 3,
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * The exit, worked out.
 *
 * Reads in three steps: how much can leave at once, therefore how many children
 * and over what horizon, therefore what each one is and how it is priced.
 */
export function planExit(
  conditions: ExitConditions,
  urgency: ExitUrgency,
  policy: ExitPolicy = DEFAULT_EXIT_POLICY
): ExitPlan {
  const { size, bestBid, bestAsk, tick, markPrice } = conditions;

  const spread = Math.max(bestAsk - bestBid, 0);
  const halfSpread = spread / 2;
  // A one-tick spread is the case where working the order buys almost nothing:
  // there is no width to capture, so the only remaining reason to slice is
  // impact. Noted here because it changes the shape below.
  const spreadTicks = tick > 0 ? spread / tick : 0;

  const immediate = (reason: string): ExitPlan => ({
    urgency: 'immediate',
    slices: [
      { index: 0, offsetMs: 0, size, style: 'cross', patienceMs: 1_500 },
    ],
    horizonMs: 0,
    deadlineMs: 3_000,
    rationale: reason,
    estimatedCost: halfSpread,
  });

  if (!(size > 0)) {
    return { ...immediate('nothing to exit'), slices: [], estimatedCost: 0 };
  }

  if (urgency === 'immediate') {
    return immediate(
      'Immediate: being flat is worth more than the spread. One marketable ' +
        'limit, capped so a thin book cannot turn this into a gap fill.'
    );
  }

  // --- how much may leave at once ----------------------------------------
  //
  // Two independent ceilings, and the binding one wins. Depth at the touch says
  // how much can go without walking the book right now; participation says how
  // much can go without being most of the tape over the horizon.
  const depthCap =
    conditions.touchDepth !== undefined && conditions.touchDepth > 0
      ? conditions.touchDepth
      : Infinity;

  const horizonMinutes = policy.maxHorizonMs / 60_000;
  const volumeCap =
    conditions.volumePerMinute !== undefined && conditions.volumePerMinute > 0
      ? conditions.volumePerMinute * horizonMinutes * policy.maxParticipation
      : Infinity;

  // Neither is known: fall back to slicing by time alone, which is still worth
  // doing -- spreading over minutes is what limits timing-independent impact.
  const perChild = Math.min(depthCap, volumeCap === Infinity ? Infinity : volumeCap / 3);

  let slices =
    perChild === Infinity
      ? urgency === 'firm'
        ? 3
        : 5
      : Math.ceil(size / Math.max(perChild, 1e-12));

  // A one-tick spread removes most of the reason to be patient.
  if (spreadTicks <= 1 && slices > 3) slices = Math.min(slices, 3);

  slices = clamp(Math.round(slices), 1, policy.maxSlices);

  // --- over what horizon --------------------------------------------------
  //
  // Long enough to keep participation under the cap, short enough that the
  // market cannot move a large multiple of what the patience is buying. The
  // second is the volatility term in the Almgren-Chriss trade-off, and ATR is
  // the estimate of sigma this application already has.
  let horizonMs = slices * policy.minIntervalMs;

  if (conditions.volumePerMinute !== undefined && conditions.volumePerMinute > 0) {
    const needed = (size / (conditions.volumePerMinute * policy.maxParticipation)) * 60_000;
    horizonMs = Math.max(horizonMs, needed);
  }

  if (conditions.atr !== undefined && conditions.atr > 0 && halfSpread > 0) {
    // Expected drift over a horizon scales with the square root of time. Cap
    // the horizon where the drift we are exposing ourselves to is about twice
    // the spread we are trying to save -- past that, patience is a losing bet
    // regardless of how good the fills are.
    //
    // atr is per candle rather than per millisecond, so this is a ratio, not a
    // unit conversion: allow a fraction of an ATR's worth of drift.
    const tolerated = (2 * halfSpread) / conditions.atr;
    const cappedByVolatility = policy.maxHorizonMs * clamp(tolerated, 0.1, 1);
    horizonMs = Math.min(horizonMs, cappedByVolatility);
  }

  horizonMs = clamp(horizonMs, policy.minIntervalMs, policy.maxHorizonMs);
  if (urgency === 'firm') horizonMs = Math.min(horizonMs, policy.maxHorizonMs / 2);

  const interval = Math.max(policy.minIntervalMs, horizonMs / slices);

  // --- what each child is -------------------------------------------------
  const sizes = trajectory(size, slices, KAPPA[urgency]);

  // Patience shortens as the plan runs. An early slice can afford to wait for a
  // good fill; a late one is running out of horizon and should be taking what
  // is there. This is the escalation the executor follows.
  const schedule: ExitSlice[] = sizes.map((sliceSize, index) => {
    // How far through the schedule this child is, from 0 to 1. A single child
    // sits at 0, not 1: it is the *first* attempt, not the last-ditch one, and
    // treating it as the end of the schedule made a lone order on a wide book
    // cross the spread it should have been resting inside. Escalation is what
    // takes a child that will not fill through join and cross, and the deadline
    // is what guarantees the plan ends — neither needs the styles front-loaded
    // to be aggressive.
    const progress = slices === 1 ? 0 : index / (slices - 1);

    let style: SliceStyle;
    if (urgency === 'firm') {
      style = progress < 0.34 ? 'join' : 'cross';
    } else {
      style = progress < 0.5 ? 'passive' : progress < 0.85 ? 'join' : 'cross';
    }
    // Nothing to earn from resting when the book is one tick wide.
    if (style === 'passive' && spreadTicks <= 1) style = 'join';

    return {
      index,
      offsetMs: Math.round(index * interval),
      size: sliceSize,
      style,
      patienceMs: Math.round(interval * (1 - 0.4 * progress)),
    };
  });

  // --- what it is expected to cost ---------------------------------------
  //
  // Per unit, against the mark. Passive earns the half-spread it rests inside,
  // join is roughly flat to the touch, cross pays it. The impact term is the
  // square-root law with the participation this plan actually runs at.
  const styleCost: Record<SliceStyle, number> = {
    passive: -halfSpread,
    join: 0,
    cross: halfSpread,
    market: halfSpread * 1.5,
  };

  const weighted =
    schedule.reduce((total, slice) => total + styleCost[slice.style] * slice.size, 0) / size;

  const participation =
    conditions.volumePerMinute !== undefined && conditions.volumePerMinute > 0
      ? size / (conditions.volumePerMinute * (horizonMs / 60_000))
      : 0;
  const impact =
    conditions.atr !== undefined && participation > 0
      ? conditions.atr * 0.1 * Math.sqrt(Math.min(participation, 1))
      : 0;

  const children = `${slices} ${slices === 1 ? 'child' : 'children'}`;
  const over = slices === 1 ? '' : ` over ${Math.round(horizonMs / 1000)}s`;

  const rationale =
    urgency === 'firm'
      ? `Firm: ${children}${over}, front-loaded, taking liquidity after the first third.`
      : `Measured: ${children}${over}, resting inside the ${spreadTicks.toFixed(0)}-tick ` +
        `spread first and escalating if they do not fill.`;

  return {
    urgency,
    slices: schedule,
    horizonMs: Math.round((slices - 1) * interval),
    // One full interval past the last child, then it goes to market. Whatever
    // is left at that point has already refused to fill at every price the plan
    // offered it.
    deadlineMs: Math.round((slices - 1) * interval + interval + 5_000),
    rationale,
    estimatedCost: Number((weighted + impact).toFixed(8)),
  };
}

/**
 * The price a child order should be sent at.
 *
 * Kept next to the planner because the two have to agree about what 'passive'
 * means -- a plan that prices its own slices and an executor that prices them
 * differently is a bug that only shows up as slightly worse fills.
 */
export function priceFor(
  slice: ExitSlice,
  conditions: Pick<ExitConditions, 'side' | 'bestBid' | 'bestAsk' | 'tick'>
): number | undefined {
  const { side, bestBid, bestAsk, tick } = conditions;
  // Closing a long means selling: our passive rest is on the ask, and crossing
  // means hitting the bid. A short is the mirror of that.
  const selling = side === 'long';

  switch (slice.style) {
    case 'passive':
      return selling ? bestAsk - tick : bestBid + tick;
    case 'join':
      return selling ? bestBid : bestAsk;
    case 'cross':
      // A marketable limit one tick through the touch: immediate against
      // resting size, bounded if the book is thinner than it looked.
      return selling ? bestBid - tick : bestAsk + tick;
    case 'market':
      return undefined;
  }
}

/** How the plan reads in the activity log. */
export function describeExitPlan(plan: ExitPlan, currency = ''): string {
  if (plan.slices.length === 0) return 'nothing to exit';
  const saved = -plan.estimatedCost;
  const comparison =
    saved > 0
      ? `expected to beat crossing everything by about ${saved.toFixed(6)}${
          currency ? ` ${currency}` : ''
        } per unit`
      : `expected to cost about ${plan.estimatedCost.toFixed(6)} per unit against the mark`;
  return `${plan.rationale} ${comparison}.`;
}
