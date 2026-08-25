// Round-tripping a trail's terms through its client order id.
import { buildTrailTag, readTrailTag, isManagedTrail } from './trailTag.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};
const fixed = () => 0.5;

let id = buildTrailTag({ kind: 'atr', value: 3, timeframe: '1h' }, fixed);
let t = readTrailTag(id);
check('A  an immediate ATR trail round-trips',
  t?.kind === 'atr' && t.value === 3 && t.timeframe === '1h' && t.armPrice === undefined,
  `${id} -> ${JSON.stringify(t)}`);

id = buildTrailTag({ kind: 'atr', value: 2.5, timeframe: '15m', armPrice: 103.8 }, fixed);
t = readTrailTag(id);
check('B  a delayed ATR trail carries its arming price',
  t?.value === 2.5 && t.timeframe === '15m' && t.armPrice === 103.8,
  `${id} -> ${JSON.stringify(t)}`);

id = buildTrailTag({ kind: 'fixed', value: 10, armPrice: 110 }, fixed);
t = readTrailTag(id);
check('C  a delayed fixed trail carries its distance and arming price',
  t?.kind === 'fixed' && t.value === 10 && t.armPrice === 110 && t.timeframe === undefined,
  `${id} -> ${JSON.stringify(t)}`);

id = buildTrailTag({ kind: 'fixed', value: 1204.55, armPrice: 109123.5 }, fixed);
t = readTrailTag(id);
check('D  BTC-sized numbers survive',
  t?.value === 1204.55 && t.armPrice === 109123.5,
  `${id} (${id.length} chars) -> ${JSON.stringify(t)}`);

check('E  it fits inside a client id field',
  buildTrailTag({ kind: 'atr', value: 12.75, timeframe: '15m', armPrice: 109123.5 }).length <= 34,
  `${buildTrailTag({ kind: 'atr', value: 12.75, timeframe: '15m', armPrice: 109123.5 })}`);

check('F  ids are unique across placements',
  buildTrailTag({ kind: 'atr', value: 3, timeframe: '1h' }) !==
    buildTrailTag({ kind: 'atr', value: 3, timeframe: '1h' }),
  'two builds differ');

// Trails placed before arming existed are still resting on the exchange.
t = readTrailTag('TAMEATR300-1h-e403b8');
check('G  the older three-field form is still read',
  t?.kind === 'atr' && t.value === 3 && t.timeframe === '1h' && t.armPrice === undefined,
  `-> ${JSON.stringify(t)}`);

// Anything not ours must not be adopted.
for (const foreign of [
  'CCXT1234560a4a5654242eb8d0', '', undefined, null, 'TAME', 'TAMEATR',
  'NOTTAMEATR300-1h-_-abc123', 'TAMEXYZ300-1h-_-abc123',
]) {
  check(`H  '${String(foreign).slice(0, 26)}' is not treated as ours`,
    readTrailTag(foreign) === undefined, `-> ${JSON.stringify(readTrailTag(foreign))}`);
}

check('I  a zero value is rejected rather than believed',
  readTrailTag('TAMEATR0-1h-_-abc123') === undefined &&
    readTrailTag('TAMEFIX0-_-11000-abc123') === undefined,
  'both -> undefined');

// An ATR trail without a timeframe cannot be measured, so it is not ours to run.
check('J  an ATR tag missing its timeframe is rejected',
  readTrailTag('TAMEATR300-_-_-abc123') === undefined,
  '-> undefined');

check('K  isManagedTrail agrees with the parser',
  isManagedTrail(buildTrailTag({ kind: 'fixed', value: 5, armPrice: 105 })) &&
    !isManagedTrail('CCXT1234560a4a5654242eb8d0'),
  'ours yes, ccxt default no');

console.log(`\n${failures === 0 ? 'PASS: all trail-tag cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
