// Round-tripping an adaptive trail's terms through its client order id.
import { buildTrailTag, readTrailTag, isAdaptiveTrail } from './trailTag.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const fixed = () => 0.5;

let id = buildTrailTag({ multiple: 3, timeframe: '1h' }, fixed);
check('A  the terms survive a round trip',
  JSON.stringify(readTrailTag(id)) === JSON.stringify({ multiple: 3, timeframe: '1h' }),
  `${id} -> ${JSON.stringify(readTrailTag(id))}`);

id = buildTrailTag({ multiple: 2.5, timeframe: '15m' }, fixed);
check('B  a fractional multiple survives without punctuation',
  readTrailTag(id)?.multiple === 2.5 && readTrailTag(id)?.timeframe === '15m',
  `${id} -> ${JSON.stringify(readTrailTag(id))}`);

id = buildTrailTag({ multiple: 3, timeframe: '1M' }, fixed);
check('C  timeframes are normalised to lower case',
  readTrailTag(id)?.timeframe === '1m',
  `${id} -> ${JSON.stringify(readTrailTag(id))}`);

check('D  ids are unique across placements',
  buildTrailTag({ multiple: 3, timeframe: '1h' }) !== buildTrailTag({ multiple: 3, timeframe: '1h' }),
  'two builds differ');

check('E  it fits well inside a client id field',
  buildTrailTag({ multiple: 12.75, timeframe: '15m' }).length <= 24,
  `${buildTrailTag({ multiple: 12.75, timeframe: '15m' })} is ${buildTrailTag({ multiple: 12.75, timeframe: '15m' }).length} chars`);

// Anything not ours must not be adopted: amending an order whose terms we have
// guessed at is worse than leaving it alone.
for (const foreign of [
  'CCXT1234560a4a5654242eb8d0', '', undefined, null, 'TAMEATR', 'TAMEATR-1h-abc',
  'tameatrxx-1h-abc', 'NOTTAMEATR300-1h-abc123',
]) {
  check(`F  '${String(foreign).slice(0, 26)}' is not treated as ours`,
    readTrailTag(foreign) === undefined,
    `-> ${JSON.stringify(readTrailTag(foreign))}`);
}

// A tag claiming a zero multiple is malformed, not a zero-width trail.
check('G  a zero multiple is rejected rather than believed',
  readTrailTag('TAMEATR0-1h-abc123') === undefined,
  '-> undefined');

check('H  isAdaptiveTrail agrees with the parser',
  isAdaptiveTrail(buildTrailTag({ multiple: 3, timeframe: '4h' })) &&
    !isAdaptiveTrail('CCXT1234560a4a5654242eb8d0'),
  'ours yes, ccxt default no');

console.log(`\n${failures === 0 ? 'PASS: all trail-tag cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
