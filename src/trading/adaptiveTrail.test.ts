// The adaptive trail's decision rule.
import {
  planTrailAdjustment,
  impliedExtreme,
  TrailState,
  TrailPolicy,
} from './adaptiveTrail.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

// The live order this was designed against: LONG, stop 97.57, peg 5.08,
// implying a 102.65 high. ATR(14) on 1h was 1.605, so 3x is 4.81.
const live: TrailState = { side: 'long', peg: 5.08, stop: 97.57, mark: 101.99 };
const policy = (desiredDistance: number, over: Partial<TrailPolicy> = {}): TrailPolicy => ({
  desiredDistance,
  tick: 0.01,
  minimumImprovementFraction: 0.05,
  safetyTicks: 2,
  ...over,
});

check(
  'A  the exchange high-water mark is recoverable from the order',
  near(impliedExtreme(live), 102.65),
  `stop 97.57 + peg 5.08 -> ${impliedExtreme(live)}`
);

check(
  'B  a short recovers its extreme in the other direction',
  near(impliedExtreme({ side: 'short', peg: 5, stop: 105, mark: 101 }), 100),
  'stop 105 - peg 5 -> 100'
);

// --- the three cases walked through in the design ---------------------------

let p = planTrailAdjustment(live, policy(3.0));
check(
  'C  volatility falls: the trail tightens and the stop rises',
  p.action === 'move' && near(p.peg, 3.0) && near(p.stop, 99.65),
  p.action === 'move' ? `peg 5.08 -> ${p.peg}, stop 97.57 -> ${p.stop}` : `held: ${p.reason}`
);

p = planTrailAdjustment(live, policy(6.6));
check(
  'D  volatility rises with no new extreme: nothing happens',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved to ${p.stop}, which would LOWER the stop`
);

// A new high at 108 does NOT buy room to widen. The exchange has already
// advanced the stop to 108 - 5.08 = 102.92, so widening to 6.60 would put it at
// 101.40 and lower it by 1.52.
//
// This is worth stating outright because it is easy to assume otherwise: since
// the exchange keeps the stop at (extreme - peg), the improvement from any
// change is (peg - desired). The stop therefore improves if and only if the
// trail tightens, and no rise in the extreme ever makes widening safe. The
// level rule and a never-widen rule turn out to be the same rule.
p = planTrailAdjustment({ side: 'long', peg: 5.08, stop: 102.92, mark: 107.5 }, policy(6.6));
check(
  'E  a new extreme does not pay for a wider trail',
  p.action === 'hold',
  p.action === 'hold'
    ? p.reason
    : `moved to ${p.stop}, which is below the 102.92 the exchange already holds`
);

// Tightening after a new extreme does still work, and compounds with it.
p = planTrailAdjustment({ side: 'long', peg: 5.08, stop: 102.92, mark: 107.5 }, policy(3.0));
check(
  'E2 tightening after a new extreme raises the stop again',
  p.action === 'move' && near(p.peg, 3.0) && near(p.stop, 105.0),
  p.action === 'move' ? `peg 5.08 -> ${p.peg}, stop 102.92 -> ${p.stop}` : `held: ${p.reason}`
);

// --- the guard that matters most --------------------------------------------

// Volatility collapses to almost nothing while price has retraced from the
// high. Without the clamp the stop lands at 102.15, above the 101.99 mark, and
// the position closes instantly.
p = planTrailAdjustment(live, policy(0.5));
check(
  'F  a volatility collapse cannot put the stop through the mark',
  p.action === 'move' && p.stop < live.mark,
  p.action === 'move'
    ? `stop ${p.stop} stays below mark ${live.mark} (unclamped it would be ${(102.65 - 0.5).toFixed(2)})`
    : `held: ${p.reason}`
);

p = planTrailAdjustment({ side: 'long', peg: 5.08, stop: 101.98, mark: 101.99 }, policy(0.5));
check(
  'G  and holds outright when there is no safe room left',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved to ${p.stop}`
);

// --- the threshold ----------------------------------------------------------

// 5.08 -> 5.06 raises the stop by two cents. Not worth a request.
p = planTrailAdjustment(live, policy(5.06));
check(
  'H  a trivial improvement is not worth an amendment',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved by ${(p.stop - 97.57).toFixed(2)}`
);

// 5% of 5.08 is 0.254, so the stop must rise by at least that.
p = planTrailAdjustment(live, policy(4.8));
check(
  'I  a material improvement clears the same threshold',
  p.action === 'move' && near(p.stop, 97.85),
  p.action === 'move' ? `stop 97.57 -> ${p.stop}` : `held: ${p.reason}`
);

// --- shorts -----------------------------------------------------------------

const short: TrailState = { side: 'short', peg: 5, stop: 105, mark: 101 };

p = planTrailAdjustment(short, policy(3));
check(
  'J  a short tightens downward when volatility falls',
  p.action === 'move' && near(p.stop, 103) && near(p.peg, 3),
  p.action === 'move' ? `stop 105 -> ${p.stop}, peg 5 -> ${p.peg}` : `held: ${p.reason}`
);

p = planTrailAdjustment(short, policy(8));
check(
  'K  a short never lets its stop rise',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved to ${p.stop}, above the 105 it had`
);

// Extreme is 96.5, so a 0.5 distance wants the stop at 97.0 -- far below the
// 101.4 mark, which for a short means it would trigger instantly. Threshold
// lowered so the clamp is what decides, not the size of the move.
p = planTrailAdjustment(
  { side: 'short', peg: 5, stop: 101.5, mark: 101.4 },
  policy(0.5, { minimumImprovementFraction: 0.001 })
);
check(
  'L  the mark guard works for shorts too',
  p.action === 'move' && p.stop > 101.4 && p.stop < 101.5,
  p.action === 'move'
    ? `clamped to ${p.stop}, above mark 101.4 (unclamped it would be 97.00)`
    : `held: ${p.reason}`
);

// --- refusals ---------------------------------------------------------------

check(
  'M  an unmeasurable ATR moves nothing',
  planTrailAdjustment(live, policy(0)).action === 'hold' &&
    planTrailAdjustment(live, policy(NaN)).action === 'hold',
  'zero and NaN distances both hold'
);

check(
  'N  an order with no trail distance is left alone',
  planTrailAdjustment({ ...live, peg: 0 }, policy(3)).action === 'hold',
  planTrailAdjustment({ ...live, peg: 0 }, policy(3)).reason
);

// --- the ratchet holds over a whole sequence --------------------------------

let peg = 5.08;
let extreme = 102.65;
let stop = extreme - peg;
let violations = 0;
let moves = 0;

// Price grinds up while volatility swings wildly. The exchange advances the
// stop on every new extreme; we only ever consider changing the distance.
const swings = [1.6, 0.9, 3.2, 0.7, 2.8, 1.1, 4.0, 0.6, 2.2];
for (let i = 0; i < swings.length; i++) {
  const mark = 101.99 + i * 1.2;
  extreme = Math.max(extreme, mark);
  stop = extreme - peg; // what the exchange holds right now

  const plan = planTrailAdjustment({ side: 'long', peg, stop, mark }, policy(swings[i] * 3));
  if (plan.action === 'move') {
    if (plan.stop < stop - 1e-9) violations++;
    peg = plan.peg;
    stop = plan.stop;
    moves++;
  }
}

check(
  'O  across a volatile sequence the stop never falls',
  violations === 0,
  `${moves} moves, ${violations} violations, final stop ${stop.toFixed(2)} with peg ${peg.toFixed(2)}`
);

console.log(`\n${failures === 0 ? 'PASS: all adaptive-trail cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
