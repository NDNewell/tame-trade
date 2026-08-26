// src/guard/coachThread.ts
//
// The conversation, kept separately from the log it used to be dumped into.
//
// A debrief is a hundred and twenty words of prose. The activity log is a
// column of timestamped events a few words wide, scrolled by a ring buffer, and
// putting paragraphs into it produced the worst of both: prose too fragmented
// to read and a log too diluted to scan. So the coach gets its own thread, with
// its own scrollback and its own idea of what a line is.
//
// Two things arrive here. Questions the operator typed, which are answered in
// order and always answered. And unprompted remarks when a guardrail starts
// applying, which are rate-limited hard -- an uninvited paragraph is an
// interruption, and the second one costs the panel its reader.
//
// Everything is best-effort. A coach that is slow, unconfigured or having a bad
// day leaves the thread exactly as it was; nothing here is in the path of an
// order, and no failure reaches the caller as an exception.

import { BehaviourId, atLeast } from './behaviours.js';
import { Coach, ThreadTurn } from './coach.js';
import { Finding } from './guardrails.js';
import { SessionSnapshot } from './sessionJournal.js';

/** What a rendered line in the panel came from. */
export type CoachEntryKind =
  /** Something the operator typed. */
  | 'operator'
  /** The coach's reply, or an unprompted remark. */
  | 'coach'
  /** The panel's own voice: 'coach is off', 'nothing to say yet'. */
  | 'system';

export interface CoachEntry {
  kind: CoachEntryKind;
  text: string;
  at: number;
}

export interface CoachThreadOptions {
  coach: Coach;
  /** The session as it stands, read at the moment a call is made. */
  snapshot: () => SessionSnapshot;
  /** What the guardrails currently hold to be true. */
  findings?: () => Finding[];
  clock?: () => number;
  /** Injected in tests; the real one is Date.now. */
  nudgeIntervalMs?: number;
}

/**
 * Kept small on purpose. The thread is a place to read the last few exchanges,
 * not a transcript archive -- the journal is the archive, and it holds the
 * facts rather than the prose written about them.
 */
const MAX_ENTRIES = 60;

/** No more than one unprompted remark inside this window, whatever fires. */
const DEFAULT_NUDGE_INTERVAL_MS = 5 * 60_000;

/**
 * A behaviour gets at most this many unprompted remarks in a session. A
 * condition that keeps re-appearing has been heard; saying it a fourth time is
 * nagging, and the status line is already showing it.
 */
const MAX_NUDGES_PER_BEHAVIOUR = 2;

export class CoachThread {
  private entries: CoachEntry[] = [];
  private coach: Coach;
  private snapshot: () => SessionSnapshot;
  private findings: () => Finding[];
  private now: () => number;
  private nudgeIntervalMs: number;

  /** True while a model call is outstanding, so the panel can say so. */
  private inFlight = 0;
  private lastNudgeAt = 0;
  private nudged = new Map<BehaviourId, number>();
  /** Bumped on every change, so a renderer can tell whether to repaint. */
  private revision = 0;

  constructor(options: CoachThreadOptions) {
    this.coach = options.coach;
    this.snapshot = options.snapshot;
    this.findings = options.findings ?? (() => []);
    this.now = options.clock ?? (() => Date.now());
    this.nudgeIntervalMs = options.nudgeIntervalMs ?? DEFAULT_NUDGE_INTERVAL_MS;
  }

  available(): boolean {
    return this.coach.available();
  }

  /** Everything to render, oldest first. */
  all(): CoachEntry[] {
    return this.entries;
  }

  /** Whether a reply is outstanding. The panel shows a waiting line for it. */
  busy(): boolean {
    return this.inFlight > 0;
  }

  revisionNumber(): number {
    return this.revision;
  }

  /**
   * A question, answered in the thread.
   *
   * The operator's line is pushed before the call goes out, so the panel shows
   * what was asked while the answer is still being written. Resolves when the
   * reply has landed; callers that do not want to wait can drop the promise,
   * because the thread is updated either way.
   */
  async ask(question: string): Promise<void> {
    const text = question.trim();
    if (text.length === 0) return;

    this.push('operator', text);

    if (!this.coach.available()) {
      this.push(
        'system',
        "No coach configured. Add a key under 'AI Coach Key' on the home menu."
      );
      return;
    }

    // The history the model sees excludes the question just pushed -- that is
    // passed separately -- and excludes the panel's own voice, which is chrome
    // rather than conversation.
    const history = this.turns().slice(0, -1);

    this.inFlight++;
    this.revision++;
    try {
      const written = await this.coach
        .converse(text, history, this.snapshot(), this.findings())
        .catch(() => undefined);

      this.push(
        written === undefined ? 'system' : 'coach',
        written ?? 'The coach could not answer that one. The numbers above are unchanged.'
      );
    } finally {
      this.inFlight--;
      this.revision++;
    }
  }

  /**
   * An unprompted remark about a guardrail that has just started applying.
   *
   * Returns whether anything was said, which is mostly for the tests: the
   * caller has nothing useful to do about a nudge that was rate-limited, and
   * must not retry it.
   */
  async nudge(finding: Finding): Promise<boolean> {
    if (!this.coach.available()) return false;

    // Notices are visible in the status line and in the log's own transition
    // entry. Speaking about them uninvited spends a call and a reader's
    // attention on something already on screen twice.
    if (!atLeast(finding.severity, 'hold')) return false;

    const now = this.now();
    if (now - this.lastNudgeAt < this.nudgeIntervalMs) return false;

    const already = this.nudged.get(finding.behaviour.id) ?? 0;
    if (already >= MAX_NUDGES_PER_BEHAVIOUR) return false;

    // A question in flight wins. Two paragraphs landing together reads as the
    // panel talking over itself, and the remark is the one nobody asked for.
    if (this.inFlight > 0) return false;

    this.lastNudgeAt = now;
    this.nudged.set(finding.behaviour.id, already + 1);

    this.inFlight++;
    this.revision++;
    try {
      const written = await this.coach.remark(finding, this.snapshot()).catch(() => undefined);
      if (written === undefined) return false;
      this.push('coach', written);
      return true;
    } finally {
      this.inFlight--;
      this.revision++;
    }
  }

  /** The panel's own voice, for state the coach did not write. */
  note(text: string): void {
    this.push('system', text);
  }

  clear(): void {
    this.entries = [];
    this.revision++;
  }

  private push(kind: CoachEntryKind, text: string): void {
    this.entries.push({ kind, text, at: this.now() });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.revision++;
  }

  /** The thread as the model takes it: real turns only, in order. */
  private turns(): ThreadTurn[] {
    return this.entries
      .filter((entry) => entry.kind !== 'system')
      .map((entry) => ({
        role: entry.kind === 'operator' ? ('operator' as const) : ('coach' as const),
        text: entry.text,
      }));
  }
}
