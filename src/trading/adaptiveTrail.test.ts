// The managed trailing stop's decision rule.
import {
  planTrailStop,
  advanceHighWaterMark,
  TrailStopState,
  TrailStopPolicy,
} from './adaptiveTrail.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

const policy = (cushion: number, over: Partial<TrailStopPolicy> = {}): TrailStopPolicy => ({
  cushion,
  tick: 0.01,
  minimumImprovementFraction: 0.05,
  safetyTicks: 2,
  ...over,
});

// --- the high-water mark ----------------------------------------------------

check(
  'A  the first price seen becomes the high-water mark',
  advanceHighWaterMark('long', undefined, 100) === 100,
  '-> 100'
);

check(
  'B  a higher price advances it, a lower one does not',
  advanceHighWaterMark('long', 100, 104) === 104 &&
    advanceHighWaterMark('long', 104, 99) === 104,
  '100 -> 104, then 99 leaves it at 104'
);

check(
  'C  for a short it only ever falls',
  advanceHighWaterMark('short', 100, 96) === 96 &&
    advanceHighWaterMark('short', 96, 101) === 96,
  '100 -> 96, then 101 leaves it at 96'
);

check(
  'D  a nonsense price never moves it',
  advanceHighWaterMark('long', 100, NaN) === 100 &&
    advanceHighWaterMark('long', 100, 0) === 100,
  'NaN and 0 both leave it at 100'
);

// --- the walkthrough, step by step ------------------------------------------
//
// LONG at 100, cushion starts at 3 x ATR(2.0) = 6, stop placed at 94.

let p = planTrailStop({ side: 'long', highWaterMark: 104, stop: 94, mark: 104 }, policy(6));
check(
  'E  price rises, the stop follows one cushion behind',
  p.action === 'move' && near(p.stop, 98),
  p.action === 'move' ? `stop 94 -> ${p.stop}` : `held: ${p.reason}`
);

p = planTrailStop({ side: 'long', highWaterMark: 112, stop: 104, mark: 112 }, policy(3));
check(
  'F  the market goes quiet: a smaller cushion lifts the stop further',
  p.action === 'move' && near(p.stop, 109),
  p.action === 'move' ? `cushion 6 -> 3 moves the stop 104 -> ${p.stop}` : `held: ${p.reason}`
);

// Volatility triples. The cushion wants 9, which would put the stop at 107 --
// below the 113 already resting. Refused.
p = planTrailStop({ side: 'long', highWaterMark: 116, stop: 113, mark: 115 }, policy(9));
check(
  'G  volatility expands: the lower stop it asks for is refused',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved to ${p.stop}, BELOW the 113 already resting`
);

// The point of the whole design: a new high at 122 with the stop still at 113
// leaves a gap of 9 -- the cushion volatility wanted -- reached without ever
// lowering the stop.
p = planTrailStop({ side: 'long', highWaterMark: 122, stop: 113, mark: 122 }, policy(9));
check(
  'H  and the gap widens on its own as new highs arrive',
  p.action === 'hold',
  `high 122 with the stop at 113 is a gap of 9, the cushion asked for, for free (${
    p.action === 'hold' ? p.reason : 'moved'
  })`
);

// Once price runs far enough that the cushion fits behind it again, the stop
// resumes climbing.
p = planTrailStop({ side: 'long', highWaterMark: 126, stop: 113, mark: 126 }, policy(6));
check(
  'I  and it resumes climbing once the market calms',
  p.action === 'move' && near(p.stop, 120),
  p.action === 'move' ? `stop 113 -> ${p.stop}` : `held: ${p.reason}`
);

// --- the guard that matters most --------------------------------------------

// Price has retraced from a 122 high to 114. Volatility collapses, so the
// cushion is 1.5 and the stop would go to 120.5 -- above the price, closing the
// position instantly.
p = planTrailStop({ side: 'long', highWaterMark: 122, stop: 113, mark: 114 }, policy(1.5));
check(
  'J  a volatility collapse cannot put the stop through the mark',
  p.action === 'move' && p.stop < 114,
  p.action === 'move'
    ? `clamped to ${p.stop}, below the 114 mark (unclamped it would be 120.50)`
    : `held: ${p.reason}`
);

p = planTrailStop({ side: 'long', highWaterMark: 122, stop: 113.99, mark: 114 }, policy(1.5));
check(
  'K  and holds outright when there is no safe room left',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved to ${p.stop}`
);

// --- the threshold ----------------------------------------------------------

p = planTrailStop({ side: 'long', highWaterMark: 116, stop: 109.9, mark: 116 }, policy(6));
check(
  'L  a trivial improvement is not worth an amendment',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved by ${(p.stop - 109.9).toFixed(2)}`
);

p = planTrailStop({ side: 'long', highWaterMark: 116, stop: 109, mark: 116 }, policy(6));
check(
  'M  a material one clears it',
  p.action === 'move' && near(p.stop, 110),
  p.action === 'move' ? `stop 109 -> ${p.stop}` : `held: ${p.reason}`
);

// --- shorts -----------------------------------------------------------------

p = planTrailStop({ side: 'short', highWaterMark: 90, stop: 100, mark: 90 }, policy(6));
check(
  'N  a short trails downward',
  p.action === 'move' && near(p.stop, 96),
  p.action === 'move' ? `stop 100 -> ${p.stop}` : `held: ${p.reason}`
);

p = planTrailStop({ side: 'short', highWaterMark: 90, stop: 96, mark: 92 }, policy(12));
check(
  'O  a short refuses a stop that would rise',
  p.action === 'hold',
  p.action === 'hold' ? p.reason : `moved to ${p.stop}, above the 96 already resting`
);

p = planTrailStop({ side: 'short', highWaterMark: 90, stop: 96, mark: 94 }, policy(1));
check(
  'P  the mark guard works for shorts too',
  p.action === 'move' && p.stop > 94,
  p.action === 'move'
    ? `clamped to ${p.stop}, above the 94 mark (unclamped it would be 91.00)`
    : `held: ${p.reason}`
);

// --- refusals ---------------------------------------------------------------

check(
  'Q  an unmeasurable cushion moves nothing',
  planTrailStop({ side: 'long', highWaterMark: 116, stop: 109, mark: 116 }, policy(0)).action === 'hold' &&
    planTrailStop({ side: 'long', highWaterMark: 116, stop: 109, mark: 116 }, policy(NaN)).action === 'hold',
  'zero and NaN cushions both hold'
);

check(
  'R  no high-water mark means no decision',
  planTrailStop({ side: 'long', highWaterMark: NaN, stop: 109, mark: 116 }, policy(6)).action === 'hold',
  planTrailStop({ side: 'long', highWaterMark: NaN, stop: 109, mark: 116 }, policy(6)).reason
);

// --- the invariant, over a whole sequence -----------------------------------

let stop = 94;
let high = 100;
let violations = 0;
let moves = 0;

const path: [number, number][] = [
  [104, 2.0], [110, 2.0], [112, 1.0], [116, 1.0], [115, 3.0],
  [122, 3.0], [118, 3.0], [126, 2.0], [124, 4.0], [131, 1.2],
];

for (const [mark, atr] of path) {
  high = advanceHighWaterMark('long', high, mark)!;
  const plan = planTrailStop({ side: 'long', highWaterMark: high, stop, mark }, policy(atr * 3));
  if (plan.action === 'move') {
    if (plan.stop < stop - 1e-9) violations++;
    if (plan.stop >= mark) violations++;
    stop = plan.stop;
    moves++;
  }
}

check(
  'S  across a volatile path the stop never falls and never crosses the mark',
  violations === 0,
  `${moves} moves, ${violations} violations, final stop ${stop.toFixed(2)}`
);

console.log(`\n${failures === 0 ? 'PASS: all managed-trail cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
