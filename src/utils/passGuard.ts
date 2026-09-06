// src/utils/passGuard.ts
//
// One pass at a time, with a way out of a pass that never ends.
//
// Several places here poll something slow on a timer -- the panel refresh, the
// guard sweep, the coach's market read, the coach's candle ladder -- and every
// one of them has to answer the same two questions.
//
// Can a second pass start while the first is still running? No. Each pass is
// half a dozen requests through one rate-limited queue, and passes that overlap
// queue work faster than the exchange answers it: that is not a slow client,
// it is a client accelerating away from an exchange that answers at a fixed
// rate, and it ends at 'throttle queue is over maxCapacity (1000)'.
//
// And what happens to a pass that never finishes? It is abandoned. A flag with
// no deadline behind it turns one hung request into a session with no data in
// it and nothing in the log to say why -- a deadlock is worse than a backlog,
// because a backlog drains.
//
// The second question kept being answered one place at a time. It was answered
// for the panel after a session spent showing '--' in every field, and not for
// the two reads behind the coach, which had the same bare flag; so when the
// queue backed up the panel recovered and the coach went blind for the rest of
// the day, insisting there was no market data while the market sat on the
// screen next to it. Hence one implementation rather than a fourth copy.
//
// There is a third question, which only the coach's market read asks: what
// should a caller who *must* have fresh data do when a pass is already running?
// Reading whatever is cached is right for a timer and wrong for someone who has
// just typed a question, so `wait` joins the pass in flight instead of skipping
// past it -- with a ceiling, because the reason this file exists is that the
// thing being waited on can hang.
//
// And a fourth, which all of them ask without knowing it: what is a duration
// measured against? A deadline is a subtraction of two clock readings, and
// `Date.now()` is not a clock that only counts forwards. See `monotonic.ts` for
// the day that cost. Durations here are monotonic.

import { monotonicNow } from './monotonic.js';

export interface PassGuardOptions {
  /**
   * How long a pass may run before the next caller stops waiting for it.
   *
   * An await cannot be cancelled, so an abandoned pass keeps running. What it
   * loses is ownership of the flag, so that when it finally settles it cannot
   * clear one belonging to a pass that started after it.
   */
  deadlineMs: number;

  /**
   * How long has this been going -- not what time is it.
   *
   * Injected in tests; the real one is `monotonicNow`, deliberately not
   * `Date.now`. A pass is abandoned on the strength of this subtraction, and a
   * wall clock that steps forward makes a healthy pass look wedged and a wall
   * clock that steps back makes a wedged one look new.
   */
  now?: () => number;

  /**
   * Told when a pass is abandoned, and how long it had been running.
   *
   * A pass that outlives its deadline is itself the news. Recovering quietly
   * looks identical to nothing having gone wrong, which is how the operator
   * ends up trusting figures that stopped moving several minutes ago.
   */
  onAbandon?: (ranForMs: number) => void;
}

export class PassGuard {
  /** When the running pass began, or null when none is. */
  private since: number | null = null;
  /** Identifies the running pass, so a late one cannot clear a newer one's flag. */
  private pass = Symbol('idle');
  /** The pass in flight, for callers that would rather join it than skip it. */
  private inFlight: Promise<void> | undefined;
  private now: () => number;

  constructor(private options: PassGuardOptions) {
    this.now = options.now ?? monotonicNow;
  }

  /**
   * Runs `run`, unless a pass is already going and still inside its deadline --
   * in which case that pass is handed back instead and `run` is not called.
   *
   * Never rejects. This owns the flag and not the work: what a failure means is
   * the caller's to decide, inside `run`, which is the only place with the
   * error to decide it with.
   */
  start(run: () => Promise<void>): Promise<void> {
    const now = this.now();

    if (this.since !== null) {
      if (now - this.since < this.options.deadlineMs) {
        return this.inFlight ?? Promise.resolve();
      }
      this.options.onAbandon?.(now - this.since);
    }

    const mine = Symbol('pass');
    this.pass = mine;
    this.since = now;

    const settled = (async () => {
      try {
        await run();
      } catch {
        // Swallowed on purpose, and only here: a pass that threw is a pass
        // that is over, and `run` has already had its chance to care.
      } finally {
        if (this.pass === mine) this.since = null;
      }
    })();

    this.inFlight = settled;
    return settled;
  }

  /**
   * The same, for a caller that would rather wait than read something stale --
   * but only for so long.
   *
   * Returns whether the pass finished inside the wait. It resolves either way
   * and never throws: the caller is expected to have something to fall back on,
   * because the whole point of the ceiling is that the pass may be waiting on
   * something that will never answer.
   */
  async wait(run: () => Promise<void>, maxWaitMs: number): Promise<boolean> {
    const pass = this.start(run);

    // Deliberately not unref'd. It holds the event loop open for as long as the
    // wait is outstanding and no longer -- the race clears it the moment the
    // pass lands -- and unref'ing it reintroduces the failure this method
    // exists to prevent: with nothing else keeping the loop alive the timer
    // never fires, so the ceiling never arrives and the caller waits forever on
    // a pass that already had.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), maxWaitMs);
    });

    try {
      return await Promise.race([pass.then(() => true), expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
