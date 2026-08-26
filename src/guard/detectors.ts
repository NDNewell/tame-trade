// src/guard/detectors.ts
//
// The measurements behind every flag.
//
// Each detector answers one question about the session, takes the same context,
// and returns either nothing or a statement of fact. They are pure -- no clock,
// no exchange, no config lookups -- because a guardrail that fires wrongly
// costs the operator a trade and their trust in the whole feature, and 'it
// seemed right when I watched it live' is not a standard that survives that.
//
// A detector never decides what happens next. It says what it measured; the
// policy decides whether that is a notice, a hold, or a refusal. Keeping those
// apart is what lets an operator turn any single check down without editing the
// logic that finds it.

import { BehaviourId } from './behaviours.js';
import { GuardPolicy } from './guardPolicy.js';
import { Direction, EntryRecord, SessionSnapshot } from './sessionJournal.js';

/** What an order is for. Exits and protection are never obstructed. */
export type OrderIntent = 'entry' | 'exit' | 'protective';

export interface OrderProposal {
  market: string;
  side: 'buy' | 'sell';
  intent: OrderIntent;
  size: number;
  price?: number;
  /** Order value in the quote currency, when it could be worked out. */
  notional?: number;
  currency?: string;
}

/** The position the proposal would affect, as it stands right now. */
export interface PositionContext {
  market: string;
  side: Direction;
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnl?: number;
  /** Position value in the quote currency. */
  notional?: number;
  hasProtectiveStop: boolean;
  /** Planned downside from calculatePositionRisk, where it can be stated. */
  plannedRisk?: number;
  openedAt?: number;
}

/** Recent price action on the proposal's market, for the chase check. */
export interface PriceMove {
  /** Signed percentage change over the window. */
  percent: number;
  overMs: number;
}

export interface GuardContext {
  now: number;
  policy: GuardPolicy;
  snapshot: SessionSnapshot;
  /** Absent on a periodic sweep, where nothing is being proposed. */
  proposal?: OrderProposal;
  position?: PositionContext;
  priceMove?: PriceMove;
  equity?: number;
  currency?: string;
}

/** What a detector produces. The severity is applied later, by policy. */
export interface Observation {
  id: BehaviourId;
  /** One sentence, in the operator's terms, stating what was measured. */
  detail: string;
  /** The raw numbers, for the coach and for arguing with the flag. */
  evidence: Record<string, string | number>;
}

export type Detector = (context: GuardContext) => Observation | undefined;

// --- shared helpers --------------------------------------------------------

const directionOf = (side: 'buy' | 'sell'): Direction =>
  side === 'buy' ? 'long' : 'short';

const minutes = (ms: number): string => {
  const value = ms / 60_000;
  return value < 1 ? `${Math.round(ms / 1000)}s` : `${value.toFixed(value < 10 ? 1 : 0)}m`;
};

const money = (value: number, currency = ''): string =>
  `${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}${currency ? ` ${currency}` : ''}`;

const isEntry = (context: GuardContext): boolean =>
  context.proposal?.intent === 'entry';

/**
 * Entries within a window, newest last.
 *
 * Scoped to one market by default. Two markets traded at once are two separate
 * rhythms, and merging them would call an ordinary pace on each of them
 * rapid-fire across both.
 */
const recentEntries = (
  snapshot: SessionSnapshot,
  now: number,
  windowMs: number,
  market?: string
): EntryRecord[] =>
  snapshot.entries.filter(
    (entry) =>
      now - entry.at <= windowMs && (market === undefined || entry.market === market)
  );

/**
 * The middle value, which is what 'your usual size' should mean.
 *
 * A mean is dragged by exactly the outlier this is trying to detect: one large
 * entry raises the average enough that the next large entry looks normal, so
 * escalation hides itself after its first step.
 */
const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// --- tilt ------------------------------------------------------------------

export const revengeEntry: Detector = (context) => {
  const { policy, snapshot, now, proposal } = context;
  if (!isEntry(context) || !proposal) return undefined;

  const loss = snapshot.lastLoss;
  if (!loss) return undefined;

  const since = now - loss.closedAt;
  if (since > policy.revengeWindowMs) return undefined;

  const size = Math.abs(loss.realizedPnl);
  if (size < policy.revengeMinLoss) return undefined;

  // A loss on another instrument still counts. The impulse to make it back
  // does not respect the symbol it was lost on, and in practice the revenge
  // trade often goes somewhere else precisely because the first one 'stopped
  // working'.
  const elsewhere = loss.market !== proposal.market ? ` on ${loss.market.split(':')[0]}` : '';

  return {
    id: 'revenge-entry',
    detail:
      `${minutes(since)} ago you closed a ${money(size, snapshot.currency)} loss${elsewhere}. ` +
      `This is the first entry since.`,
    evidence: {
      sinceMs: since,
      lossAmount: size,
      lossMarket: loss.market,
      windowMs: policy.revengeWindowMs,
    },
  };
};

export const rapidFire: Detector = (context) => {
  const { policy, snapshot, now, proposal } = context;
  if (!isEntry(context) || !proposal) return undefined;

  const recent = recentEntries(snapshot, now, policy.rapidFireWindowMs, proposal.market);
  // The proposal is not a fill yet, so it is counted separately rather than
  // waiting for it to appear in the journal -- the point is to speak before it
  // is sent, not after.
  const total = recent.length + 1;
  if (total < policy.rapidFireCount) return undefined;

  const span = recent.length > 0 ? now - recent[0].at : 0;

  return {
    id: 'rapid-fire',
    detail:
      `This would be entry ${total} on ${proposal.market.split(':')[0]} in ${minutes(
        span || policy.rapidFireWindowMs
      )}.`,
    evidence: {
      entries: total,
      spanMs: span,
      threshold: policy.rapidFireCount,
    },
  };
};

export const sizeEscalation: Detector = (context) => {
  const { policy, snapshot, now, proposal } = context;
  if (!isEntry(context) || !proposal) return undefined;

  // Only while losing. Size growing on a day that is working is a trader
  // pressing an edge, which is the opposite behaviour and not ours to question.
  if (snapshot.realizedPnl > -policy.sizeEscalationMinLoss) return undefined;
  if (snapshot.realizedPnl >= 0) return undefined;

  const priorSizes = snapshot.entries
    .filter((entry) => entry.market === proposal.market)
    .map((entry) => entry.size);

  // Two entries is not a baseline, it is two numbers.
  if (priorSizes.length < 3) return undefined;

  const typical = median(priorSizes);
  if (typical === undefined || !(typical > 0)) return undefined;

  const factor = proposal.size / typical;
  if (factor < policy.sizeEscalationFactor) return undefined;

  return {
    id: 'size-escalation',
    detail:
      `This order is ${factor.toFixed(1)}x your usual size on this market ` +
      `(${typical}), and the session is down ${money(
        Math.abs(snapshot.realizedPnl),
        snapshot.currency
      )}.`,
    evidence: {
      factor: Number(factor.toFixed(2)),
      typicalSize: typical,
      proposedSize: proposal.size,
      realizedPnl: snapshot.realizedPnl,
      sampledEntries: priorSizes.length,
      windowMs: now - snapshot.startedAt,
    },
  };
};

export const averagingDown: Detector = (context) => {
  const { proposal, position } = context;
  if (!isEntry(context) || !proposal || !position) return undefined;
  if (!(position.size > 0)) return undefined;

  // Only adding counts. An order in the other direction reduces the position,
  // which is an exit however it was typed.
  if (position.side !== directionOf(proposal.side)) return undefined;

  const unrealized = position.unrealizedPnl;
  if (unrealized === undefined || unrealized >= 0) return undefined;

  return {
    id: 'averaging-down',
    detail:
      `The ${position.side} on ${position.market.split(':')[0]} is down ` +
      `${money(Math.abs(unrealized), context.currency)}. This adds to it.`,
    evidence: {
      unrealizedPnl: unrealized,
      positionSize: position.size,
      entryPrice: position.entryPrice,
      addingSize: proposal.size,
    },
  };
};

export const chasing: Detector = (context) => {
  const { policy, proposal, priceMove } = context;
  if (!isEntry(context) || !proposal || !priceMove) return undefined;

  const magnitude = Math.abs(priceMove.percent);
  if (magnitude < policy.chaseMovePercent) return undefined;

  // Only a move that already went the way this order is betting. Entering
  // against a sharp move is a different decision -- possibly a worse one, but
  // not this one, and calling it 'chasing' would be plainly wrong.
  const moveDirection: Direction = priceMove.percent > 0 ? 'long' : 'short';
  if (moveDirection !== directionOf(proposal.side)) return undefined;

  return {
    id: 'chasing',
    detail:
      `Price is already ${magnitude.toFixed(2)}% ${
        priceMove.percent > 0 ? 'up' : 'down'
      } over the last ${minutes(priceMove.overMs)}. This entry is into that move.`,
    evidence: {
      movePercent: Number(priceMove.percent.toFixed(3)),
      overMs: priceMove.overMs,
      threshold: policy.chaseMovePercent,
    },
  };
};

export const directionFlipping: Detector = (context) => {
  const { policy, snapshot, now, proposal } = context;
  if (!isEntry(context) || !proposal) return undefined;

  const recent = recentEntries(snapshot, now, policy.flipWindowMs, proposal.market);
  const sequence: Direction[] = [
    ...recent.map((entry) => entry.side),
    directionOf(proposal.side),
  ];

  let changes = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] !== sequence[i - 1]) changes++;
  }

  if (changes < policy.flipCount) return undefined;

  return {
    id: 'direction-flipping',
    detail:
      `Direction has changed ${changes} times on ${proposal.market.split(':')[0]} in ` +
      `${minutes(policy.flipWindowMs)}. This is another reversal.`,
    evidence: {
      changes,
      entries: sequence.length,
      windowMs: policy.flipWindowMs,
      threshold: policy.flipCount,
    },
  };
};

export const orderChurn: Detector = (context) => {
  const { policy, snapshot } = context;
  const { ordersPlaced, ordersCancelled, fills } = snapshot;

  if (ordersPlaced < policy.churnMinOrders) return undefined;

  // Cancels per fill. With no fills at all the ratio is undefined rather than
  // infinite, so the cancel count is used directly -- which is the more
  // striking number anyway.
  const ratio = fills > 0 ? ordersCancelled / fills : ordersCancelled;
  if (ratio < policy.churnRatio) return undefined;

  return {
    id: 'order-churn',
    detail:
      fills > 0
        ? `${ordersCancelled} cancels against ${fills} fills this session.`
        : `${ordersCancelled} orders placed and pulled, none filled.`,
    evidence: {
      ordersPlaced,
      ordersCancelled,
      fills,
      ratio: Number(ratio.toFixed(2)),
    },
  };
};

// --- risk ------------------------------------------------------------------

export const noStop: Detector = (context) => {
  const { policy, position, now } = context;
  if (!position || !(position.size > 0) || position.hasProtectiveStop) return undefined;

  // Without an opening time there is nothing to compare against, and a position
  // discovered on startup would be flagged the instant Tame connects. Silence
  // is the right answer until the position's age is actually known.
  if (position.openedAt === undefined) return undefined;

  const age = now - position.openedAt;
  if (age < policy.stopGraceMs) return undefined;

  return {
    id: 'no-stop',
    detail:
      `The ${position.side} on ${position.market.split(':')[0]} has been open ` +
      `${minutes(age)} with no stop covering it.`,
    evidence: {
      ageMs: age,
      graceMs: policy.stopGraceMs,
      positionSize: position.size,
      entryPrice: position.entryPrice,
    },
  };
};

export const stopWidened: Detector = (context) => {
  const { policy, snapshot, now } = context;

  const widenings = snapshot.stopMoves.filter((move) => {
    if (now - move.at > policy.recentEventWindowMs) return false;
    // Away from entry: down for a long, up for a short. A move the other way is
    // the trail doing its job and must never be flagged.
    return move.side === 'long' ? move.to < move.from : move.to > move.from;
  });

  if (widenings.length === 0) return undefined;

  const last = widenings[widenings.length - 1];
  const distance = Math.abs(last.to - last.from);

  return {
    id: 'stop-widened',
    detail:
      `The stop on ${last.market.split(':')[0]} was moved ${distance} further from entry ` +
      `(${last.from} to ${last.to}) ${minutes(now - last.at)} ago.`,
    evidence: {
      from: last.from,
      to: last.to,
      distance,
      market: last.market,
      sinceMs: now - last.at,
      count: widenings.length,
    },
  };
};

export const stopRemoved: Detector = (context) => {
  const { policy, snapshot, now } = context;

  const pulled = snapshot.stopCancellations.filter(
    (event) => now - event.at <= policy.recentEventWindowMs && event.underwater
  );
  if (pulled.length === 0) return undefined;

  const last = pulled[pulled.length - 1];

  return {
    id: 'stop-removed',
    detail:
      `The stop at ${last.trigger} on ${last.market.split(':')[0]} was cancelled ` +
      `${minutes(now - last.at)} ago while the position was losing.`,
    evidence: {
      trigger: last.trigger,
      market: last.market,
      sinceMs: now - last.at,
      count: pulled.length,
    },
  };
};

export const riskPerTrade: Detector = (context) => {
  const { policy, position, equity, currency } = context;
  if (!position || position.plannedRisk === undefined) return undefined;
  if (equity === undefined || !(equity > 0)) return undefined;

  const percent = (position.plannedRisk / equity) * 100;
  if (percent <= policy.maxRiskPercentOfEquity) return undefined;

  return {
    id: 'risk-per-trade',
    detail:
      `Planned downside on ${position.market.split(':')[0]} is ${money(
        position.plannedRisk,
        currency
      )}, ${percent.toFixed(2)}% of equity against your ${policy.maxRiskPercentOfEquity}% limit.`,
    evidence: {
      plannedRisk: position.plannedRisk,
      equity,
      percent: Number(percent.toFixed(3)),
      limit: policy.maxRiskPercentOfEquity,
    },
  };
};

export const leverageCreep: Detector = (context) => {
  const { policy, position, equity } = context;
  if (!position || position.notional === undefined) return undefined;
  if (equity === undefined || !(equity > 0)) return undefined;

  const leverage = position.notional / equity;
  if (leverage <= policy.maxLeverage) return undefined;

  return {
    id: 'leverage-creep',
    detail:
      `${position.market.split(':')[0]} is ${leverage.toFixed(1)}x equity ` +
      `against your ${policy.maxLeverage}x mark.`,
    evidence: {
      leverage: Number(leverage.toFixed(2)),
      notional: position.notional,
      equity,
      limit: policy.maxLeverage,
    },
  };
};

// --- discipline ------------------------------------------------------------

export const dailyLossLimit: Detector = (context) => {
  const { policy, snapshot } = context;
  const limit = policy.dailyLossLimit;
  if (limit === undefined) return undefined;

  const lost = -snapshot.realizedPnl;
  if (lost < limit) return undefined;

  return {
    id: 'daily-loss-limit',
    detail:
      `Down ${money(lost, snapshot.currency)} today against the ` +
      `${money(limit, snapshot.currency)} limit you set.`,
    evidence: {
      realizedPnl: snapshot.realizedPnl,
      limit,
      over: Number((lost - limit).toFixed(2)),
    },
  };
};

export const lossStreak: Detector = (context) => {
  const { policy, snapshot } = context;
  if (snapshot.consecutiveLosses < policy.maxConsecutiveLosses) return undefined;

  const streak = snapshot.trades.slice(-snapshot.consecutiveLosses);
  const total = streak.reduce((sum, trade) => sum + trade.realizedPnl, 0);

  return {
    id: 'loss-streak',
    detail:
      `${snapshot.consecutiveLosses} losing trades in a row, ` +
      `${money(Math.abs(total), snapshot.currency)} between them.`,
    evidence: {
      streak: snapshot.consecutiveLosses,
      streakPnl: total,
      threshold: policy.maxConsecutiveLosses,
    },
  };
};

export const overtrading: Detector = (context) => {
  const { policy, snapshot } = context;
  if (snapshot.trades.length < policy.maxTradesPerSession) return undefined;

  return {
    id: 'overtrading',
    detail:
      `${snapshot.trades.length} round trips this session, against the ` +
      `${policy.maxTradesPerSession} you allow for.`,
    evidence: {
      trades: snapshot.trades.length,
      limit: policy.maxTradesPerSession,
    },
  };
};

export const profitGiveback: Detector = (context) => {
  const { policy, snapshot } = context;
  const { peakEquity, equity, openingEquity } = snapshot;

  if (peakEquity === undefined || equity === undefined || openingEquity === undefined) {
    return undefined;
  }

  // Measured against the profit that existed at the peak, not against the peak
  // itself. A 40% fall from a peak of 10,000 is meaningless as a number; a 40%
  // fall of the 800 that had been made today is the thing worth saying.
  const peakProfit = peakEquity - openingEquity;
  if (!(peakProfit > 0)) return undefined;

  const given = peakEquity - equity;
  if (!(given > 0)) return undefined;

  const percent = (given / peakProfit) * 100;
  if (percent < policy.givebackPercent) return undefined;

  return {
    id: 'profit-giveback',
    detail:
      `You were up ${money(peakProfit, snapshot.currency)} today and have given back ` +
      `${money(given, snapshot.currency)} of it (${percent.toFixed(0)}%).`,
    evidence: {
      peakProfit,
      givenBack: given,
      percent: Number(percent.toFixed(1)),
      threshold: policy.givebackPercent,
    },
  };
};

export const sessionLength: Detector = (context) => {
  const { policy, snapshot, now } = context;
  const elapsed = now - snapshot.startedAt;
  if (elapsed < policy.maxSessionMs) return undefined;

  return {
    id: 'session-length',
    detail: `You have been trading for ${(elapsed / 3_600_000).toFixed(1)} hours straight.`,
    evidence: {
      elapsedMs: elapsed,
      limitMs: policy.maxSessionMs,
    },
  };
};

/**
 * Every detector, in the order findings should be read.
 *
 * Risk first, then discipline, then tilt: 'this position has no stop' is a fact
 * about money that is already exposed, and it should not appear underneath an
 * observation about pace.
 */
export const DETECTORS: Detector[] = [
  noStop,
  stopRemoved,
  stopWidened,
  riskPerTrade,
  leverageCreep,

  dailyLossLimit,
  lossStreak,
  profitGiveback,
  overtrading,
  sessionLength,

  revengeEntry,
  sizeEscalation,
  averagingDown,
  directionFlipping,
  rapidFire,
  chasing,
  orderChurn,
];
