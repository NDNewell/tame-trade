// A pass that hangs must not take the rest of the session with it.
//
// The overlap guard came first and was right: passes that stack turn a slow
// exchange into a dead client. Then it produced the opposite failure, twice --
// a bare in-flight flag with nothing behind it, so one request that neither
// answered nor errored left the flag set forever. The panel got a deadline
// after a session spent showing '--' in every field; the coach's two reads did
// not, and went blind behind the same wedged queue.
//
// Pinned here as a shape, because the shape is what keeps being got wrong.

import { PassGuard } from './passGuard.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise the test decides when to settle. */
function deferred(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => {};
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { promise, settle };
}

/** Whether a promise has come back, judged by giving it a moment to. */
const landed = async (promise: Promise<unknown>): Promise<boolean> => {
  const waiting = Symbol('waiting');
  return (await Promise.race([promise, sleep(5).then(() => waiting)])) !== waiting;
};

// --- one pass at a time, and the second one joins it -----------------------

{
  let clock = 0;
  const guard = new PassGuard({ deadlineMs: 1000, now: () => clock });
  const gate = deferred();
  let runs = 0;

  const work = async (): Promise<void> => {
    runs++;
    await gate.promise;
  };

  const first = guard.start(work);
  const second = guard.start(work);

  check('a second start inside the deadline does not run the work again',
    runs === 1,
    `${runs} pass -- overlapping passes are what queues work faster than it drains`);

  check('   and it is handed the pass already in flight',
    first === second,
    'a caller that joins can be told when the pass it joined actually finished');

  gate.settle();
  await Promise.all([first, second]);
}

// --- a pass past its deadline is abandoned ---------------------------------

{
  let clock = 0;
  const abandoned: number[] = [];
  const guard = new PassGuard({
    deadlineMs: 1000,
    now: () => clock,
    onAbandon: (ranForMs) => abandoned.push(ranForMs),
  });

  const stuck = deferred();
  const running = deferred();
  let runs = 0;

  void guard.start(async () => {
    runs++;
    await stuck.promise;
  });

  clock = 500;
  void guard.start(async () => {
    runs++;
  });
  check('a pass inside the deadline is still skipped',
    runs === 1 && abandoned.length === 0,
    `${runs} pass -- the overlap guard still holds where it should`);

  clock = 1500;
  void guard.start(async () => {
    runs++;
    await running.promise;
  });
  check('   but a pass past the deadline is abandoned and the guard recovers',
    runs === 2 && abandoned[0] === 1500,
    `${runs} passes, abandoned after ${abandoned[0]}ms -- the session continues`);

  // The abandoned pass keeps running; there is no way to stop an await. What it
  // must not do is hand ownership back to nobody when it finally settles.
  stuck.settle();
  await sleep(5);

  clock = 1600;
  void guard.start(async () => {
    runs++;
  });
  check('   and the abandoned pass cannot clear the newer one\'s flag',
    runs === 2,
    'a late pass settling must not let a third start on top of the second');

  running.settle();
  await sleep(5);
}

// --- the deadline is measured on a clock that cannot be stepped ------------
//
// 2026-09-01: the host's time service had been stopped for six days, so its
// clock had drifted nineteen seconds, and the machine spent the day being
// stepped forwards to the host's time and back again to NTP's, every five
// seconds. Every deadline here was a subtraction of two `Date.now()` readings,
// so every one of them fired on passes that were milliseconds old -- for a
// whole session, while nothing whatsoever was wedged.
//
// No clock is injected in this block on purpose. It is the real default that
// has to be right, and the tests above would pass just as happily with a guard
// that read the wall clock.

{
  const wallClock = Date.now;
  const abandoned: number[] = [];
  const guard = new PassGuard({
    deadlineMs: 1000,
    onAbandon: (ranForMs) => abandoned.push(ranForMs),
  });

  const gate = deferred();
  let runs = 0;
  const work = async (): Promise<void> => {
    runs++;
    await gate.promise;
  };

  void guard.start(work);

  // Nineteen seconds into the future, mid-pass. The pass is milliseconds old
  // and perfectly healthy.
  Date.now = () => wallClock() + 19_425;
  try {
    void guard.start(work);
  } finally {
    Date.now = wallClock;
  }

  check('a step in the wall clock does not abandon a live pass',
    runs === 1 && abandoned.length === 0,
    `${runs} pass, ${abandoned.length} abandoned -- a deadline is a duration, and durations do not read the wall clock`);

  gate.settle();
  await sleep(5);
}

// --- a caller that must have fresh data waits, rather than stepping over ----
//
// This is the bug the coach hit. The forced path called the refresh, the
// refresh saw the flag and returned without doing anything, and the question
// was answered against no market at all -- while a read that would have
// answered it was in flight the whole time.

{
  let clock = 0;
  const guard = new PassGuard({ deadlineMs: 10_000, now: () => clock });
  const gate = deferred();
  let read: string | undefined;

  void guard.start(async () => {
    await gate.promise;
    read = 'the market';
  });

  const joined = guard.wait(async () => {
    read = 'a second read nobody asked for';
  }, 1000);

  check('a forced wait joins the pass in flight rather than stepping over it',
    !(await landed(joined)),
    'it is still waiting, and has not started a read of its own');

  gate.settle();
  check('   and comes back with what that pass produced',
    (await joined) === true && read === 'the market',
    `returned true, read "${read}"`);
}

// --- but the wait has a ceiling --------------------------------------------

{
  const guard = new PassGuard({ deadlineMs: 60_000, now: () => 0 });
  const never = new Promise<void>(() => {});

  const finished = await guard.wait(() => never, 20);
  check('a wait on a pass that never lands gives up instead of hanging',
    finished === false,
    'false, so the caller knows to fall back rather than being told it is fresh');
}

// --- a pass that throws is a pass that is over -----------------------------

{
  let clock = 0;
  const guard = new PassGuard({ deadlineMs: 1000, now: () => clock });

  let threw = false;
  await guard.start(async () => {
    threw = true;
    throw new Error('the read failed');
  });

  let ran = false;
  await guard.start(async () => {
    ran = true;
  });

  check('a pass that throws does not latch the guard, and does not escape it',
    threw && ran,
    'a failure is the caller\'s to handle inside the work, not a reason to stop polling');
}

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
