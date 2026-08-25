// The rules that decide what stays in the cached order list.
import { classifyOrderStatus, staleOrderIds } from './orderCacheRules.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

// --- status classification --------------------------------------------------

check(
  'A  open and partial statuses mean working',
  classifyOrderStatus('open') === 'working' &&
    classifyOrderStatus('partial') === 'working' &&
    classifyOrderStatus('partially_filled') === 'working',
  'open/partial/partially_filled -> working'
);

check(
  'B  every terminal status ends the order',
  ['closed', 'canceled', 'cancelled', 'rejected', 'expired'].every(
    (status) => classifyOrderStatus(status) === 'finished'
  ),
  'closed/canceled/cancelled/rejected/expired -> finished'
);

// The original rule matched 'canceled' exactly; the British spelling, a
// capitalised status or a padded one all fell through to "still working".
check(
  'C  case and spacing do not change the answer',
  classifyOrderStatus('  Canceled ') === 'finished' &&
    classifyOrderStatus('CLOSED') === 'finished' &&
    classifyOrderStatus('Open') === 'working',
  "'  Canceled ' -> finished"
);

check(
  'D  a status we do not recognise is unknown, not working',
  classifyOrderStatus('Untriggered') === 'unknown' &&
    classifyOrderStatus('Deactivated') === 'unknown',
  'these previously counted as still working'
);

check(
  'E  a missing status is unknown rather than assumed',
  classifyOrderStatus(undefined) === 'unknown' &&
    classifyOrderStatus(null) === 'unknown' &&
    classifyOrderStatus('') === 'unknown',
  'undefined/null/empty -> unknown'
);

// --- reconciliation ---------------------------------------------------------

check(
  'F  a cached order the exchange does not list is stale',
  staleOrderIds(['a', 'b', 'c'], ['a', 'c'], true).join(',') === 'b',
  `-> ${staleOrderIds(['a', 'b', 'c'], ['a', 'c'], true)}`
);

// The actual case: 390d917a lingered while only the trailing stop was live.
check(
  'G  the phantom chase order is removed by a full snapshot',
  staleOrderIds(['52dddccd', '390d917a'], ['52dddccd'], true).join(',') === '390d917a',
  `-> ${staleOrderIds(['52dddccd', '390d917a'], ['52dddccd'], true)}`
);

check(
  'H  nothing is removed when everything is still listed',
  staleOrderIds(['a', 'b'], ['a', 'b'], true).length === 0,
  'no removals'
);

check(
  'I  a filtered snapshot may not remove anything',
  staleOrderIds(['limit1', 'stop1'], ['stop1'], false).length === 0,
  'an untriggered-only query must not delete the limit order'
);

check(
  'J  an empty authoritative snapshot clears the cache',
  staleOrderIds(['a', 'b'], [], true).length === 2,
  'the exchange listing nothing means nothing is open'
);

check(
  'K  an empty non-authoritative snapshot clears nothing',
  staleOrderIds(['a', 'b'], [], false).length === 0,
  'a filtered query returning nothing proves nothing'
);

console.log(`\n${failures === 0 ? 'PASS: all order-cache cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
