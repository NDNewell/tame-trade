// Cases A-S from the Position Risk specification.
import {
  calculatePositionRisk,
  PositionRiskInput,
  ProtectiveStopTranche,
} from './positionRisk.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const stop = (
  triggerPrice: number,
  requestedQuantity: number,
  extra: Partial<ProtectiveStopTranche> = {}
): ProtectiveStopTranche => ({
  orderId: `s${Math.random().toString(36).slice(2, 7)}`,
  triggerPrice,
  requestedQuantity,
  coversAll: false,
  reduceOnly: true,
  ...extra,
});

const position = (
  side: 'long' | 'short',
  quantity: number,
  entryPrice: number,
  stops: ProtectiveStopTranche[],
  extra: Partial<PositionRiskInput> = {}
): PositionRiskInput => ({ side, quantity, entryPrice, currency: 'USDT', stops, ...extra });

const near = (a: number | undefined, b: number) =>
  a !== undefined && Math.abs(a - b) < 0.01;

// A - long, one full stop
let r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 0, { coversAll: true })]));
check('A  long, one whole-position stop',
  near(r.totalRisk, 2000) && r.protectedQuantity === 1000 && r.unprotectedQuantity === 0,
  `risk=${r.totalRisk} protected=${r.protectedQuantity} unprotected=${r.unprotectedQuantity}`);

// B - short, one full stop
r = calculatePositionRisk(position('short', 1000, 96, [stop(99, 0, { coversAll: true })]));
check('B  short, one whole-position stop', near(r.totalRisk, 3000), `risk=${r.totalRisk}`);

// C - two equal partial stops
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 500), stop(92, 500)]));
check('C  two equal tranches', near(r.totalRisk, 3000), `risk=${r.totalRisk}`);

// D - three tranches
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 500), stop(93, 300), stop(91, 200)]));
check('D  three tranches', near(r.totalRisk, 2900), `risk=${r.totalRisk}`);

// E - partial protection
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 500)]));
check('E  partial protection is reported as partial',
  near(r.totalRisk, 1000) && r.protectedQuantity === 500 && r.unprotectedQuantity === 500 && !r.isFullyProtected,
  `risk=${r.totalRisk} protected=${r.protectedQuantity} unprotected=${r.unprotectedQuantity} full=${r.isFullyProtected}`);

// F - no stop
r = calculatePositionRisk(position('long', 1000, 96, []));
check('F  no stop yields no value, not zero',
  r.totalRisk === undefined && r.unprotectedQuantity === 1000,
  `risk=${r.totalRisk} (undefined means "--", 0 would mean no downside)`);

// G - stop beyond breakeven, long
r = calculatePositionRisk(position('long', 1000, 96, [stop(98, 0, { coversAll: true })]));
check('G  long stop beyond breakeven contributes nothing',
  near(r.totalRisk, 0), `risk=${r.totalRisk} (not 2000)`);

// H - stop beyond breakeven, short
r = calculatePositionRisk(position('short', 1000, 96, [stop(94, 0, { coversAll: true })]));
check('H  short stop beyond breakeven contributes nothing', near(r.totalRisk, 0), `risk=${r.totalRisk}`);

// I - mixed
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 500), stop(98, 500)]));
check('I  a profitable tranche does not offset a losing one',
  near(r.totalRisk, 1000), `risk=${r.totalRisk} (not 0 and not negative)`);

// J - over-covered
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 700), stop(92, 700)]));
check('J  over-covered position is not double-counted',
  r.totalRisk === undefined && r.isAmbiguous && r.protectedQuantity <= 1000,
  `risk=${r.totalRisk} ambiguous=${r.isAmbiguous} reason="${r.ambiguityReason}"`);

// K - ALL after scale-out
r = calculatePositionRisk(position('long', 600, 96, [stop(94, 0, { coversAll: true })]));
check('K  ALL follows the position down to 600',
  r.protectedQuantity === 600 && near(r.totalRisk, 1200),
  `protected=${r.protectedQuantity} risk=${r.totalRisk}`);

// L - fixed stop after scale-in
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 500)]));
check('L  a fixed stop does not grow with the position',
  r.protectedQuantity === 500 && r.unprotectedQuantity === 500,
  `protected=${r.protectedQuantity} unprotected=${r.unprotectedQuantity}`);

// M - cancelled stop (caller filters; verify empty set behaves as no coverage)
r = calculatePositionRisk(position('long', 1000, 96, []));
check('M  a cancelled stop leaves no coverage', r.totalRisk === undefined, `risk=${r.totalRisk}`);

// N - partial fill: position and stop both reduced
r = calculatePositionRisk(position('long', 600, 96, [stop(94, 600)]));
check('N  risk follows the remaining quantity after a partial fill',
  near(r.totalRisk, 1200) && r.isFullyProtected, `risk=${r.totalRisk} full=${r.isFullyProtected}`);

// O - trailing stop advanced beyond entry
r = calculatePositionRisk(position('long', 1000, 96, [stop(98, 0, { coversAll: true })]));
check('O  a trailing stop past breakeven contributes zero', near(r.totalRisk, 0), `risk=${r.totalRisk}`);

// P - take profit excluded by the caller; only the stop is passed in
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 500)]));
check('P  a take profit is not protective coverage',
  r.protectedQuantity === 500, `protected=${r.protectedQuantity} (the TP's 500 is not counted)`);

// Q - OCO pair of stops
r = calculatePositionRisk(position('long', 1000, 96, [
  stop(94, 500, { orderGroup: 'oco-1' }),
  stop(92, 500, { orderGroup: 'oco-1' }),
]));
check('Q  mutually exclusive stops are not summed',
  r.totalRisk === undefined && r.isAmbiguous, `risk=${r.totalRisk} reason="${r.ambiguityReason}"`);

// R/S - filtering by instrument and side happens before this function; verify a
// single correct stop is unaffected by that filtering.
r = calculatePositionRisk(position('long', 1000, 96, [stop(94, 1000)]));
check('R/S  only the position\'s own stops reach the calculation',
  near(r.totalRisk, 2000) && r.isFullyProtected, `risk=${r.totalRisk}`);

// Two whole-position stops
r = calculatePositionRisk(position('long', 1000, 96, [
  stop(94, 0, { coversAll: true }), stop(92, 0, { coversAll: true }),
]));
check('   two whole-position stops are ambiguous',
  r.totalRisk === undefined && r.isAmbiguous, `reason="${r.ambiguityReason}"`);

// ALL plus a sized stop
r = calculatePositionRisk(position('long', 1000, 96, [
  stop(92, 0, { coversAll: true }), stop(94, 500),
]));
check('   ALL alongside a sized stop is ambiguous',
  r.totalRisk === undefined && r.isAmbiguous, `reason="${r.ambiguityReason}"`);

// Inverse contract
r = calculatePositionRisk(position('long', 1000, 100, [stop(90, 0, { coversAll: true })],
  { inverse: true, currency: 'BTC', contractSize: 1 }));
const expected = 1000 * (1 / 90 - 1 / 100);
check('   inverse contracts settle in the base asset',
  near(r.totalRisk, expected), `risk=${r.totalRisk?.toFixed(4)} expected=${expected.toFixed(4)} ${r.currency}`);

console.log(`\n${failures === 0 ? 'PASS: all position-risk cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
