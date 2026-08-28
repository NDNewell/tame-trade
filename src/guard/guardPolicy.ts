// src/guard/guardPolicy.ts
//
// The numbers the guardrails measure against, and where they come from.
//
// Every threshold is here rather than buried in the detector that uses it, so
// that 'why did it flag that' is answered by one file the operator can read.
// The defaults are meant to be argued with -- they are a starting position, not
// a claim about how anyone should trade -- and every one of them can be
// overridden per profile.
//
// Two rules hold throughout:
//
//   Nothing here can obstruct an exit or a protective order. A guard that can
//   trap someone in a position is more dangerous than the behaviour it is
//   guarding against.
//
//   Limits that block are only ever limits the operator set themselves. The
//   defaults below never block on their own.

import { BehaviourId, Severity } from './behaviours.js';

export interface GuardPolicy {
  /** The whole system, off in one place. */
  enabled: boolean;

  // --- tilt ---------------------------------------------------------------
  /** An entry this soon after a losing exit is a revenge entry. */
  revengeWindowMs: number;
  /**
   * Losses smaller than this don't arm the revenge window.
   *
   * Without a floor, scratching out of a trade for a few cents counts as a loss
   * and the next legitimate setup gets held. Expressed in the quote currency.
   */
  revengeMinLoss: number;
  /** Window over which entries are counted for rapid-fire. */
  rapidFireWindowMs: number;
  /** Entries within that window before it is called rapid-fire. */
  rapidFireCount: number;
  /**
   * Size counts as escalating at this multiple of the session's typical entry.
   *
   * Measured against the median rather than the mean: one deliberately large
   * trade early on should not raise the bar for the rest of the day.
   */
  sizeEscalationFactor: number;
  /** Escalation only matters while losing; this is how far down counts. */
  sizeEscalationMinLoss: number;
  /** A move of this much, this fast, makes a same-direction entry a chase. */
  chaseMovePercent: number;
  chaseWindowMs: number;
  /** Direction changes within the flip window before it is called flipping. */
  flipWindowMs: number;
  flipCount: number;
  /**
   * How far back an event still counts as 'just now'.
   *
   * Used by the checks that react to something that happened rather than to
   * something being proposed -- a stop widened, a stop pulled. Those have no
   * order to attach to, so they need a window or they would be reported once
   * per sweep forever.
   */
  recentEventWindowMs: number;
  /** Cancels per fill above which the session is churning. */
  churnRatio: number;
  /** Below this many orders the ratio is noise, so it isn't computed. */
  churnMinOrders: number;

  // --- risk ---------------------------------------------------------------
  /** How long a position may sit unprotected before it is called out. */
  stopGraceMs: number;
  /** Planned downside ceiling for one position, as a percent of equity. */
  maxRiskPercentOfEquity: number;
  /** Notional-to-equity above which leverage is called out. */
  maxLeverage: number;

  // --- discipline ---------------------------------------------------------
  /**
   * Realized loss for the session at which new entries stop. Undefined means
   * no limit, which is the default: this is the one number that blocks, so it
   * only ever exists because the operator typed it.
   */
  dailyLossLimit: number | undefined;
  maxConsecutiveLosses: number;
  maxTradesPerSession: number;
  /** Fall from session peak equity, as a percent of the peak's profit. */
  givebackPercent: number;
  maxSessionMs: number;

  /** How long a lockout lasts when one is triggered by a streak or a limit. */
  lockoutMs: number;
  /**
   * Behaviours that may close a position on your behalf.
   *
   * Empty by default, and that default is load-bearing. Everything else here
   * decides whether an order you typed gets sent; this decides whether an order
   * you did not type gets sent, which is a different kind of power and is not
   * one software should award itself. With a behaviour listed, Tame works the
   * position out under `planExit`; without it, the same situation produces a
   * worked-out plan and an offer to run it.
   */
  autoExit: BehaviourId[];

  /**
   * Whether the coach may speak without being asked.
   *
   * Off. Every unprompted remark is a model call the operator did not ask for
   * and is paying for, and a guardrail that flaps around its threshold can
   * make several of them in a quarter of an hour. The condition is already on
   * the status line and in the activity log; the coach adding a sentence about
   * it is the one part of that which costs money.
   *
   * The panel still answers anything typed into it, and the confirmation
   * sentence still explains a held order -- that one is a reply to something
   * the operator just did.
   */
  coachRemarks: boolean;

  /**
   * Per-behaviour overrides of the catalogue's default severity.
   *
   * This is how an operator turns the whole thing into a coach that never
   * interrupts ('notice' everywhere) or a hard cage ('block' on the ones they
   * know they break). Both are legitimate; neither is the default.
   */
  severity: Partial<Record<BehaviourId, Severity>>;

  /** Behaviours switched off entirely. */
  muted: BehaviourId[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_POLICY: GuardPolicy = {
  enabled: true,

  revengeWindowMs: 5 * MINUTE,
  revengeMinLoss: 0,
  rapidFireWindowMs: 10 * MINUTE,
  rapidFireCount: 4,
  sizeEscalationFactor: 1.75,
  sizeEscalationMinLoss: 0,
  chaseMovePercent: 1.5,
  chaseWindowMs: 5 * MINUTE,
  recentEventWindowMs: 10 * MINUTE,
  flipWindowMs: 15 * MINUTE,
  flipCount: 3,
  churnRatio: 4,
  churnMinOrders: 8,

  stopGraceMs: 3 * MINUTE,
  maxRiskPercentOfEquity: 1,
  maxLeverage: 10,

  dailyLossLimit: undefined,
  maxConsecutiveLosses: 3,
  maxTradesPerSession: 20,
  givebackPercent: 40,
  maxSessionMs: 4 * HOUR,

  lockoutMs: 30 * MINUTE,
  autoExit: [],
  coachRemarks: false,
  severity: {},
  muted: [],
};

/**
 * What a behaviour does under this policy.
 *
 * A muted behaviour is not resolved to a severity at all -- the caller drops it
 * before it becomes a finding, so a muted flag cannot be raised back into view
 * by some later combination rule.
 */
export function severityFor(
  policy: GuardPolicy,
  id: BehaviourId,
  fallback: Severity
): Severity {
  return policy.severity[id] ?? fallback;
}

export const isMuted = (policy: GuardPolicy, id: BehaviourId): boolean =>
  policy.muted.includes(id);

/**
 * Fills in anything missing from a stored policy.
 *
 * A config written by an older version has fewer keys than this one, and a
 * missing key must mean 'use the default' rather than 'undefined', or a
 * threshold comparison silently becomes false and the guard disappears without
 * saying so.
 */
export function resolvePolicy(stored: Partial<GuardPolicy> | undefined): GuardPolicy {
  const merged: GuardPolicy = { ...DEFAULT_POLICY, ...(stored ?? {}) };

  // Objects and arrays are replaced wholesale by the spread, which is what we
  // want -- but a stored null or a wrong type would survive it.
  merged.severity =
    stored?.severity && typeof stored.severity === 'object' ? stored.severity : {};
  merged.muted = Array.isArray(stored?.muted) ? stored!.muted : [];
  merged.autoExit = Array.isArray(stored?.autoExit) ? stored!.autoExit : [];
  merged.coachRemarks = stored?.coachRemarks === true;

  // A threshold stored as a non-number would compare false against everything
  // and quietly disable its detector.
  for (const [key, value] of Object.entries(merged) as Array<[keyof GuardPolicy, unknown]>) {
    const fallback = DEFAULT_POLICY[key];
    if (typeof fallback === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      (merged as any)[key] = fallback;
    }
  }

  // The one exception: dailyLossLimit is legitimately undefined, and defaults
  // to undefined, so the loop above leaves it alone. Guard the other way --
  // anything stored that isn't a usable positive number means 'not set'.
  const limit = merged.dailyLossLimit;
  merged.dailyLossLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;

  merged.enabled = merged.enabled !== false;

  return merged;
}
