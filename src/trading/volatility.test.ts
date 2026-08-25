// Volatility and adaptive-trail arithmetic.
import {
  Candle,
  trueRange,
  averageTrueRange,
  closedCandles,
  atrTrailOffset,
  nextTrailOffset,
  rangeOver,
  nestRanges,
} from './volatility.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const near = (a: number | undefined, b: number, tolerance = 1e-9): boolean =>
  a !== undefined && Math.abs(a - b) < tolerance;

const candle = (high: number, low: number, close: number, timestamp = 0): Candle => ({
  timestamp,
  high,
  low,
  close,
});

// --- true range -------------------------------------------------------------

check(
  'A  first candle has no previous close, so range is high-low',
  near(trueRange(candle(105, 95, 100)), 10),
  `tr=${trueRange(candle(105, 95, 100))}`
);

check(
  'B  an ordinary candle inside the previous close uses high-low',
  near(trueRange(candle(105, 95, 100), 100), 10),
  `tr=${trueRange(candle(105, 95, 100), 100)}`
);

// Gapped up: 95..105 span is 10, but from the previous close of 80 the move is 25.
check(
  'C  a gap up is measured from the previous close, not the bar',
  near(trueRange(candle(105, 95, 100), 80), 25),
  `tr=${trueRange(candle(105, 95, 100), 80)} (span was 10)`
);

check(
  'D  a gap down is measured the same way',
  near(trueRange(candle(105, 95, 100), 130), 35),
  `tr=${trueRange(candle(105, 95, 100), 130)}`
);

// --- ATR --------------------------------------------------------------------

// Every candle a clean range of 10 with no gaps: ATR must be exactly 10 whatever
// the smoothing does.
const flat: Candle[] = Array.from({ length: 30 }, (_, i) =>
  candle(105, 95, 100, i * 60_000)
);
check(
  'E  constant range gives that range as the ATR',
  near(averageTrueRange(flat, 14), 10),
  `atr=${averageTrueRange(flat, 14)}`
);

check(
  'F  too few candles yields no ATR rather than a partial one',
  averageTrueRange(flat.slice(0, 14), 14) === undefined,
  `14 candles for a 14 period -> ${averageTrueRange(flat.slice(0, 14), 14)}`
);

check(
  'G  exactly period+1 candles is enough',
  near(averageTrueRange(flat.slice(0, 15), 14), 10),
  `atr=${averageTrueRange(flat.slice(0, 15), 14)}`
);

// Wilder's smoothing, checked by hand. Seed = mean of the first 3 ranges, then
// each later range folded in at weight 1/3.
const stepped: Candle[] = [
  candle(100, 100, 100, 0), // seed close only
  candle(110, 100, 105, 1),
  candle(112, 102, 108, 2),
  candle(120, 100, 110, 3),
  candle(130, 110, 125, 4),
];
// ranges: |110-100|=10, |112-102| vs |112-105| vs |102-105| = 10, 120-100=20, 130-110=20
// seed = (10 + 10 + 20) / 3 = 13.3333...
// then  = (13.3333 * 2 + 20) / 3 = 15.5555...
check(
  "H  Wilder's smoothing, not a plain mean",
  near(averageTrueRange(stepped, 3), (((10 + 10 + 20) / 3) * 2 + 20) / 3, 1e-9),
  `atr=${averageTrueRange(stepped, 3)} plain-mean would be ${(10 + 10 + 20 + 20) / 4}`
);

check(
  'I  a nonsense period is rejected',
  averageTrueRange(flat, 0) === undefined && averageTrueRange(flat, 2.5) === undefined,
  'period 0 and 2.5 both yield undefined'
);

// --- the forming candle -----------------------------------------------------

const minute = 60_000;
const series: Candle[] = [
  candle(10, 9, 9.5, 0),
  candle(10, 9, 9.5, minute),
  candle(10, 9, 9.5, 2 * minute), // still forming at now = 2.5 minutes
];
check(
  'J  the candle still being formed is dropped',
  closedCandles(series, 2.5 * minute, minute).length === 2,
  `kept ${closedCandles(series, 2.5 * minute, minute).length} of 3`
);

check(
  'K  a candle that has just closed is kept',
  closedCandles(series, 3 * minute, minute).length === 3,
  `kept ${closedCandles(series, 3 * minute, minute).length} of 3`
);

// --- sizing -----------------------------------------------------------------

check(
  'L  the offset is the ATR times the multiple',
  near(atrTrailOffset(2.5, { multiple: 3 }), 7.5),
  `offset=${atrTrailOffset(2.5, { multiple: 3 })}`
);

check(
  'M  a floor stops a quiet market trailing inside the noise',
  near(atrTrailOffset(0.01, { multiple: 3, minimumOffset: 0.5 }), 0.5),
  `offset=${atrTrailOffset(0.01, { multiple: 3, minimumOffset: 0.5 })}`
);

check(
  'N  a ceiling stops a violent one trailing so wide it protects nothing',
  near(atrTrailOffset(40, { multiple: 3, maximumOffset: 25 }), 25),
  `offset=${atrTrailOffset(40, { multiple: 3, maximumOffset: 25 })}`
);

check(
  'O  no ATR means no offset',
  atrTrailOffset(undefined, { multiple: 3 }) === undefined,
  'undefined ATR -> undefined offset'
);

// --- the ratchet ------------------------------------------------------------

check(
  'P  falling volatility tightens the trail',
  near(nextTrailOffset({ current: 10, candidate: 6 }), 6),
  `10 -> ${nextTrailOffset({ current: 10, candidate: 6 })}`
);

check(
  'Q  rising volatility leaves the trail alone, it never widens',
  nextTrailOffset({ current: 10, candidate: 14 }) === undefined,
  `candidate 14 against current 10 -> ${nextTrailOffset({ current: 10, candidate: 14 })}`
);

check(
  'R  an unchanged candidate is not an amendment',
  nextTrailOffset({ current: 10, candidate: 10 }) === undefined,
  `10 -> ${nextTrailOffset({ current: 10, candidate: 10 })}`
);

check(
  'S  a trivial tightening is not worth an amendment',
  nextTrailOffset({ current: 10, candidate: 9.8, minimumChangeFraction: 0.05 }) === undefined,
  '2% tighter against a 5% threshold -> no change'
);

check(
  'T  a meaningful tightening clears the same threshold',
  near(nextTrailOffset({ current: 10, candidate: 9, minimumChangeFraction: 0.05 }), 9),
  `10% tighter -> ${nextTrailOffset({ current: 10, candidate: 9, minimumChangeFraction: 0.05 })}`
);

check(
  'U  no candidate means no change',
  nextTrailOffset({ current: 10, candidate: undefined }) === undefined,
  'undefined candidate -> undefined'
);

check(
  'V  a nonsense current offset is not amended from',
  nextTrailOffset({ current: 0, candidate: 5 }) === undefined,
  'current 0 -> undefined'
);

// --- rolling ranges ---------------------------------------------------------

const now = 1_000_000;
const min = 60_000;
// One candle per minute for the last 10 minutes, widening as it goes back.
const recent: Candle[] = Array.from({ length: 10 }, (_, i) => {
  const age = 9 - i; // 9 minutes ago ... 0 minutes ago
  return candle(100 + age, 100 - age, 100, now - age * min);
});

let r = rangeOver(recent, 5 * min, now);
check(
  'W  a rolling window only sees candles inside it',
  r !== undefined && r.high === 105 && r.low === 95,
  `5m -> ${JSON.stringify(r)} (the 9-minute-old 109/91 candle is excluded)`
);

r = rangeOver(recent, 10 * min, now);
check(
  'X  a wider window reaches further back',
  r !== undefined && r.high === 109 && r.low === 91,
  `10m -> ${JSON.stringify(r)}`
);

// The reason this exists: exchanges publish closed candles only, so a new high
// would otherwise sit outside the range that should contain it.
r = rangeOver(recent, 5 * min, now, 112);
check(
  'Y  the current price is folded in, so the range always contains it',
  r !== undefined && r.high === 112 && r.low === 95,
  `price 112 above a 105 candle high -> ${JSON.stringify(r)}`
);

r = rangeOver(recent, 5 * min, now, 88);
check(
  'Z  and below, for a new low',
  r !== undefined && r.low === 88 && r.high === 105,
  `price 88 -> ${JSON.stringify(r)}`
);

check(
  'AA no candles in the window and no price yields nothing',
  rangeOver([], 5 * min, now) === undefined,
  'empty -> undefined'
);

check(
  'AB a price alone is still a range',
  JSON.stringify(rangeOver([], 5 * min, now, 100)) === JSON.stringify({ high: 100, low: 100 }),
  `-> ${JSON.stringify(rangeOver([], 5 * min, now, 100))}`
);

// --- nesting ----------------------------------------------------------------

// The case that prompted this: an hourly high the day has not caught up with.
let n = nestRanges([
  { high: 102.5, low: 101.0 }, // 1h, from minute candles, has the spike
  { high: 101.8, low: 99.0 },  // 1d, from 15m candles, does not yet
]);
check(
  'AC a wider window cannot show a lower high than one inside it',
  n[1].high === 102.5,
  `1d high 101.8 with a 1h high of 102.5 -> ${n[1].high}`
);

n = nestRanges([
  { high: 102.5, low: 98.0 },
  { high: 103.0, low: 99.0 },
]);
check(
  'AD nor a higher low',
  n[1].low === 98.0 && n[1].high === 103.0,
  `-> ${JSON.stringify(n[1])}`
);

n = nestRanges([
  { high: 100, low: 99 },
  { high: 101, low: 98 },
  { high: 102, low: 97 },
]);
check(
  'AE an already-consistent set is left alone',
  JSON.stringify(n) === JSON.stringify([
    { high: 100, low: 99 },
    { high: 101, low: 98 },
    { high: 102, low: 97 },
  ]),
  'unchanged'
);

// The month is measured on daily candles, so today's extremes reach it only
// by inheritance.
n = nestRanges([
  { high: 110, low: 90 },   // today, from fine candles
  { high: 105, low: 70 },   // the month, from daily candles, missing today
]);
check(
  'AF the month inherits today without waiting for the day to close',
  n[1].high === 110 && n[1].low === 70,
  `-> ${JSON.stringify(n[1])}`
);

n = nestRanges([
  { high: 102, low: 100 },
  { high: undefined, low: undefined },
  { high: 101, low: 99 },
]);
check(
  'AG a window with no data stays empty rather than borrowing',
  n[1].high === undefined && n[1].low === undefined && n[2].high === 102 && n[2].low === 99,
  `middle ${JSON.stringify(n[1])}, outer ${JSON.stringify(n[2])}`
);

// Monotonicity is the property the panel is read for; assert it holds whatever
// order the inputs arrive in.
const messy = [
  { high: 100, low: 95 }, { high: 99, low: 96 }, { high: 104, low: 94 },
  { high: 98, low: 97 }, { high: 103, low: 80 }, { high: 101, low: 85 },
];
const nested = nestRanges(messy);
let monotonic = true;
for (let i = 1; i < nested.length; i++) {
  if (nested[i].high! < nested[i - 1].high! || nested[i].low! > nested[i - 1].low!) monotonic = false;
}
check(
  'AH highs never shrink and lows never rise across the row',
  monotonic,
  nested.map((r) => `${r.high}/${r.low}`).join('  ')
);

console.log(`\n${failures === 0 ? 'PASS: all volatility cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
