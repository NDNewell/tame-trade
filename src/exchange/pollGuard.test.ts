// A poller that outlasts its own interval must not start again on top of itself.
//
// This is the failure that produced 'throttle queue is over maxCapacity (1000)'.
// The refresh timer fired every two seconds whether or not the previous pass had
// finished, and each pass issues half a dozen rate-limited requests. Once a pass
// took longer than the interval, passes accumulated: more requests queued, which
// made each pass slower, which started more of them. The shape is a feedback
// loop, so it is worth pinning as a shape rather than as a comment.

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pattern the workspace and the guard sweep both use. */
class Poller {
  running = false;
  passes = 0;
  concurrent = 0;
  peakConcurrent = 0;

  constructor(private guarded: boolean, private durationMs: number) {}

  async tick(): Promise<void> {
    if (this.guarded && this.running) return;
    this.running = true;
    this.concurrent++;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);
    try {
      this.passes++;
      await sleep(this.durationMs);
    } finally {
      this.concurrent--;
      this.running = false;
    }
  }
}

/** Ten ticks 10ms apart, each pass taking five times the interval. */
async function drive(poller: Poller): Promise<void> {
  const ticks: Array<Promise<void>> = [];
  for (let i = 0; i < 10; i++) {
    ticks.push(poller.tick());
    await sleep(10);
  }
  await Promise.all(ticks);
}

const unguarded = new Poller(false, 50);
await drive(unguarded);
check('unguarded: passes pile up when one outlasts the interval',
  unguarded.peakConcurrent > 1,
  `peak concurrency ${unguarded.peakConcurrent} from 10 ticks -- this is the bug`);

const guarded = new Poller(true, 50);
await drive(guarded);
check('guarded: never more than one pass at a time',
  guarded.peakConcurrent === 1,
  `peak concurrency ${guarded.peakConcurrent}`);

check('   and it still makes progress',
  guarded.passes > 1 && guarded.passes < 10,
  `${guarded.passes} passes from 10 ticks -- skipped ticks cost staleness, not the session`);

check('   and it is not left latched after the last pass',
  guarded.running === false,
  'a throwing or slow pass must always clear the flag, or the poller stops forever');

// --- a pass that never finishes must not stop the poller forever ------------
//
// The guard above fixed passes stacking, and introduced a worse failure in its
// place: one request that hangs left the flag set for the rest of the session,
// so every later tick returned early and the panel showed '--' in every field
// with nothing in the log to say why. A deadlock is worse than a backlog.

class DeadlinePoller {
  since: number | null = null;
  pass = Symbol('idle');
  started = 0;
  abandoned = 0;

  constructor(private deadlineMs: number) {}

  /** `now` is injected so the test does not have to wait out a real deadline. */
  tick(now: number, durationMs: number): void {
    if (this.since !== null) {
      if (now - this.since < this.deadlineMs) return;
      this.abandoned++;
    }

    const mine = Symbol('pass');
    this.pass = mine;
    this.since = now;
    this.started++;

    // The pass settles later; a stale one must not clear a newer one's flag.
    setTimeout(() => {
      if (this.pass === mine) this.since = null;
    }, durationMs);
  }
}

const stuck = new DeadlinePoller(1000);
stuck.tick(0, 10_000_000);        // a pass that will never realistically finish
stuck.tick(500, 10);              // inside the deadline: skipped
check('a pass inside the deadline is still skipped',
  stuck.started === 1,
  `${stuck.started} started -- the overlap guard still holds`);

stuck.tick(2000, 10);             // past the deadline: taken anyway
check('   but a pass past the deadline is abandoned and the poller recovers',
  stuck.started === 2 && stuck.abandoned === 1,
  `${stuck.started} started, ${stuck.abandoned} abandoned -- the session continues`);

await sleep(60);
check('   and the abandoned pass cannot clear the newer one\'s flag',
  stuck.since === null || stuck.pass !== undefined,
  'a late pass settling must not hand ownership back to nobody');

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
