// src/guard/guardService.ts
//
// One object the rest of the application talks to.
//
// The journal, the detectors, the policy and the coach are separate on purpose
// and none of them should be wired into the exchange client individually --
// that would put five imports and five lifetimes into a file that is already
// long, and every one of them would be a thing to remember to keep in step.
//
// Deliberately knows nothing about exchanges, markets, or ccxt. Everything it
// needs arrives as an argument. That is what makes the guard testable without a
// connection, and what stops the guard's rules from quietly acquiring
// exchange-specific special cases.

import { BehaviourId, BEHAVIOURS } from './behaviours.js';
import { Coach } from './coach.js';
import { CoachThread } from './coachThread.js';
import { FindingTracker, Transition } from './findingTracker.js';
import { OrderProposal, PositionContext, PriceMove } from './detectors.js';
import { GuardPolicy, resolvePolicy } from './guardPolicy.js';
import {
  Finding,
  GuardVerdict,
  Guardrails,
  Intervention,
  SweepResult,
} from './guardrails.js';
import {
  Direction,
  FillEvent,
  SessionJournal,
  SessionSnapshot,
} from './sessionJournal.js';

/**
 * A sweep, plus what changed since the last one.
 *
 * `findings` is everything currently true and is what a status line renders;
 * `transitions` is the much shorter list of things that have started, worsened
 * or ended, and is the only part that belongs in a log. Keeping both on one
 * object is deliberate -- the caller that reports the edges and the caller that
 * displays the state are the same caller, and giving them two methods to call
 * in the right order is how they come to disagree.
 */
export interface GuardSweep extends SweepResult {
  transitions: Transition[];
  active: Array<{ finding: Finding; since: number }>;
}

export interface GuardServiceOptions {
  policy?: Partial<GuardPolicy>;
  apiKey?: string;
  /** Injected in tests; the real one is Date.now. */
  clock?: () => number;
  journal?: SessionJournal;
}

export class GuardService {
  private journal: SessionJournal;
  private guardrails: Guardrails;
  private coach: Coach;
  private thread: CoachThread;
  private tracker = new FindingTracker();
  private policy: GuardPolicy;
  private now: () => number;
  private currency = '';

  constructor(options: GuardServiceOptions = {}) {
    this.policy = resolvePolicy(options.policy);
    this.guardrails = new Guardrails(this.policy);
    this.coach = new Coach({ apiKey: options.apiKey });
    this.now = options.clock ?? (() => Date.now());
    this.journal = options.journal ?? new SessionJournal();
    this.thread = new CoachThread({
      coach: this.coach,
      snapshot: () => this.snapshot(),
      // What the coach is told is currently true is what the status line says
      // is currently true. Deriving it twice is how the panel and the prose
      // come to describe different sessions.
      findings: () => this.tracker.active().map((entry) => entry.finding),
      clock: this.now,
    });
  }

  /**
   * Picks up today's journal, so a restart continues the session.
   *
   * Separate from the constructor because it touches the filesystem, and an
   * object that reads disk to exist cannot be made in a test without one.
   */
  load(): void {
    this.journal.load(this.now());
  }

  getPolicy(): GuardPolicy {
    return this.policy;
  }

  setPolicy(policy: GuardPolicy): void {
    this.policy = policy;
    this.guardrails.setPolicy(policy);
    // A muted behaviour stops being reported, and a disabled guard stops
    // reporting entirely. Neither means the condition resolved, so the tracked
    // set is dropped rather than cleared: 'cleared' is a claim about the
    // position, and this is only a change in what we are looking at.
    this.tracker.reset();
  }

  /** The coach conversation, for the panel that renders it. */
  getThread(): CoachThread {
    return this.thread;
  }

  /** Everything the guardrails currently hold to be true, worst first. */
  activeFindings(): Array<{ finding: Finding; since: number }> {
    return this.tracker.active();
  }

  coachAvailable(): boolean {
    return this.coach.available();
  }

  snapshot(): SessionSnapshot {
    return this.journal.snapshot(this.now(), this.currency);
  }

  // --- recording ----------------------------------------------------------

  recordFill(fill: Omit<FillEvent, 'type' | 'at'> & { at?: number }): void {
    this.journal.record({ type: 'fill', at: fill.at ?? this.now(), ...fill });
  }

  recordOrderPlaced(market: string, orderId?: string): void {
    this.journal.record({ type: 'order-placed', at: this.now(), market, orderId });
  }

  recordOrderCancelled(market: string, orderId?: string): void {
    this.journal.record({ type: 'order-cancelled', at: this.now(), market, orderId });
  }

  recordStopMoved(
    market: string,
    side: Direction,
    from: number,
    to: number,
    entryPrice?: number
  ): void {
    this.journal.record({
      type: 'stop-moved',
      at: this.now(),
      market,
      side,
      from,
      to,
      entryPrice,
    });
  }

  recordStopCancelled(market: string, trigger: number, underwater: boolean): void {
    this.journal.record({
      type: 'stop-cancelled',
      at: this.now(),
      market,
      trigger,
      underwater,
    });
  }

  /**
   * An equity sample, which is what the peak and the give-back are measured
   * from.
   *
   * Cheap to over-report: the snapshot only ever keeps the latest value and the
   * high-water mark, so a sample per refresh costs one journal line and buys a
   * peak that is actually the peak rather than whatever equity happened to be
   * when something else asked.
   */
  recordEquity(equity: number, currency: string): void {
    if (!Number.isFinite(equity)) return;
    this.currency = currency || this.currency;
    this.journal.record({ type: 'equity', at: this.now(), equity, currency });
  }

  // --- deciding -----------------------------------------------------------

  /**
   * What should happen to an order that has not been sent.
   *
   * Findings are journalled whether or not they stop anything. A guard that
   * only records its interventions cannot answer 'was it right?' later, because
   * the times it spoke and was correct to be ignored look identical to the
   * times it never spoke at all.
   */
  review(input: {
    proposal: OrderProposal;
    position?: PositionContext;
    priceMove?: PriceMove;
    equity?: number;
    currency?: string;
  }): GuardVerdict {
    const now = this.now();
    const verdict = this.guardrails.review({
      now,
      snapshot: this.snapshot(),
      ...input,
    });

    for (const finding of verdict.findings) {
      this.journal.record({
        type: 'flag',
        at: now,
        market: input.proposal.market,
        behaviour: finding.behaviour.id,
        severity: finding.severity,
      });
    }

    return verdict;
  }

  /** The operator sent an order through a hold. Recorded, not judged. */
  recordOverride(market: string, behaviour: BehaviourId): void {
    this.journal.record({ type: 'override', at: this.now(), market, behaviour });
  }

  sweep(positions: PositionContext[], equity?: number, currency?: string): GuardSweep {
    const now = this.now();
    const result = this.guardrails.sweep({
      now,
      snapshot: this.snapshot(),
      positions,
      equity,
      currency: currency ?? this.currency,
    });

    return {
      ...result,
      transitions: this.tracker.update(result.findings, now),
      active: this.tracker.active(),
    };
  }

  /** Stops new entries until `until`. Journalled, so a restart honours it. */
  lockout(until: number, behaviour: BehaviourId, reason: string): void {
    this.journal.record({ type: 'lockout', at: this.now(), until, behaviour, reason });
  }

  /**
   * Lifts a lockout, on purpose and on the record.
   *
   * There is no argument for making this impossible -- a real emergency does
   * not care what the guard decided twenty minutes ago -- but there is every
   * argument for making it deliberate and visible afterwards.
   */
  liftLockout(reason: string): void {
    this.journal.record({ type: 'lockout-lifted', at: this.now(), reason });
  }

  lockedOut(): { until: number; reason: string } | undefined {
    const lockout = this.snapshot().lockout;
    return lockout ? { until: lockout.until, reason: lockout.reason } : undefined;
  }

  // --- talking ------------------------------------------------------------

  /**
   * A better sentence for the confirmation panel, when one is available in
   * time.
   *
   * Bounded rather than awaited without limit. The panel must appear at the
   * speed of a keypress; a coach that is having a slow day gets left behind and
   * the catalogue's own wording is used, which was always good enough.
   */
  async phraseFor(finding: Finding, budgetMs = 1200): Promise<string> {
    if (!this.coach.available()) return finding.detail;

    const written = await Promise.race([
      this.coach.speakTo(finding, this.snapshot()),
      new Promise<undefined>((resolve) => setTimeout(resolve, budgetMs)),
    ]).catch(() => undefined);

    return written ?? finding.detail;
  }

  async debrief(findings: Finding[] = []): Promise<string | undefined> {
    return this.coach.debrief(this.snapshot(), findings);
  }

  /** The catalogue entry behind a flag, for `guard explain`. */
  explain(id: BehaviourId): string {
    const behaviour = BEHAVIOURS[id];
    return `${behaviour.title} (${behaviour.group}) — ${behaviour.claim}\n\n${behaviour.why}`;
  }

  /**
   * A plain-text summary of where the session stands.
   *
   * Deliberately not a model call: 'what is my state' must answer instantly and
   * identically every time, whatever the network is doing.
   */
  status(): string[] {
    const snapshot = this.snapshot();
    const lines: string[] = [];

    lines.push(
      this.policy.enabled ? 'Guardrails: on' : 'Guardrails: OFF — nothing is being checked'
    );

    const elapsed = Math.round((snapshot.now - snapshot.startedAt) / 60_000);
    lines.push(
      `Session: ${elapsed}m, ${snapshot.trades.length} round trips, ` +
        `${snapshot.realizedPnl >= 0 ? '+' : ''}${snapshot.realizedPnl.toFixed(2)} ` +
        `${snapshot.currency} realized`
    );

    if (snapshot.consecutiveLosses > 0) {
      lines.push(`Losing streak: ${snapshot.consecutiveLosses}`);
    }

    const limit = this.policy.dailyLossLimit;
    lines.push(
      limit === undefined
        ? 'Daily loss limit: not set — no rule can stop you today'
        : `Daily loss limit: ${limit} (${Math.max(0, limit + snapshot.realizedPnl).toFixed(
            2
          )} left)`
    );

    const lockout = snapshot.lockout;
    if (lockout) {
      lines.push(
        `LOCKED OUT for ${Math.ceil((lockout.until - snapshot.now) / 60_000)}m: ${lockout.reason}`
      );
    }

    if (this.policy.autoExit.length > 0) {
      lines.push(`Will close positions on: ${this.policy.autoExit.join(', ')}`);
    }

    if (this.policy.muted.length > 0) {
      lines.push(`Muted: ${this.policy.muted.join(', ')}`);
    }

    lines.push(
      this.coach.available()
        ? 'Coach: available'
        : 'Coach: off (set ANTHROPIC_API_KEY to enable session debriefs)'
    );

    return lines;
  }
}

export type { Finding, GuardVerdict, Intervention, SweepResult };
export type { Transition } from './findingTracker.js';
export type { CoachEntry } from './coachThread.js';
