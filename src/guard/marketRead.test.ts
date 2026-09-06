// The coach must not be told there is no market while one is being read.
//
// What happened: the sweep fires the market read every pass and throws the
// result away, so nothing notices when one hangs. Behind a request queue that
// had stopped draining, one did -- and the in-flight flag it set had no
// deadline and no way to be joined. Every later read returned immediately
// without doing anything, and a typed question, on the one path that is
// supposed to wait, was answered against nothing at all. The panel beside it
// had been given a deadline months earlier and carried on.
//
// Two rules, then: a forced read joins the read in flight instead of stepping
// over it, and a read that outlives its deadline is abandoned so the next one
// can start.

import { GuardService } from './guardService.js';
import { MarketContext } from './marketContext.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a promise has come back, judged by giving it a moment to. */
const landed = async (promise: Promise<unknown>): Promise<boolean> => {
  const waiting = Symbol('waiting');
  return (await Promise.race([promise, sleep(5).then(() => waiting)])) !== waiting;
};

const reading = (at: number): MarketContext => ({
  market: 'SOL/USDT:USDT',
  at,
  last: 101.77,
  ranges: [],
  orders: [],
  series: [],
});

// One variable drives both of the service's clocks: the one that stamps a
// reading and the one that measures how long a read has been out. They are
// separate there on purpose -- durations are monotonic, so that a wall clock
// being stepped cannot abandon a read that is milliseconds old -- and a test
// that steps time wants to step both at once.
let clock = 0;
const guard = new GuardService({ clock: () => clock, elapsed: () => clock });

let reads = 0;
let answer: ((context: MarketContext | undefined) => void) | undefined;

// One source throughout, so the count is the whole story: it hands back a
// promise the test settles by hand, which is a read that has gone out and not
// yet come back.
guard.setMarketSource(
  () =>
    new Promise<MarketContext | undefined>((resolve) => {
      reads++;
      answer = resolve;
    })
);

// --- a question typed while the sweep's read is still out ------------------

const background = guard.refreshMarket();
const forced = guard.marketAt(0);

check('a forced read joins the one already in flight',
  reads === 1,
  `${reads} read on the wire -- a second would be queued behind the first anyway`);

check('   and waits for it, rather than answering with no market at all',
  !(await landed(forced)),
  'this is the whole bug: the wait used to return instantly with nothing');

answer?.(reading(0));
await background;

const seen = await forced;
check('   and comes back with what that read produced',
  seen?.market === 'SOL/USDT:USDT' && seen?.last === 101.77,
  seen ? `${seen.market} at ${seen.last}` : 'nothing, which is the failure');

// --- a read that hangs must not silence every read after it ----------------

clock = 100_000;
void guard.refreshMarket();
const wedged = answer;
check('the next sweep starts a fresh read',
  reads === 2,
  `${reads} reads -- and this one is never going to answer`);

clock += 5_000;
void guard.refreshMarket();
check('   a sweep inside the deadline does not start one on top of it',
  reads === 2,
  'passes that stack are how a slow queue becomes a stopped one');

clock += 11_000;
void guard.refreshMarket();
check('   but past the deadline the wedged read is abandoned and a new one goes out',
  reads === 3,
  `${reads} reads -- before this fix the count stopped at 2 for the rest of the session`);

// The wedged read settles long after it was given up on. It must not clear the
// flag belonging to the read that replaced it.
wedged?.(reading(100_000));
await sleep(5);

clock += 1_000;
void guard.refreshMarket();
check('   and the abandoned read cannot let a third start on top of the current one',
  reads === 3,
  'a late read settling must not hand ownership back to nobody');

answer?.(reading(116_000));
await sleep(5);

// --- a stale reading beats no reading --------------------------------------

clock += 60_000;
const stale = await guard.marketAt(30_000);
check('a caller that can take a stale reading is given one, and a read is started',
  stale?.at === 116_000 && reads === 4,
  stale
    ? `handed the reading from ${stale.at}, refreshing behind it`
    : 'handed nothing, so the coach would say the market was unavailable');

answer?.(reading(clock));
await sleep(5);

// --- and a caller that names a tolerance never waits, even with nothing yet --
//
// The confirmation panel's sentence and the unprompted remark both pass a
// tolerance here and both time-box the coach itself -- but they awaited this
// without a limit, and on the first call of a session there is nothing cached
// to return, so this used to fall through to the waiting path and put an
// unbounded read in front of a panel due at the speed of a keypress.

{
  clock = 0;
  const cold = new GuardService({ clock: () => clock, elapsed: () => clock });
  let started = 0;
  cold.setMarketSource(
    () =>
      new Promise<MarketContext | undefined>(() => {
        started++;
      })
  );

  const tolerant = cold.marketAt(60_000);
  check('with nothing read yet, a caller that can take a stale reading still does not wait',
    (await landed(tolerant)) && (await tolerant) === undefined && started === 1,
    `came back with no market and left a read going -- ${started} read started`);
}

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
