// Reading a stop-limit command.
import { parseStopLimit, stopLimitCaution } from './stopLimit.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

let parsed = parseStopLimit('stop limit sell 95 94.5 10');
check('A  side, trigger, limit, size, in that order',
  parsed !== undefined && !('error' in parsed) && parsed.side === 'sell' &&
    parsed.triggerPrice === 95 && parsed.limitPrice === 94.5 && parsed.size === 10,
  JSON.stringify(parsed));

parsed = parseStopLimit('stop limit buy 105 105.5 10');
check('B  a buy reads the same way',
  parsed !== undefined && !('error' in parsed) && parsed.side === 'buy' && parsed.triggerPrice === 105,
  JSON.stringify(parsed));

check('C  a plain stop is not this command',
  parseStopLimit('stop 95 10') === undefined && parseStopLimit('stop 95') === undefined,
  'stop 95 10');

parsed = parseStopLimit('stop limit 95 94.5 10');
check('D  the side is required',
  parsed !== undefined && 'error' in parsed && /Usage/.test(parsed.error),
  JSON.stringify(parsed));

parsed = parseStopLimit('stop limit sell 95 94.5');
check('E  and so is the size',
  parsed !== undefined && 'error' in parsed && /Usage/.test(parsed.error),
  JSON.stringify(parsed));

parsed = parseStopLimit('stop limit sell 95 lots 10');
check('F  a price that is not a number is refused',
  parsed !== undefined && 'error' in parsed && /not a usable price/.test(parsed.error),
  JSON.stringify(parsed));

parsed = parseStopLimit('stop limit sell 95 94.5 0');
check('G  a zero size is refused',
  parsed !== undefined && 'error' in parsed && /not a usable size/.test(parsed.error),
  JSON.stringify(parsed));

check('H  a sell whose limit is above its trigger gets a caution, not a refusal',
  /comes back up/.test(stopLimitCaution({ side: 'sell', triggerPrice: 95, limitPrice: 96, size: 1 }) ?? ''),
  stopLimitCaution({ side: 'sell', triggerPrice: 95, limitPrice: 96, size: 1 }) ?? 'none');

check('I  a buy whose limit is below its trigger likewise',
  /comes back down/.test(stopLimitCaution({ side: 'buy', triggerPrice: 105, limitPrice: 104, size: 1 }) ?? ''),
  stopLimitCaution({ side: 'buy', triggerPrice: 105, limitPrice: 104, size: 1 }) ?? 'none');

check('J  the usual shape draws no caution',
  stopLimitCaution({ side: 'sell', triggerPrice: 95, limitPrice: 94.5, size: 1 }) === undefined &&
    stopLimitCaution({ side: 'buy', triggerPrice: 105, limitPrice: 105.5, size: 1 }) === undefined &&
    stopLimitCaution({ side: 'sell', triggerPrice: 95, limitPrice: 95, size: 1 }) === undefined,
  'sell 95/94.5, buy 105/105.5, sell 95/95');

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
