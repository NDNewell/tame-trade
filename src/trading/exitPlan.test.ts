// The shape of a planned exit: what it schedules, and what it refuses to do.
import {
  DEFAULT_EXIT_POLICY,
  ExitConditions,
  planExit,
  priceFor,
} from './exitPlan.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) < tolerance;

const conditions = (over: Partial<ExitConditions> = {}): ExitConditions => ({
  side: 'long',
  size: 10,
  markPrice: 100,
  bestBid: 99.9,
  bestAsk: 100.1,
  tick: 0.1,
  ...over,
});

const total = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);

// --- the quantity must survive the arithmetic ------------------------------
for (const urgency of ['measured', 'firm', 'immediate'] as const) {
  const plan = planExit(conditions({ touchDepth: 2, volumePerMinute: 100 }), urgency);
  check(`   a ${urgency} plan schedules exactly the position, no more and no less`,
    near(total(plan.slices.map((s) => s.size)), 10),
    `sum=${total(plan.slices.map((s) => s.size))} slices=${plan.slices.length}`);
  check(`   a ${urgency} plan schedules no negative or zero children`,
    plan.slices.every((s) => s.size > 0),
    `sizes=[${plan.slices.map((s) => s.size.toFixed(3)).join(', ')}]`);
}

// --- front-loading is the whole point of the trajectory --------------------
const measured = planExit(conditions({ touchDepth: 1, volumePerMinute: 200 }), 'measured');
const firm = planExit(conditions({ touchDepth: 1, volumePerMinute: 200 }), 'firm');

check('   a measured exit is close to evenly sliced, as the risk-neutral answer is',
  measured.slices[0].size / 10 < 0.25,
  `first slice is ${((measured.slices[0].size / 10) * 100).toFixed(1)}% of the position`);

check('   a firm exit front-loads, as risk aversion in Almgren-Chriss requires',
  firm.slices[0].size > measured.slices[0].size,
  `firm first=${firm.slices[0].size.toFixed(3)} measured first=${measured.slices[0].size.toFixed(3)}`);

check('   every plan is monotonically decreasing in child size',
  firm.slices.every((slice, i) => i === 0 || slice.size <= firm.slices[i - 1].size + 1e-9),
  `sizes=[${firm.slices.map((s) => s.size.toFixed(3)).join(', ')}]`);

// --- immediacy -------------------------------------------------------------
const now = planExit(conditions(), 'immediate');
check('   an immediate exit is one marketable limit, not a market order',
  now.slices.length === 1 && now.slices[0].style === 'cross',
  `slices=${now.slices.length} style=${now.slices[0]?.style}`);

// --- liquidity is what decides the slicing ---------------------------------
const thin = planExit(conditions({ touchDepth: 1 }), 'measured');
const deep = planExit(conditions({ touchDepth: 50 }), 'measured');
check('   a thin book is sliced more finely than a deep one',
  thin.slices.length > deep.slices.length,
  `thin=${thin.slices.length} deep=${deep.slices.length}`);
check('   a book deep enough to take the whole position does not slice it up',
  deep.slices.length === 1, `slices=${deep.slices.length}`);

const busy = planExit(conditions({ size: 1000, volumePerMinute: 10_000 }), 'measured');
const quiet = planExit(conditions({ size: 1000, volumePerMinute: 500 }), 'measured');
check('   participation caps stretch the exit when volume is thin',
  quiet.horizonMs >= busy.horizonMs,
  `quiet=${Math.round(quiet.horizonMs / 1000)}s busy=${Math.round(busy.horizonMs / 1000)}s`);

check('   the slice count never exceeds the policy ceiling',
  planExit(conditions({ size: 1e6, touchDepth: 0.001 }), 'measured').slices.length <=
    DEFAULT_EXIT_POLICY.maxSlices,
  `maxSlices=${DEFAULT_EXIT_POLICY.maxSlices}`);

// --- a one-tick spread removes the reason to be patient --------------------
const wide = planExit(conditions({ bestBid: 99, bestAsk: 101, touchDepth: 1 }), 'measured');
const tight = planExit(
  conditions({ bestBid: 99.95, bestAsk: 100.05, tick: 0.1, touchDepth: 1 }),
  'measured'
);
check('   a wide spread is worth resting inside',
  wide.slices.some((s) => s.style === 'passive'),
  `styles=[${wide.slices.map((s) => s.style).join(', ')}]`);
check('   a one-tick spread is not, so nothing rests passively',
  tight.slices.every((s) => s.style !== 'passive'),
  `styles=[${tight.slices.map((s) => s.style).join(', ')}]`);

// --- the plan has to terminate ---------------------------------------------
check('   the deadline is past the last scheduled child',
  measured.deadlineMs > measured.horizonMs,
  `deadline=${measured.deadlineMs} horizon=${measured.horizonMs}`);
check('   patience shortens as the plan runs out of horizon',
  firm.slices[firm.slices.length - 1].patienceMs <= firm.slices[0].patienceMs,
  `first=${firm.slices[0].patienceMs} last=${firm.slices[firm.slices.length - 1].patienceMs}`);
check('   a sliced plan escalates to taking liquidity by its last child',
  measured.slices[measured.slices.length - 1].style === 'cross',
  `last style=${measured.slices[measured.slices.length - 1].style}`);

// A lone child is the first attempt, not the last. Its aggression comes from
// urgency and from escalation, not from being at the end of a schedule.
const loneMeasured = planExit(conditions({ bestBid: 99, bestAsk: 101, touchDepth: 50 }), 'measured');
const loneFirm = planExit(conditions({ bestBid: 99, bestAsk: 101, touchDepth: 50 }), 'firm');
check('   a lone child on a wide book rests inside the spread rather than paying it',
  loneMeasured.slices.length === 1 && loneMeasured.slices[0].style === 'passive',
  `slices=${loneMeasured.slices.length} style=${loneMeasured.slices[0].style}`);
check('   the same order under urgency joins instead of resting',
  loneFirm.slices.length === 1 && loneFirm.slices[0].style === 'join',
  `style=${loneFirm.slices[0].style}`);
check('   resting is expected to earn the spread, not pay it',
  loneMeasured.estimatedCost < 0 && loneFirm.estimatedCost >= 0,
  `measured=${loneMeasured.estimatedCost.toFixed(4)} firm=${loneFirm.estimatedCost.toFixed(4)}`);

// --- nothing to do ---------------------------------------------------------
check('   a plan for no position schedules nothing',
  planExit(conditions({ size: 0 }), 'measured').slices.length === 0, 'size 0');

// --- pricing ---------------------------------------------------------------
const book = { side: 'long' as const, bestBid: 99.9, bestAsk: 100.1, tick: 0.1 };
check('   closing a long rests on the ask, joins the bid, and crosses through it',
  near(priceFor({ index: 0, offsetMs: 0, size: 1, style: 'passive', patienceMs: 0 }, book)!, 100.0) &&
    near(priceFor({ index: 0, offsetMs: 0, size: 1, style: 'join', patienceMs: 0 }, book)!, 99.9) &&
    near(priceFor({ index: 0, offsetMs: 0, size: 1, style: 'cross', patienceMs: 0 }, book)!, 99.8),
  'passive=100.0 join=99.9 cross=99.8');

const shortBook = { ...book, side: 'short' as const };
check('   closing a short is the mirror of that',
  near(priceFor({ index: 0, offsetMs: 0, size: 1, style: 'passive', patienceMs: 0 }, shortBook)!, 100.0) &&
    near(priceFor({ index: 0, offsetMs: 0, size: 1, style: 'join', patienceMs: 0 }, shortBook)!, 100.1) &&
    near(priceFor({ index: 0, offsetMs: 0, size: 1, style: 'cross', patienceMs: 0 }, shortBook)!, 100.2),
  'passive=100.0 join=100.1 cross=100.2');

check('   a market child has no price at all',
  priceFor({ index: 0, offsetMs: 0, size: 1, style: 'market', patienceMs: 0 }, book) === undefined,
  'undefined means send it unpriced');

// --- cost comparison -------------------------------------------------------
const halfSpread = (101 - 99) / 2;
check('   working a wide spread is expected to beat crossing all of it',
  wide.estimatedCost < halfSpread,
  `estimated=${wide.estimatedCost.toFixed(4)} crossing everything=${halfSpread.toFixed(4)}`);

console.log(`\n${failures === 0 ? 'PASS: all exit-plan cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
