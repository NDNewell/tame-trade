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
import { Coach, KeySource } from './coach.js';
import { CoachLog } from './coachLog.js';
import { CoachThread } from './coachThread.js';
import { SessionHistory } from './history.js';
import { FindingTracker, Transition } from './findingTracker.js';
import { OrderProposal, PositionContext, PriceMove } from './detectors.js';
import { GuardPolicy, resolvePolicy } from './guardPolicy.js';
import { MarketContext } from './marketContext.js';
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
  ReconciliationEvent,
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
  /**
   * Where the conversation is kept, and what is read back from previous days.
   *
   * Both omitted in tests, which have no business writing to the operator's
   * home directory or reading their trading record.
   */
  coachLog?: CoachLog;
  history?: SessionHistory;
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
  /** How the market is read, when anything has offered a way to read it. */
  private marketSource: (() => Promise<MarketContext | undefined>) | undefined;
  /**
   * The last market context read, and when.
   *
   * Held because the two calls that most need it are the two that can least
   * afford to wait for it: the confirmation panel's sentence is raced against a
   * keypress, and an unprompted remark arrives while the operator is doing
   * something else. Both take what is already here; only a question or a
   * debrief pays to refresh it.
   */
  private market: { at: number; context: MarketContext } | undefined;
  private marketRefreshInFlight = false;
  private history: SessionHistory | undefined;

  constructor(options: GuardServiceOptions = {}) {
    this.policy = resolvePolicy(options.policy);
    this.guardrails = new Guardrails(this.policy);
    this.now = options.clock ?? (() => Date.now());
    this.journal = options.journal ?? new SessionJournal();
    this.history = options.history;
    this.coach = new Coach({
      apiKey: options.apiKey,
      // Built lazily and cached inside, so the days before today are assembled
      // once rather than on every call.
      history: () => this.history?.build(this.now()) ?? '',
    });
    this.thread = new CoachThread({
      coach: this.coach,
      snapshot: () => this.snapshot(),
      // What the coach is told is currently true is what the status line says
      // is currently true. Deriving it twice is how the panel and the prose
      // come to describe different sessions.
      findings: () => this.tracker.active().map((entry) => entry.finding),
      market: (maxAgeMs) => this.marketContext(maxAgeMs),
      clock: this.now,
      log: options.coachLog,
    });
  }

  /**
   * Puts the conversation and the record on disk.
   *
   * Separate from the constructor because the guard is built before anything
   * knows where the operator's files are -- it has to be able to record from
   * the very first fill -- and because a test that constructs one must not
   * thereby start writing to a home directory.
   */
  usePersistence(options: { coachLog?: CoachLog; history?: SessionHistory } = {}): void {
    if (options.history) this.history = options.history;
    if (options.coachLog) this.thread.useLog(options.coachLog);
  }

  /**
   * Picks up today's journal and the days before it, so a restart continues the
   * session and a new session continues the week.
   *
   * Separate from the constructor because it touches the filesystem, and an
   * object that reads disk to exist cannot be made in a test without one. Which
   * is also why the transcript and the history are installed here rather than
   * there: they are the same kind of dependency and they have the same reason
   * to be absent.
   */
  load(): void {
    this.journal.load(this.now());

    if (!this.history) this.history = new SessionHistory();
    const log = new CoachLog();
    this.thread.useLog(log);
    // The panel comes back with the morning's conversation in it. A restart at
    // lunchtime should not present an empty thread as though nothing had been
    // said, when every other region on screen has continuity.
    this.thread.restore(this.now());
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

  /**
   * Hands the coach a key found in the profile.
   *
   * Separate from the constructor for the same reason `load` is: this object is
   * built before anything has been read from disk, because it must be able to
   * journal the first fill of the session.
   */
  setApiKey(key: string | undefined): void {
    this.coach.useKey(key);
  }

  coachKeySource(): KeySource {
    return this.coach.keySource();
  }

  /**
   * Where the market comes from.
   *
   * Injected rather than imported: this file does not know what an exchange is,
   * and the one thing that would break that is reaching for a price itself.
   */
  setMarketSource(source: (() => Promise<MarketContext | undefined>) | undefined): void {
    this.marketSource = source;
  }

  /**
   * The market as the coach should see it, no older than `maxAgeMs`.
   *
   * A stale reading is refreshed in the background and the stale one returned,
   * rather than the caller waiting: every caller here has a canned fallback and
   * none of them is worth a stalled panel. `maxAgeMs` of zero forces the wait,
   * which is what a typed question deserves.
   */
  private async marketContext(maxAgeMs: number): Promise<MarketContext | undefined> {
    if (!this.marketSource) return undefined;

    const cached = this.market;
    const fresh = cached !== undefined && this.now() - cached.at <= maxAgeMs;
    if (fresh) return cached.context;

    if (cached !== undefined && maxAgeMs > 0) {
      void this.refreshMarket();
      return cached.context;
    }

    await this.refreshMarket();
    return this.market?.context;
  }

  /** Reads the market and keeps it. Never throws; a failure leaves the last one. */
  async refreshMarket(): Promise<void> {
    if (!this.marketSource || this.marketRefreshInFlight) return;

    this.marketRefreshInFlight = true;
    try {
      const context = await this.marketSource();
      if (context) this.market = { at: this.now(), context };
    } catch {
      // The previous reading stands. A coach shown a market from thirty seconds
      // ago is in a better position than one shown none.
    } finally {
      this.marketRefreshInFlight = false;
    }
  }

  snapshot(): SessionSnapshot {
    return this.journal.snapshot(this.now(), this.currency);
  }

  // --- recording ----------------------------------------------------------

  recordFill(fill: Omit<FillEvent, 'type' | 'at'> & { at?: number }): void {
    this.journal.record({ type: 'fill', at: fill.at ?? this.now(), ...fill });
  }

  recordOrderPlaced(
    market: string,
    orderId?: string,
    options: { description?: string; reconstructed?: boolean; at?: number } = {}
  ): void {
    this.journal.record({
      type: 'order-placed',
      at: options.at ?? this.now(),
      market,
      orderId,
      description: options.description,
      reconstructed: options.reconstructed,
    });
  }

  /**
   * What the exchange says, alongside what this journal derived.
   *
   * Recorded rather than corrected. The gap between the two is itself the
   * finding -- it means fills happened that nothing here was told about -- and
   * closing it by inventing the fills that would explain it would make the
   * arithmetic agree at the cost of the record being true.
   */
  recordReconciliation(
    market: string,
    observed: ReconciliationEvent['observed'],
    derived: ReconciliationEvent['derived'],
    at?: number
  ): void {
    this.journal.record({
      type: 'reconciliation',
      at: at ?? this.now(),
      market,
      observed,
      derived,
    });
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

  /** The last equity written, and the extremes seen, so repeats can be dropped. */
  private equityMark: { at: number; equity: number; peak: number; trough: number } | undefined;

  /** A move worth a line, as a fraction of equity. */
  private static readonly EQUITY_STEP = 0.001;
  /** How long equity may sit still before it is written down anyway. */
  private static readonly EQUITY_HEARTBEAT_MS = 60_000;

  /**
   * An equity sample, which is what the peak and the give-back are measured
   * from.
   *
   * Was written on every refresh, on the reasoning that a line is cheap and a
   * true peak is worth having. The line is cheap; two thousand of them a day
   * are not, once the record is something that gets read back -- a day of
   * trading came to a hundred and seventy kilobytes, of which ninety-eight per
   * cent was the same number written down again.
   *
   * So the peak is still exact and the rest is thinned. Every new extreme is
   * written, because that is the figure that must not be missed; between
   * extremes a sample earns its line by moving materially or by a minute having
   * passed. What is lost is only resolution on a flat stretch, which is the one
   * stretch nothing needs resolution on.
   */
  recordEquity(equity: number, currency: string): void {
    if (!Number.isFinite(equity)) return;
    this.currency = currency || this.currency;

    const at = this.now();
    const mark = this.equityMark;

    if (mark) {
      const extreme = equity > mark.peak || equity < mark.trough;
      const moved = Math.abs(equity - mark.equity) >= Math.abs(equity) * GuardService.EQUITY_STEP;
      const stale = at - mark.at >= GuardService.EQUITY_HEARTBEAT_MS;
      if (!extreme && !moved && !stale) return;
    }

    this.equityMark = {
      at,
      equity,
      peak: Math.max(equity, mark?.peak ?? equity),
      trough: Math.min(equity, mark?.trough ?? equity),
    };

    this.journal.record({ type: 'equity', at, equity, currency });
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
  /**
   * A command as typed, before substitution and before anything happened.
   *
   * Recorded even when refused. A rejected command is the clearest evidence
   * there is of what was intended at that moment, and it leaves no other trace
   * at all -- no order, no fill, nothing for a later account to work from.
   */
  recordCommand(text: string, options: { market?: string; accepted?: boolean; error?: string } = {}): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.journal.record({
      type: 'command',
      at: this.now(),
      text: trimmed,
      market: options.market,
      accepted: options.error === undefined && options.accepted !== false,
      error: options.error,
    });
  }

  recordOrderAmended(
    market: string,
    field: 'price' | 'trigger' | 'quantity',
    by: 'chase' | 'trail' | 'operator',
    from: number | undefined,
    to: number | undefined,
    orderId?: string
  ): void {
    this.journal.record({ type: 'order-amended', at: this.now(), market, orderId, field, by, from, to });
  }

  /** The moment a delayed trail stopped being a fixed stop. */
  recordTrailArmed(market: string, armPrice: number, trigger: number, orderId?: string): void {
    this.journal.record({ type: 'trail-armed', at: this.now(), market, orderId, armPrice, trigger });
  }

  recordExitPlanned(
    market: string,
    urgency: string,
    slices: number,
    quantity: number,
    description?: string
  ): void {
    this.journal.record({
      type: 'exit-planned',
      at: this.now(),
      market,
      urgency,
      slices,
      quantity,
      description,
    });
  }

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

    // Whatever market reading is already to hand, up to a minute old. The panel
    // cannot wait for a fresh one and the numbers that matter here -- ATR, the
    // day's range, where the stop sits -- do not turn over in a minute.
    const market = await this.marketContext(60_000);

    const written = await Promise.race([
      this.coach.speakTo(finding, this.snapshot(), market),
      new Promise<undefined>((resolve) => setTimeout(resolve, budgetMs)),
    ]).catch(() => undefined);

    return written ?? finding.detail;
  }

  async debrief(findings: Finding[] = []): Promise<string | undefined> {
    return this.coach.debrief(this.snapshot(), findings, await this.marketContext(0));
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

    // Naming the source matters: an exported key and a stored one behave
    // identically until they disagree, and 'rejected' is a different problem
    // from 'never set' that entering another key will not always fix.
    const source = this.coach.keySource();
    lines.push(
      this.coach.available()
        ? `Coach: available (key from ${source === 'profile' ? 'your profile' : 'ANTHROPIC_API_KEY'})`
        : source === 'rejected'
        ? 'Coach: off — the key was rejected. Enter another from the home menu.'
        : "Coach: off — add a key under 'AI Coach Key' on the home menu."
    );

    return lines;
  }
}

export type { Finding, GuardVerdict, Intervention, SweepResult };
export type { Transition } from './findingTracker.js';
export type { CoachEntry } from './coachThread.js';
