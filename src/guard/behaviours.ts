// src/guard/behaviours.ts
//
// The catalogue of ways a trading session goes wrong.
//
// Every guardrail in Tame names one of these and nothing else. The point of a
// closed list is that a flag can be argued with: an operator who sees
// 'size-escalation' can look up exactly what was measured and decide the guard
// is wrong, which is not possible when the software just says 'this looks
// risky'. It also means the coach has a fixed vocabulary rather than inventing
// a new diagnosis every session.
//
// Nothing here reads a price or a clock. This file is the definitions; the
// measuring is in detectors.ts and the deciding is in guardrails.ts.

/** Roughly why the behaviour hurts, which decides how it is spoken about. */
export type BehaviourGroup =
  /** The account is being traded by the last loss rather than by a plan. */
  | 'tilt'
  /** The position could hurt more than intended, whatever the reason. */
  | 'risk'
  /** The session as a whole has gone past what was agreed with yourself. */
  | 'discipline';

/**
 * What a flag does.
 *
 *   notice  say it, change nothing
 *   hold    put the order in front of the operator before sending it
 *   block   refuse to send it at all
 *
 * Only limits the operator has explicitly set ever reach 'block'. A guard that
 * decides on its own to stop someone trading is a guard that gets switched off,
 * and a switched-off guard protects nobody.
 */
export type Severity = 'notice' | 'hold' | 'block';

const RANK: Record<Severity, number> = { notice: 0, hold: 1, block: 2 };

/** The stronger of two severities, for combining findings. */
export const strongest = (a: Severity, b: Severity): Severity =>
  RANK[a] >= RANK[b] ? a : b;

export const atLeast = (value: Severity, floor: Severity): boolean =>
  RANK[value] >= RANK[floor];

export type BehaviourId =
  // --- tilt ---------------------------------------------------------------
  | 'revenge-entry'
  | 'rapid-fire'
  | 'size-escalation'
  | 'averaging-down'
  | 'chasing'
  | 'direction-flipping'
  | 'order-churn'
  // --- risk ---------------------------------------------------------------
  | 'no-stop'
  | 'stop-widened'
  | 'stop-removed'
  | 'risk-per-trade'
  | 'leverage-creep'
  // --- discipline ---------------------------------------------------------
  | 'daily-loss-limit'
  | 'loss-streak'
  | 'overtrading'
  | 'profit-giveback'
  | 'session-length';

export interface Behaviour {
  id: BehaviourId;
  group: BehaviourGroup;
  /** Three or four words, for a log line that has to fit in a column. */
  title: string;
  /**
   * What the guard is actually claiming, in one sentence.
   *
   * Written as an observation rather than an accusation. 'You are on tilt' is
   * not checkable and invites an argument; 'the third entry in six minutes,
   * each one bigger' is a fact the operator can confirm at a glance and either
   * accept or dismiss.
   */
  claim: string;
  /** Why it costs money. Shown by `guard explain <id>`. */
  why: string;
  defaultSeverity: Severity;
}

/**
 * Severities are deliberately conservative here.
 *
 * A first iteration that holds too often trains the reflex of confirming
 * without reading, which is worse than not holding at all -- the same reason
 * the confirmation threshold is a value and not every order. So only the
 * patterns that reliably precede a bad decision hold; the rest speak up and get
 * out of the way, and the operator can raise any of them in their profile.
 */
export const BEHAVIOURS: Record<BehaviourId, Behaviour> = {
  'revenge-entry': {
    id: 'revenge-entry',
    group: 'tilt',
    title: 'Revenge entry',
    claim: 'This entry follows a loss too closely to be a considered one.',
    why:
      'The trade that follows a loss within a few minutes is usually the loss ' +
      'being argued with rather than a setup being taken. It is the single ' +
      'most reliable precursor to a session that ends badly.',
    defaultSeverity: 'hold',
  },
  'rapid-fire': {
    id: 'rapid-fire',
    group: 'tilt',
    title: 'Rapid-fire entries',
    claim: 'Entries are arriving far faster than they have all session.',
    why:
      'Frequency climbing without the market changing means the decisions are ' +
      'getting cheaper to make, not that more opportunities appeared. Costs ' +
      'compound at exactly the moment judgement is thinning.',
    defaultSeverity: 'hold',
  },
  'size-escalation': {
    id: 'size-escalation',
    group: 'tilt',
    title: 'Size escalating',
    claim: 'Size is climbing while the session is losing.',
    why:
      'Betting bigger to win back what was lost is the mechanism by which a bad ' +
      'day becomes an unrecoverable one. The size that gets you even is the ' +
      'size that ends the account.',
    defaultSeverity: 'hold',
  },
  'averaging-down': {
    id: 'averaging-down',
    group: 'tilt',
    title: 'Adding to a loser',
    claim: 'This adds to a position that is currently underwater.',
    why:
      'Averaging down improves the entry price and worsens everything else: the ' +
      'position gets larger exactly as the thesis gets weaker, and the stop that ' +
      'covered the original size no longer covers the new one.',
    defaultSeverity: 'hold',
  },
  chasing: {
    id: 'chasing',
    group: 'tilt',
    title: 'Chasing the move',
    claim: 'Price has already run in this direction; this entry is late into it.',
    why:
      'Entering after the move means paying the part of the range that already ' +
      'happened and standing where the stop has to be far away. The reward is ' +
      'smaller and the risk is larger than the same idea taken earlier.',
    defaultSeverity: 'notice',
  },
  'direction-flipping': {
    id: 'direction-flipping',
    group: 'tilt',
    title: 'Flipping direction',
    claim: 'Direction has reversed repeatedly in a short window.',
    why:
      'Reversing repeatedly means the market is setting the opinion rather than ' +
      'the other way round. Each flip pays the spread to arrive at a view that ' +
      'the next candle will change again.',
    defaultSeverity: 'hold',
  },
  'order-churn': {
    id: 'order-churn',
    group: 'tilt',
    title: 'Order churn',
    claim: 'Many orders placed and pulled without much being filled.',
    why:
      'Placing and cancelling without executing is hesitation showing up as ' +
      'activity. It is worth naming because it feels like work and produces ' +
      'nothing but a worse frame of mind for the next real decision.',
    defaultSeverity: 'notice',
  },

  'no-stop': {
    id: 'no-stop',
    group: 'risk',
    title: 'Position without a stop',
    claim: 'An open position has had no protective stop for some time.',
    why:
      'An unprotected position has no defined loss, which means the exit will be ' +
      'chosen under pressure by whoever you are when it is going badly. That is ' +
      'the one decision nobody makes well.',
    defaultSeverity: 'hold',
  },
  'stop-widened': {
    id: 'stop-widened',
    group: 'risk',
    title: 'Stop moved away',
    claim: 'A protective stop was moved further from entry, not closer.',
    why:
      'Widening a stop converts a loss you had accepted into one you have not. ' +
      'It is the cheapest possible action in the moment and the most expensive ' +
      'over a career.',
    defaultSeverity: 'hold',
  },
  'stop-removed': {
    id: 'stop-removed',
    group: 'risk',
    title: 'Stop cancelled',
    claim: 'A protective stop was cancelled while the position is still open.',
    why:
      'Cancelling protection on a position that is already losing removes the ' +
      'only pre-committed decision in the trade, at the moment that commitment ' +
      'is worth the most.',
    defaultSeverity: 'hold',
  },
  'risk-per-trade': {
    id: 'risk-per-trade',
    group: 'risk',
    title: 'Risk per trade',
    claim: 'Planned downside on this position is above your per-trade limit.',
    why:
      'Position size is the only input you fully control. A limit that holds ' +
      'means no single trade can decide the month, whatever the trade does.',
    defaultSeverity: 'hold',
  },
  'leverage-creep': {
    id: 'leverage-creep',
    group: 'risk',
    title: 'Leverage',
    claim: 'Position notional is large relative to account equity.',
    why:
      'Leverage does not change the odds, only how little has to go wrong before ' +
      'the decision is taken out of your hands by a liquidation engine.',
    defaultSeverity: 'notice',
  },

  'daily-loss-limit': {
    id: 'daily-loss-limit',
    group: 'discipline',
    title: 'Daily loss limit',
    claim: 'Realized losses this session have reached the limit you set.',
    why:
      'The limit was set when you were thinking clearly about a day like this ' +
      'one. Its whole value is that it is not renegotiated by the person who ' +
      'has just hit it.',
    defaultSeverity: 'block',
  },
  'loss-streak': {
    id: 'loss-streak',
    group: 'discipline',
    title: 'Losing streak',
    claim: 'Several trades in a row have lost.',
    why:
      'A streak is either the market being unreadable right now or you reading ' +
      'it wrong right now. Both are answered by stopping, and neither is ' +
      'answered by the next trade.',
    defaultSeverity: 'hold',
  },
  overtrading: {
    id: 'overtrading',
    group: 'discipline',
    title: 'Trade count',
    claim: 'This session has more trades in it than you allow for.',
    why:
      'Past a certain count the trades stop being selected and start being ' +
      'taken. Fees and spread are charged on all of them at the same rate.',
    defaultSeverity: 'notice',
  },
  'profit-giveback': {
    id: 'profit-giveback',
    group: 'discipline',
    title: 'Giving back profit',
    claim: 'Equity has fallen a long way from where it peaked this session.',
    why:
      'Handing back a green day is a different failure from having a red one, ' +
      'and it is invisible without a peak to measure against -- which is why it ' +
      'is measured here rather than left to memory.',
    defaultSeverity: 'hold',
  },
  'session-length': {
    id: 'session-length',
    group: 'discipline',
    title: 'Long session',
    claim: 'You have been trading for a long stretch without a break.',
    why:
      'Decision quality falls with time at the screen long before it feels like ' +
      'it does. The trades that end long sessions are rarely the ones that ' +
      'justified sitting through them.',
    defaultSeverity: 'notice',
  },
};

export const ALL_BEHAVIOUR_IDS = Object.keys(BEHAVIOURS) as BehaviourId[];

/** Whether a string names a behaviour, for parsing operator input. */
export const isBehaviourId = (value: string): value is BehaviourId =>
  Object.prototype.hasOwnProperty.call(BEHAVIOURS, value);
