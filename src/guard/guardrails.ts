// src/guard/guardrails.ts
//
// Where measurements become decisions.
//
// The detectors say what is true; this decides what happens about it. The two
// are separate files on purpose: an operator who disagrees with an intervention
// is nearly always disagreeing with the response, not the observation, and the
// response should be adjustable without touching the thing that does the
// measuring.
//
// Three rules hold above everything else in this file.
//
//   Exits and protective orders are never obstructed. Not held, not blocked,
//   not delayed. A guard that can prevent someone closing a position or placing
//   a stop is a guard that will one day cost far more than every bad entry it
//   ever stopped. This is the same reasoning that exempts position-derived
//   sizes from the fatfinger limit, and it is not negotiable by config.
//
//   Only limits the operator set can refuse an order. The catalogue's defaults
//   observe and hold; nothing in the shipped configuration blocks. A guard that
//   surprises someone by refusing is a guard that gets turned off that evening.
//
//   Nothing closes a position unless it was explicitly asked to. A recommended
//   exit is the default; an executed one requires the behaviour to be named in
//   `autoExit`. Deciding to act on someone's money is a different power from
//   deciding to question their typing.

import {
  BEHAVIOURS,
  Behaviour,
  BehaviourId,
  Severity,
  atLeast,
  strongest,
} from './behaviours.js';
import { GuardPolicy, isMuted, severityFor } from './guardPolicy.js';
import {
  DETECTORS,
  GuardContext,
  OrderProposal,
  Observation,
  PositionContext,
  PriceMove,
} from './detectors.js';
import { ExitUrgency } from '../trading/exitPlan.js';
import { SessionSnapshot } from './sessionJournal.js';

export interface Finding {
  behaviour: Behaviour;
  severity: Severity;
  detail: string;
  evidence: Record<string, string | number>;
}

export type GuardAction =
  /** Send it. */
  | 'allow'
  /** Put it in front of the operator first. */
  | 'confirm'
  /** Do not send it. */
  | 'refuse';

export interface GuardVerdict {
  action: GuardAction;
  findings: Finding[];
  /** One line for the confirmation panel or the rejection. */
  headline: string;
  /** Set when the refusal is a lockout rather than a single rule. */
  lockedUntil?: number;
}

/** Something the guard wants done, as opposed to something it wants said. */
export type Intervention =
  | {
      type: 'lockout';
      until: number;
      behaviour: BehaviourId;
      reason: string;
    }
  | {
      type: 'assisted-exit';
      market: string;
      urgency: ExitUrgency;
      behaviour: BehaviourId;
      reason: string;
      /**
       * False when the operator has not authorised this behaviour to act, in
       * which case the caller works out the plan, shows it, and waits.
       */
      authorised: boolean;
    };

export interface SweepResult {
  findings: Finding[];
  interventions: Intervention[];
}

export interface ReviewInput {
  now: number;
  snapshot: SessionSnapshot;
  proposal: OrderProposal;
  position?: PositionContext;
  priceMove?: PriceMove;
  equity?: number;
  currency?: string;
}

export interface SweepInput {
  now: number;
  snapshot: SessionSnapshot;
  positions: PositionContext[];
  equity?: number;
  currency?: string;
}

/**
 * Runs every detector and resolves what each one found into a severity.
 *
 * Muted behaviours are dropped here rather than filtered later, so there is no
 * path by which a muted flag can be combined back into a decision.
 */
function collect(policy: GuardPolicy, context: GuardContext): Finding[] {
  const findings: Finding[] = [];

  for (const detect of DETECTORS) {
    let observation: Observation | undefined;
    try {
      observation = detect(context);
    } catch {
      // A detector that throws must not take the order down with it. The guard
      // is advisory machinery wrapped around the thing that actually matters,
      // and it fails quiet rather than loud.
      continue;
    }

    if (!observation) continue;
    if (isMuted(policy, observation.id)) continue;

    const behaviour = BEHAVIOURS[observation.id];
    findings.push({
      behaviour,
      severity: severityFor(policy, observation.id, behaviour.defaultSeverity),
      detail: observation.detail,
      evidence: observation.evidence,
    });
  }

  return findings;
}

const RANKED: Record<Severity, number> = { notice: 0, hold: 1, block: 2 };

const worst = (findings: Finding[]): Severity =>
  findings.reduce<Severity>((carried, finding) => strongest(carried, finding.severity), 'notice');

/**
 * How urgently a position should be left, given why we are leaving it.
 *
 * Being down against a limit is a live and worsening reason, so it is worked
 * quickly. Having traded too much today is true but not accelerating, so there
 * is no case for paying the spread to act on it a minute sooner.
 */
/**
 * Behaviours for which leaving the position is a coherent response.
 *
 * Not every serious finding is one. Having traded thirty times today is a
 * reason to stop trading; it is not a reason to close a position that may be
 * perfectly well placed, and a guard that conflated the two would be closing
 * winners as a punishment for the day's trade count. The test is whether the
 * open position is itself part of what the finding is about.
 */
const EXIT_WORTHY: BehaviourId[] = [
  // The position is the thing bleeding.
  'daily-loss-limit',
  'profit-giveback',
  // The position is the thing that is wrong.
  'no-stop',
  'risk-per-trade',
  'leverage-creep',
];

function urgencyFor(id: BehaviourId, position: PositionContext | undefined): ExitUrgency {
  if (id === 'daily-loss-limit') {
    // Unprotected and past the day's limit is the one case where the position
    // can keep taking money while the plan works. Nothing patient about it.
    return position && !position.hasProtectiveStop ? 'immediate' : 'firm';
  }
  if (id === 'no-stop') return 'firm';
  if (id === 'risk-per-trade' || id === 'leverage-creep') return 'firm';
  return 'measured';
}

export class Guardrails {
  constructor(private policy: GuardPolicy) {}

  setPolicy(policy: GuardPolicy): void {
    this.policy = policy;
  }

  getPolicy(): GuardPolicy {
    return this.policy;
  }

  /**
   * What should happen to an order that has not been sent yet.
   *
   * Returns 'allow' for anything it cannot reason about. Silence is the correct
   * output of a guard that does not know -- the alternative is holding orders
   * because a price feed was slow.
   */
  review(input: ReviewInput): GuardVerdict {
    const allow = (): GuardVerdict => ({ action: 'allow', findings: [], headline: '' });

    if (!this.policy.enabled) return allow();

    // Rule one. An order that reduces a position or protects one goes through
    // untouched, whatever the session looks like.
    if (input.proposal.intent !== 'entry') return allow();

    const context: GuardContext = {
      now: input.now,
      policy: this.policy,
      snapshot: input.snapshot,
      proposal: input.proposal,
      position: input.position,
      priceMove: input.priceMove,
      equity: input.equity,
      currency: input.currency,
    };

    const findings = collect(this.policy, context);

    // A lockout already in force refuses before any of this session's findings
    // are weighed: it was decided earlier, deliberately, and re-deciding it now
    // is precisely what it exists to prevent.
    const lockout = input.snapshot.lockout;
    if (lockout) {
      const left = Math.max(0, lockout.until - input.now);
      return {
        action: 'refuse',
        findings,
        headline:
          `Entries are stopped for another ${Math.ceil(left / 60_000)} minutes: ${lockout.reason} ` +
          `Closing and protective orders still work.`,
        lockedUntil: lockout.until,
      };
    }

    if (findings.length === 0) return allow();

    const severity = worst(findings);
    const leading = [...findings].sort(
      (a, b) => RANKED[b.severity] - RANKED[a.severity]
    )[0];

    if (severity === 'notice') {
      // Worth saying, not worth stopping for. The caller logs these.
      return { action: 'allow', findings, headline: leading.detail };
    }

    const others =
      findings.length > 1 ? ` (+${findings.length - 1} more)` : '';

    return {
      action: severity === 'block' ? 'refuse' : 'confirm',
      findings,
      headline: `${leading.behaviour.title}: ${leading.detail}${others}`,
    };
  }

  /**
   * The periodic pass, for things no order is being placed about.
   *
   * A position sitting unprotected, a stop that was widened ten minutes ago, a
   * day that has quietly given back its profit -- none of these announce
   * themselves at an order, so something has to go looking.
   */
  sweep(input: SweepInput): SweepResult {
    if (!this.policy.enabled) return { findings: [], interventions: [] };

    // Keyed by string rather than by behaviour id: position findings are keyed
    // by behaviour *and* market, since two unprotected positions are two
    // separate problems and must both be reported.
    const seen = new Set<string>();
    const findings: Finding[] = [];

    // Session-wide checks need to run once, not once per position, or a day
    // with three open positions reports its loss limit three times.
    const sessionContext: GuardContext = {
      now: input.now,
      policy: this.policy,
      snapshot: input.snapshot,
      equity: input.equity,
      currency: input.currency,
    };

    for (const finding of collect(this.policy, sessionContext)) {
      if (seen.has(finding.behaviour.id)) continue;
      seen.add(finding.behaviour.id);
      findings.push(finding);
    }

    const perPosition = new Map<BehaviourId, PositionContext>();

    for (const position of input.positions) {
      const context: GuardContext = { ...sessionContext, position };
      for (const finding of collect(this.policy, context)) {
        // Anything the session pass already found is session-wide: it fired
        // without a position in context, so it is about the day rather than
        // about this instrument. Reporting it again for every open position is
        // how one losing streak becomes three warnings about the same streak.
        if (seen.has(finding.behaviour.id)) continue;

        // What is left is position-specific, and is keyed by behaviour *and*
        // market -- two unprotected positions are two separate problems and
        // both have to be reported.
        const key = `${finding.behaviour.id}:${position.market}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding);
        if (!perPosition.has(finding.behaviour.id)) {
          perPosition.set(finding.behaviour.id, position);
        }
      }
    }

    return {
      findings,
      interventions: this.interventionsFor(findings, perPosition, input),
    };
  }

  /**
   * Which findings warrant doing something rather than saying something.
   *
   * Only findings the operator has raised to 'block' get here. The shipped
   * defaults reach 'hold' at most, so a fresh install never locks anyone out
   * and never touches a position.
   */
  private interventionsFor(
    findings: Finding[],
    positions: Map<BehaviourId, PositionContext>,
    input: SweepInput
  ): Intervention[] {
    const interventions: Intervention[] = [];

    for (const finding of findings) {
      if (!atLeast(finding.severity, 'block')) continue;
      const id = finding.behaviour.id;

      // Already stopped. Re-triggering would extend the lockout every sweep,
      // which turns a thirty-minute pause into an indefinite one by accident.
      if (finding.behaviour.group === 'discipline' && !input.snapshot.lockout) {
        interventions.push({
          type: 'lockout',
          until: input.now + this.policy.lockoutMs,
          behaviour: id,
          reason: finding.detail,
        });
      }

      if (!EXIT_WORTHY.includes(id)) continue;

      // A position-specific finding names its own position. A session-wide one
      // -- past the day's limit, handing back the day's profit -- is about
      // every position that is open, because the response to it is to be flat.
      const affected = positions.has(id)
        ? [positions.get(id)!]
        : input.positions;

      for (const position of affected) {
        if (!position || !(position.size > 0)) continue;

        interventions.push({
          type: 'assisted-exit',
          market: position.market,
          urgency: urgencyFor(id, position),
          behaviour: id,
          reason: finding.detail,
          authorised: this.policy.autoExit.includes(id),
        });
      }
    }

    return interventions;
  }
}
