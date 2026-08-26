// src/guard/findingTracker.ts
//
// The difference between a condition and an event.
//
// The sweep re-runs every thirty seconds and re-derives the same findings from
// the same open position, which means a standing breach -- a position sized
// past the risk limit, a day that has given back its profit -- is *true* on
// every pass. Reporting each pass turns one fact into a hundred and twenty log
// lines an hour, and a log that repeats itself is a log nobody reads. Worse,
// the repeats evict everything else: the activity ring holds a few hundred
// events, so an afternoon of two standing breaches will bury every fill,
// cancel and debrief that happened between them.
//
// So the sweep's findings are treated as *state*, not as news. This tracker
// holds the set that is currently true and reports only the edges: a finding
// that has appeared, one whose severity has climbed, and one that has stopped
// being true. What is merely still true is available to be *displayed* -- see
// `active` -- which is the honest place for a standing condition. A status
// line that reads 'still true' costs one row and no attention; a log line that
// says it for the ninetieth time costs the whole log.
//
// The measurement itself is untouched. Everything here is about what is said
// afterwards, which is why it lives beside the guardrails rather than inside
// them: an operator who wants the noise back should be able to change the
// reporting without anyone re-checking the detectors.

import { BehaviourId, Severity, atLeast } from './behaviours.js';
import { Finding } from './guardrails.js';

/** Why a finding is worth a line right now. */
export type TransitionKind =
  /** Not true on the previous sweep; true on this one. */
  | 'appeared'
  /** Was already true, and has become more serious. */
  | 'escalated'
  /** Was true, and no longer is. */
  | 'cleared';

export interface Transition {
  kind: TransitionKind;
  behaviour: BehaviourId;
  /**
   * The finding as it now stands. Absent on 'cleared', which is the one kind
   * that has no current finding to describe -- the detector stopped returning
   * one, and that is the whole news.
   */
  finding?: Finding;
  /** The severity this finding held before, on 'escalated'. */
  from?: Severity;
}

interface Tracked {
  finding: Finding;
  severity: Severity;
  /** When it first became true, for 'standing for 20m' in the status line. */
  since: number;
  /** The last sweep on which it was still true, to detect disappearance. */
  seen: number;
}

/**
 * Remembers which findings are currently true, and reports the edges.
 *
 * Deliberately keyed on the behaviour alone rather than on the finding's text.
 * The detail line carries live numbers -- 'given back 71%' becomes 108% becomes
 * 94% as the mark moves -- and keying on it would make every recomputation look
 * like a brand new finding, which is exactly the behaviour this exists to stop.
 * The numbers are still shown; they are just shown by the status line, which
 * can be rewritten in place, rather than by appending to a log that cannot.
 */
export class FindingTracker {
  private tracked = new Map<BehaviourId, Tracked>();
  private sweeps = 0;

  /**
   * Folds one sweep's findings in, and says what changed.
   *
   * Order is deliberate: clearances come before appearances, so a log reading
   * the transitions in order shows a condition ending before whatever replaced
   * it begins.
   */
  update(findings: Finding[], now: number): Transition[] {
    this.sweeps++;

    const transitions: Transition[] = [];
    // A behaviour can only be found once per sweep -- the detectors run one
    // apiece -- but taking the strongest defensively costs nothing and stops a
    // duplicate from deciding the severity by arriving second.
    const incoming = new Map<BehaviourId, Finding>();
    for (const finding of findings) {
      const existing = incoming.get(finding.behaviour.id);
      if (!existing || atLeast(finding.severity, existing.severity)) {
        incoming.set(finding.behaviour.id, finding);
      }
    }

    for (const [id, previous] of this.tracked) {
      if (incoming.has(id)) continue;
      this.tracked.delete(id);
      transitions.push({ kind: 'cleared', behaviour: id, finding: previous.finding });
    }

    for (const [id, finding] of incoming) {
      const previous = this.tracked.get(id);

      if (!previous) {
        this.tracked.set(id, {
          finding,
          severity: finding.severity,
          since: now,
          seen: now,
        });
        transitions.push({ kind: 'appeared', behaviour: id, finding });
        continue;
      }

      // Still true. Keep the newest wording and numbers for the status line,
      // but say nothing unless it has actually got worse.
      const worse = !atLeast(previous.severity, finding.severity);
      const from = previous.severity;

      previous.finding = finding;
      previous.severity = finding.severity;
      previous.seen = now;

      if (worse) {
        transitions.push({ kind: 'escalated', behaviour: id, finding, from });
      }
    }

    return transitions;
  }

  /**
   * Everything currently true, worst first, then longest-standing.
   *
   * This is what the status line renders. Sorted here rather than at the call
   * site so the order cannot drift between the panel and `guard`.
   */
  active(): Array<{ finding: Finding; since: number }> {
    return [...this.tracked.values()]
      .sort((a, b) => {
        if (a.severity !== b.severity) return atLeast(a.severity, b.severity) ? -1 : 1;
        return a.since - b.since;
      })
      .map(({ finding, since }) => ({ finding, since }));
  }

  /** Whether anything is currently true, without building the array. */
  any(): boolean {
    return this.tracked.size > 0;
  }

  /**
   * Drops everything, reporting nothing.
   *
   * For a change that invalidates the comparison rather than resolves it --
   * guardrails switched off, a behaviour muted, the followed market changed.
   * Firing 'cleared' for those would claim the condition ended, and it did not;
   * we merely stopped looking. The next sweep re-announces whatever is still
   * true, which is the correct story.
   */
  reset(): void {
    this.tracked.clear();
  }

  /** How many sweeps have been folded in. Exposed for tests and diagnostics. */
  sweepCount(): number {
    return this.sweeps;
  }
}
