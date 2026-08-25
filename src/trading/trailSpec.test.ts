// Trail argument grammar.
import { parseTrailSpec, isTrailSpecError, describeTrailSpec, TrailSpec } from './trailSpec.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const parsed = (input: string): TrailSpec | undefined => {
  const result = parseTrailSpec(input);
  return isTrailSpecError(result) ? undefined : result;
};

/** The timeframe, for the ATR forms that have one. */
const timeframeOf = (input: string): string | undefined => {
  const result = parsed(input);
  return result?.kind === 'atr' ? result.timeframe : undefined;
};
const errored = (input: string): string | undefined => {
  const result = parseTrailSpec(input);
  return isTrailSpecError(result) ? result.error : undefined;
};

// --- fixed forms ------------------------------------------------------------

let s = parsed('2');
check('A  a bare number is an absolute distance',
  s?.kind === 'absolute' && s.distance === 2, JSON.stringify(s));

s = parsed('0.25');
check('B  fractional distances are kept',
  s?.kind === 'absolute' && s.distance === 0.25, JSON.stringify(s));

s = parsed('2%');
check('C  a trailing percent sign is a percentage',
  s?.kind === 'percent' && s.percent === 2, JSON.stringify(s));

check('D  zero and negative distances are refused',
  errored('0') !== undefined && errored('-3') !== undefined,
  `0 -> "${errored('0')}"`);

check('E  a percentage of the whole price is refused',
  errored('100%') !== undefined,
  `100% -> "${errored('100%')}"`);

check('F  words that are not numbers are refused',
  errored('wide') !== undefined,
  `wide -> "${errored('wide')}"`);

// --- ATR forms --------------------------------------------------------------

s = parsed('3atr');
check('G  3atr is three times ATR on the default timeframe',
  s?.kind === 'atr' && s.multiple === 3 && s.timeframe === '1h' && s.period === 14,
  JSON.stringify(s));

s = parsed('2.5atr');
check('H  the multiple may be fractional',
  s?.kind === 'atr' && s.multiple === 2.5, JSON.stringify(s));

s = parsed('atr');
check('I  a bare atr defaults its multiple',
  s?.kind === 'atr' && s.multiple === 3, JSON.stringify(s));

s = parsed('3atr 15m');
check('J  a timeframe may follow the multiple',
  s?.kind === 'atr' && s.multiple === 3 && s.timeframe === '15m', JSON.stringify(s));

s = parsed('  3ATR   4H  ');
check('K  case and spacing do not matter',
  s?.kind === 'atr' && s.multiple === 3 && s.timeframe === '4h', JSON.stringify(s));

check('L  an unknown timeframe is named, not ignored',
  (errored('3atr 7m') ?? '').includes('not a timeframe'),
  `3atr 7m -> "${errored('3atr 7m')}"`);

check('M  a timeframe without atr is explained',
  (errored('2 15m') ?? '').includes('only applies to an ATR trail'),
  `2 15m -> "${errored('2 15m')}"`);

check('N  three arguments are refused',
  errored('3atr 15m extra') !== undefined,
  `-> "${errored('3atr 15m extra')}"`);

check('O  an empty argument is refused',
  errored('') !== undefined && errored('   ') !== undefined,
  `"" -> "${errored('')}"`);

// A zero multiple must not fall through to the default.
check('P  0atr is refused rather than defaulted',
  errored('0atr') !== undefined,
  `0atr -> "${errored('0atr')}"`);

// --- description ------------------------------------------------------------

check('Q  each form describes itself for the log',
  describeTrailSpec({ kind: 'absolute', distance: 2 }) === '2' &&
    describeTrailSpec({ kind: 'percent', percent: 1.5 }) === '1.5%' &&
    describeTrailSpec({ kind: 'atr', multiple: 3, timeframe: '1h', period: 14 }) ===
      '3x ATR(14) 1h',
  describeTrailSpec({ kind: 'atr', multiple: 3, timeframe: '1h', period: 14 })
);

// --- case folding, and the one place it must not happen -------------------

s = parsed('3atr 1w');
check('R  weekly is accepted',
  s?.kind === 'atr' && s.timeframe === '1w', JSON.stringify(s));

// Lower-case m is minutes, upper-case M is months. Folding them together turned
// a monthly request into a one-minute trail, about ten times tighter, silently.
check('S  an upper-case M is refused rather than read as minutes',
  (errored('3atr 1M') ?? '').includes('ambiguous'),
  `3atr 1M -> "${errored('3atr 1M')}"`);

check('T  and the refusal explains which is which',
  (errored('15M') === undefined ? '' : '') === '' &&
    (errored('3atr 15M') ?? '').includes("'m' is minutes"),
  `3atr 15M -> "${errored('3atr 15M')}"`);

check('U  unambiguous case is still folded',
  timeframeOf('3atr 4H') === '4h' && parsed('3ATR')?.kind === 'atr',
  '4H -> 4h, 3ATR -> atr');

check('V  the two-word form is explained rather than rejected blankly',
  (errored('3 atr') ?? '').includes('one word'),
  `3 atr -> "${errored('3 atr')}"`);

console.log(`\n${failures === 0 ? 'PASS: all trail-spec cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
