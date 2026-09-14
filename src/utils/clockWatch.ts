// src/utils/clockWatch.ts
//
// Notices when the wall clock is being stepped, and says so where the operator
// will see it.
//
// Twice now -- 2026-09-01 and 2026-09-13 -- the Windows host's time service
// had stopped, the host clock ran ahead, WSL copied it into the guest every
// five seconds and NTP pulled it straight back. Nothing in Tame was wrong, but
// ccxt's rate limiter refills from the wall clock, so every backwards step put
// its token bucket into debt and every exchange request queued behind the
// debt: refreshes were abandoned, order holds took ten seconds to appear, and
// the log said only that something was slow. Both times the diagnosis took an
// afternoon and the fix took one click on the host.
//
// This is the click, named in the log at the moment it is needed. The wall
// clock and the monotonic clock are read together once a second; over a second
// they should advance by the same amount, and when they do not the difference
// is exactly how far the wall clock was moved. Nothing here fixes the clock --
// it cannot; the fault is on the host -- and nothing here changes how any
// request is made. It is a diagnosis written where the symptom appears.

/** What the watch has to say, and where it should go. */
export type ClockReport = (severity: 'WARNING' | 'SYSTEM', message: string) => void;

export interface ClockWatchOptions {
  /** Injected in tests; the real one is Date.now. */
  wall?: () => number;
  /** Injected in tests; the real one is the monotonic clock. */
  steady?: () => number;
  report: ClockReport;
  /** How far the two clocks may disagree over one tick before it is a step. */
  thresholdMs?: number;
  /** How often to repeat the warning while the stepping continues. */
  remindEveryMs?: number;
  /** How long the clock must hold still before it is called steady again. */
  settleAfterMs?: number;
}

/**
 * Where to send the operator, as one line.
 *
 * Windows-specific because the fault is: the only host this has happened on is
 * a Windows machine running WSL, the Settings button is what fixed it when the
 * command line did not, and a generic "check your clock" is what the log used
 * to say by omission.
 */
export const CLOCK_FIX =
  'On Windows: Settings > Time & language > Date & time > Sync now. ' +
  'Exchange requests queue behind every step until it stops; no restart is needed after.';

export class ClockWatch {
  private readonly wall: () => number;
  private readonly steady: () => number;
  private readonly report: ClockReport;
  private readonly thresholdMs: number;
  private readonly remindEveryMs: number;
  private readonly settleAfterMs: number;

  private lastWall: number | undefined;
  private lastSteady: number | undefined;

  /** Monotonic time of the last step seen, or -Infinity for never. */
  private lastStepAt = -Infinity;
  /** Monotonic time the current warning was written, or -Infinity. */
  private warnedAt = -Infinity;
  /** Steps seen since the current warning, counted for the reminder. */
  private stepsSinceWarning = 0;
  private stepping = false;

  constructor(options: ClockWatchOptions) {
    this.wall = options.wall ?? Date.now;
    this.steady = options.steady ?? (() => performance.now());
    this.report = options.report;
    this.thresholdMs = options.thresholdMs ?? 1_000;
    this.remindEveryMs = options.remindEveryMs ?? 5 * 60_000;
    this.settleAfterMs = options.settleAfterMs ?? 60_000;
  }

  /** Whether the clock has stepped recently and not yet settled. */
  isStepping(): boolean {
    return this.stepping;
  }

  /**
   * One reading. Called on a timer; harmless if called irregularly, because
   * what is compared is the change in each clock since the last call, and a
   * late call advances both by the same amount.
   */
  tick(): void {
    const wall = this.wall();
    const steady = this.steady();

    if (this.lastWall !== undefined && this.lastSteady !== undefined) {
      // How much further the wall clock moved than real time did. Positive is
      // a jump forwards, negative a jump back; the sign is reported because a
      // backwards step is the one that stalls the rate limiter.
      const skew = wall - this.lastWall - (steady - this.lastSteady);

      if (Math.abs(skew) >= this.thresholdMs) {
        this.onStep(skew, steady);
      } else if (this.stepping && steady - this.lastStepAt >= this.settleAfterMs) {
        this.stepping = false;
        this.report(
          'SYSTEM',
          `The system clock has held steady for ${Math.round(this.settleAfterMs / 1000)}s.`
        );
      }
    }

    this.lastWall = wall;
    this.lastSteady = steady;
  }

  private onStep(skew: number, steady: number): void {
    this.lastStepAt = steady;
    this.stepsSinceWarning++;

    const first = !this.stepping;
    const due = steady - this.warnedAt >= this.remindEveryMs;
    if (!first && !due) return;

    const seconds = (Math.abs(skew) / 1000).toFixed(1);
    const direction = skew < 0 ? 'back' : 'forward';
    const lead = first
      ? `The system clock just jumped ${direction} ${seconds}s.`
      : `The system clock is still being stepped: ${this.stepsSinceWarning} jumps in the last ` +
        `${Math.round((steady - this.warnedAt) / 60_000)} minutes, the latest ${direction} ${seconds}s.`;

    this.report('WARNING', `${lead} ${CLOCK_FIX}`);
    this.stepping = true;
    this.warnedAt = steady;
    this.stepsSinceWarning = 0;
  }
}
