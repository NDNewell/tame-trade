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
import { CoachBlock } from '../ui/coachBlocks.js';
import { CoachLog, CoachOccasion } from './coachLog.js';
import { Finding } from './guardrails.js';
import { MarketContext } from './marketContext.js';
import { SessionSnapshot, dayKey } from './sessionJournal.js';

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
  /**
   * The reply as the coach divided it, when it arrived divided.
   *
   * `text` is kept alongside because it is what the transcript stores and what
   * a later turn is shown as history: a conversation reads back as prose, not
   * as a structure. The blocks are for the panel, which is the only thing that
   * needs to know where one point ends.
   */
  blocks?: CoachBlock[];
}

/** Blocks rendered back to prose, for the archive and for the model's own history. */
export const blocksToText = (blocks: CoachBlock[]): string =>
  blocks.map((block) => block.text).join('\n\n');

export interface CoachThreadOptions {
  coach: Coach;
  /** The session as it stands, read at the moment a call is made. */
  snapshot: () => SessionSnapshot;
  /** What the guardrails currently hold to be true. */
  findings?: () => Finding[];
  /**
   * The market, no older than the age the caller asks for. A question is worth
   * a fresh reading; a remark that arrives uninvited takes whatever is to hand.
   */
  market?: (maxAgeMs: number) => Promise<MarketContext | undefined>;
  clock?: () => number;
  /** Injected in tests; the real one is Date.now. */
  nudgeIntervalMs?: number;
  /**
   * Where the conversation is kept. Omitted in tests, which have no business
   * writing to the operator's home directory.
   */
  log?: CoachLog;
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
  private market: (maxAgeMs: number) => Promise<MarketContext | undefined>;
  private now: () => number;
  private nudgeIntervalMs: number;
  private log: CoachLog | undefined;
  /**
   * How wide the panel's prose column is.
   *
   * Told to the coach so a block's length limit is measured in rows of the
   * panel it is actually going into. A default is carried for tests and for the
   * moment before the workspace has drawn itself; being a few columns out costs
   * a split in a slightly different place and nothing else.
   */
  private paneWidthColumns = 40;
  /** Stamped onto each turn so a transcript says what was being traded. */
  private subject: string | undefined;

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
    this.market = options.market ?? (async () => undefined);
    this.now = options.clock ?? (() => Date.now());
    this.nudgeIntervalMs = options.nudgeIntervalMs ?? DEFAULT_NUDGE_INTERVAL_MS;
    this.log = options.log;
  }

  /** Adopts a transcript, which is found after this object already exists. */
  useLog(log: CoachLog): void {
    this.log = log;
  }

  paneWidth(): number {
    return this.paneWidthColumns;
  }

  /** The panel's prose width, as the frame worked it out. */
  setPaneWidth(width: number): void {
    if (Number.isFinite(width) && width >= 8) this.paneWidthColumns = Math.floor(width);
  }

  /** Which market the conversation is about, for the record. */
  setSubject(market: string | undefined): void {
    this.subject = market;
  }

  /**
   * Puts today's transcript back into the panel.
   *
   * A restart at lunchtime should not present an empty panel as though the
   * morning had not happened: the operator can see the morning's positions in
   * every other region, and only the conversation would have amnesia. The tail
   * is taken because the panel holds a tail; the archive keeps the rest.
   */
  restore(now = this.now()): void {
    if (!this.log || this.entries.length > 0) return;

    for (const turn of this.log.read(dayKey(now)).slice(-MAX_ENTRIES)) {
      this.entries.push({ kind: turn.speaker, text: turn.text, at: turn.at });
    }
    this.revision++;
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

    this.push('operator', text, 'question');

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
      // Zero: a question typed just now is answered against the market as it is
      // now, not as it was when the panel last refreshed itself.
      const market = await this.market(0).catch(() => undefined);

      const written = await this.coach
        .converse(text, history, this.snapshot(), this.findings(), market, this.paneWidthColumns)
        .catch(() => undefined);

      if (written === undefined) {
        this.push(
          'system',
          'The coach could not answer that one. The numbers above are unchanged.',
          'answer'
        );
      } else {
        this.push('coach', blocksToText(written), 'answer', undefined, written);
      }
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
      const market = await this.market(60_000).catch(() => undefined);
      const written = await this.coach
        .remark(finding, this.snapshot(), market)
        .catch(() => undefined);
      if (written === undefined) return false;
      this.push('coach', written, 'remark', finding.behaviour.id);
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

  /**
   * A coach turn the thread did not ask for, already divided into blocks.
   *
   * The debrief comes this way: it is written by the same voice as an answer
   * and belongs in the thread as one, rather than as a note in the panel's
   * voice -- which is what it used to be, and which is why it rendered without
   * a speaker or any structure at all.
   */
  speak(blocks: CoachBlock[], occasion: CoachOccasion = 'debrief'): void {
    if (blocks.length === 0) return;
    this.push('coach', blocksToText(blocks), occasion, undefined, blocks);
  }

  clear(): void {
    this.entries = [];
    this.revision++;
  }

  /**
   * Adds a line to the panel and to the record.
   *
   * Both, always, and in that order. A turn that reached the operator but not
   * the transcript would make the archive quietly wrong in the one direction
   * that is hard to notice later -- it would read as though the coach had said
   * less than it did.
   */
  private push(
    kind: CoachEntryKind,
    text: string,
    occasion: CoachOccasion = 'system',
    behaviour?: string,
    blocks?: CoachBlock[]
  ): void {
    const at = this.now();
    this.entries.push({ kind, text, at, blocks });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.revision++;

    this.log?.append({ at, speaker: kind, occasion, text, market: this.subject, behaviour });
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
