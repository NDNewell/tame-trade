// src/guard/sessionJournal.ts
//
// What happened this session, and what can be derived from it.
//
// The guardrails need a memory: 'the third entry in six minutes' and 'size is
// climbing while the day is red' are not visible in any single order. This is
// that memory, and it is deliberately an append-only list of facts rather than
// a set of running counters, because a counter can only answer the question it
// was written for and a list can be asked new questions later.
//
// It is written to disk per day, and read back on start. That matters more than
// it looks: a daily loss limit that resets when Tame restarts is not a limit,
// it is a suggestion with a keyboard shortcut. The same reasoning as putting a
// trail's terms in its client order id -- the record has to outlive the process
// that made it.
//
// Deriving is pure. `snapshot()` replays events and computes; nothing in this
// file reads a clock or a price of its own.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BehaviourId, Severity } from './behaviours.js';

export type Direction = 'long' | 'short';

export interface FillEvent {
  type: 'fill';
  at: number;
  market: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  contractSize?: number;
  inverse?: boolean;
  /** Quote-currency fee, when the exchange reports one. */
  fee?: number;
}

export interface OrderPlacedEvent {
  type: 'order-placed';
  at: number;
  market: string;
  orderId?: string;
}

export interface OrderCancelledEvent {
  type: 'order-cancelled';
  at: number;
  market: string;
  orderId?: string;
}

export interface StopMovedEvent {
  type: 'stop-moved';
  at: number;
  market: string;
  side: Direction;
  from: number;
  to: number;
  /** Average entry at the time of the move, for judging direction. */
  entryPrice?: number;
}

export interface StopCancelledEvent {
  type: 'stop-cancelled';
  at: number;
  market: string;
  trigger: number;
  /** Whether the position was losing when the stop was pulled. */
  underwater: boolean;
}

export interface EquityEvent {
  type: 'equity';
  at: number;
  equity: number;
  currency: string;
}

/** The operator pushed an order through a hold. */
export interface OverrideEvent {
  type: 'override';
  at: number;
  market: string;
  behaviour: BehaviourId;
}

/** What the guard said, so a debrief can report what was ignored. */
export interface FlagEvent {
  type: 'flag';
  at: number;
  market: string;
  behaviour: BehaviourId;
  severity: Severity;
}

/**
 * New entries were stopped, and until when.
 *
 * Journalled rather than held in a field so that it survives a restart. A
 * lockout you can clear by pressing Ctrl+C is not a lockout, and the whole
 * value of the mechanism is that the person who hits it is not the person who
 * gets to lift it.
 */
export interface LockoutEvent {
  type: 'lockout';
  at: number;
  until: number;
  behaviour: BehaviourId;
  reason: string;
}

/** The operator deliberately lifted a lockout, which is recorded too. */
export interface LockoutLiftedEvent {
  type: 'lockout-lifted';
  at: number;
  reason: string;
}

export type JournalEvent =
  | FillEvent
  | OrderPlacedEvent
  | OrderCancelledEvent
  | StopMovedEvent
  | StopCancelledEvent
  | EquityEvent
  | OverrideEvent
  | FlagEvent
  | LockoutEvent
  | LockoutLiftedEvent;

/** A position that is currently open, as reconstructed from fills. */
export interface OpenPosition {
  market: string;
  side: Direction;
  size: number;
  averageEntry: number;
  openedAt: number;
  /** Realized on partial exits so far, carried until the position closes. */
  realizedSoFar: number;
  contractSize: number;
  inverse: boolean;
}

/** A completed round trip. */
export interface ClosedTrade {
  market: string;
  side: Direction;
  size: number;
  entryPrice: number;
  exitPrice: number;
  /** Net of every partial exit; fees are included where the exchange gave them. */
  realizedPnl: number;
  openedAt: number;
  closedAt: number;
}

/** A fill that opened or added to a position, as opposed to reducing one. */
export interface EntryRecord {
  at: number;
  market: string;
  side: Direction;
  size: number;
  price: number;
  /** True when it added to a position that already existed. */
  added: boolean;
}

/**
 * Signed profit for a quantity leaving at `exitPrice`.
 *
 * Not floored at zero, unlike the equivalent in positionRisk -- that one is
 * measuring planned downside, where a stop past breakeven contributes nothing.
 * Here a winning exit has to count as a win or the whole session reads as flat.
 */
export function realizedFor(
  side: Direction,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  contractSize: number,
  inverse: boolean
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return 0;
  if (entryPrice <= 0 || exitPrice <= 0 || quantity <= 0) return 0;

  if (inverse) {
    // Inverse contracts settle in the base asset, so profit is a difference of
    // reciprocals rather than of prices.
    return side === 'long'
      ? quantity * contractSize * (1 / entryPrice - 1 / exitPrice)
      : quantity * contractSize * (1 / exitPrice - 1 / entryPrice);
  }

  const perUnit = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return perUnit * quantity * contractSize;
}

const DUST = 1e-9;

/**
 * Folds one fill into a position, closing a trade if it finishes one.
 *
 * Pure, and the only place round trips come into existence. A fill that
 * reverses through zero both closes the old trade and opens a new one, which is
 * why the return carries both.
 */
export function applyFill(
  open: OpenPosition | undefined,
  fill: FillEvent
): { open: OpenPosition | undefined; closed?: ClosedTrade; entry?: EntryRecord } {
  const contractSize = fill.contractSize ?? 1;
  const inverse = fill.inverse ?? false;
  const direction: Direction = fill.side === 'buy' ? 'long' : 'short';
  const fee = Number.isFinite(fill.fee) ? (fill.fee as number) : 0;

  if (!(fill.size > 0) || !(fill.price > 0)) return { open };

  const start = (): { open: OpenPosition; entry: EntryRecord } => ({
    open: {
      market: fill.market,
      side: direction,
      size: fill.size,
      averageEntry: fill.price,
      openedAt: fill.at,
      realizedSoFar: -fee,
      contractSize,
      inverse,
    },
    entry: {
      at: fill.at,
      market: fill.market,
      side: direction,
      size: fill.size,
      price: fill.price,
      added: false,
    },
  });

  if (!open || open.size <= DUST) return start();

  // Same direction: the position grows and the entry price is re-averaged.
  if (open.side === direction) {
    const size = open.size + fill.size;
    return {
      open: {
        ...open,
        size,
        averageEntry:
          (open.averageEntry * open.size + fill.price * fill.size) / size,
        realizedSoFar: open.realizedSoFar - fee,
      },
      entry: {
        at: fill.at,
        market: fill.market,
        side: direction,
        size: fill.size,
        price: fill.price,
        added: true,
      },
    };
  }

  // Opposite direction: it reduces, closes, or reverses.
  const closedQuantity = Math.min(open.size, fill.size);
  const realized =
    realizedFor(
      open.side,
      open.averageEntry,
      fill.price,
      closedQuantity,
      open.contractSize,
      open.inverse
    ) - fee;

  const remaining = open.size - closedQuantity;

  if (remaining > DUST) {
    // A partial exit. The trade is not over, so the realized amount is carried
    // rather than reported -- a scaled-out winner must report one number at the
    // end, not one per tranche.
    return {
      open: { ...open, size: remaining, realizedSoFar: open.realizedSoFar + realized },
    };
  }

  const closed: ClosedTrade = {
    market: open.market,
    side: open.side,
    size: closedQuantity,
    entryPrice: open.averageEntry,
    exitPrice: fill.price,
    realizedPnl: open.realizedSoFar + realized,
    openedAt: open.openedAt,
    closedAt: fill.at,
  };

  const leftover = fill.size - closedQuantity;
  if (leftover <= DUST) return { open: undefined, closed };

  // Reversed straight through flat. The leftover opens the new position, and it
  // counts as an entry: flipping is a behaviour the detectors look for.
  return {
    open: {
      market: fill.market,
      side: direction,
      size: leftover,
      averageEntry: fill.price,
      openedAt: fill.at,
      realizedSoFar: 0,
      contractSize,
      inverse,
    },
    closed,
    entry: {
      at: fill.at,
      market: fill.market,
      side: direction,
      size: leftover,
      price: fill.price,
      added: false,
    },
  };
}

export interface SessionSnapshot {
  startedAt: number;
  now: number;
  currency: string;

  trades: ClosedTrade[];
  entries: EntryRecord[];
  openPositions: OpenPosition[];

  realizedPnl: number;
  /** Losing trades since the last winning one. */
  consecutiveLosses: number;
  lastLoss: ClosedTrade | undefined;

  equity: number | undefined;
  peakEquity: number | undefined;
  /**
   * Equity the first time it was seen this session.
   *
   * The baseline for 'how much of today's profit has been handed back'. Without
   * it, a peak on its own says nothing -- equity of 9,000 under a peak of
   * 10,000 is a disaster on a day that started at 9,100 and a good day on one
   * that started at 5,000.
   */
  openingEquity: number | undefined;

  ordersPlaced: number;
  ordersCancelled: number;
  fills: number;

  stopMoves: StopMovedEvent[];
  stopCancellations: StopCancelledEvent[];
  overrides: OverrideEvent[];
  flags: FlagEvent[];
  /** In force now, or undefined if entries are not stopped. */
  lockout: LockoutEvent | undefined;
}

/**
 * Replays events into everything the detectors need.
 *
 * Recomputed from scratch on each call rather than maintained incrementally.
 * A session is a few hundred events, so the cost is nothing, and an incremental
 * version would be a second implementation of these rules that could disagree
 * with this one -- which is exactly the class of bug that is impossible to see
 * from the outside.
 */
export function deriveSnapshot(
  events: JournalEvent[],
  now: number,
  currency = ''
): SessionSnapshot {
  const ordered = [...events].sort((a, b) => a.at - b.at);

  const positions = new Map<string, OpenPosition>();
  const trades: ClosedTrade[] = [];
  const entries: EntryRecord[] = [];
  const stopMoves: StopMovedEvent[] = [];
  const stopCancellations: StopCancelledEvent[] = [];
  const overrides: OverrideEvent[] = [];
  const flags: FlagEvent[] = [];
  let lockout: LockoutEvent | undefined;

  let ordersPlaced = 0;
  let ordersCancelled = 0;
  let fills = 0;
  let equity: number | undefined;
  let peakEquity: number | undefined;
  let openingEquity: number | undefined;
  let resolvedCurrency = currency;

  for (const event of ordered) {
    switch (event.type) {
      case 'fill': {
        fills++;
        const result = applyFill(positions.get(event.market), event);
        if (result.open) positions.set(event.market, result.open);
        else positions.delete(event.market);
        if (result.closed) trades.push(result.closed);
        if (result.entry) entries.push(result.entry);
        break;
      }
      case 'order-placed':
        ordersPlaced++;
        break;
      case 'order-cancelled':
        ordersCancelled++;
        break;
      case 'stop-moved':
        stopMoves.push(event);
        break;
      case 'stop-cancelled':
        stopCancellations.push(event);
        break;
      case 'equity':
        equity = event.equity;
        if (openingEquity === undefined) openingEquity = event.equity;
        // The peak is the high-water mark of the session, and like the trail's
        // it only moves one way. Letting it follow equity down would make
        // giving back a green day undetectable.
        peakEquity = peakEquity === undefined ? event.equity : Math.max(peakEquity, event.equity);
        if (!resolvedCurrency) resolvedCurrency = event.currency;
        break;
      case 'override':
        overrides.push(event);
        break;
      case 'flag':
        flags.push(event);
        break;
      case 'lockout':
        // A later lockout replaces an earlier one rather than stacking. Two
        // overlapping lockouts would otherwise have to be reasoned about
        // together, and the longer one is the only one that matters anyway.
        lockout =
          lockout === undefined || event.until > lockout.until ? event : lockout;
        break;
      case 'lockout-lifted':
        lockout = undefined;
        break;
    }
  }

  const realizedPnl = trades.reduce((total, trade) => total + trade.realizedPnl, 0);

  let consecutiveLosses = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].realizedPnl < 0) consecutiveLosses++;
    else break;
  }

  const lastLoss = [...trades].reverse().find((trade) => trade.realizedPnl < 0);

  return {
    startedAt: ordered.length > 0 ? ordered[0].at : now,
    now,
    currency: resolvedCurrency,
    trades,
    entries,
    openPositions: [...positions.values()],
    realizedPnl,
    consecutiveLosses,
    lastLoss,
    equity,
    peakEquity,
    openingEquity,
    ordersPlaced,
    ordersCancelled,
    fills,
    stopMoves,
    stopCancellations,
    overrides,
    flags,
    // An expired lockout is not a lockout. Resolving that here means no caller
    // has to remember to check the clock against it.
    lockout: lockout && lockout.until > now ? lockout : undefined,
  };
}

/** Local calendar day, which is what a trading day means to the operator. */
export const dayKey = (at: number): string => {
  const moment = new Date(at);
  return `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(
    moment.getDate()
  ).padStart(2, '0')}`;
};

/**
 * The session's events, in memory and on disk.
 *
 * Disk writes are append-only single lines, so a crash mid-write costs at most
 * the last event rather than the day's record. A line that will not parse on
 * read is skipped rather than fatal: a corrupt journal must degrade the guard,
 * never stop the application from trading.
 */
export class SessionJournal {
  private events: JournalEvent[] = [];
  private file: string | undefined;
  private day: string;
  private listeners: Array<(event: JournalEvent) => void> = [];

  constructor(private directory = path.join(os.homedir(), '.tame', 'journal')) {
    this.day = dayKey(Date.now());
  }

  /**
   * Loads today's record, so a restart continues the session rather than
   * starting a clean one.
   */
  load(now = Date.now()): void {
    this.day = dayKey(now);

    try {
      if (!fs.existsSync(this.directory)) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      }
      this.file = path.join(this.directory, `${this.day}.jsonl`);

      if (!fs.existsSync(this.file)) return;

      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text) as JournalEvent;
          if (parsed && typeof parsed.at === 'number' && typeof parsed.type === 'string') {
            this.events.push(parsed);
          }
        } catch {
          // One unreadable line loses one event, not the day.
        }
      }
    } catch {
      // No journal on disk. The session still runs, from memory only.
      this.file = undefined;
    }
  }

  onEvent(listener: (event: JournalEvent) => void): void {
    this.listeners.push(listener);
  }

  record(event: JournalEvent): void {
    // A day boundary mid-session starts a new file. The in-memory list is not
    // cleared: a position opened before midnight is still open after it, and
    // dropping it would make the next fill look like it came from nowhere.
    const day = dayKey(event.at);
    if (day !== this.day) {
      this.day = day;
      this.file = this.file ? path.join(this.directory, `${day}.jsonl`) : undefined;
    }

    this.events.push(event);

    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      } catch {
        // Losing the write costs persistence, not the running guard.
      }
    }

    for (const listener of this.listeners) listener(event);
  }

  snapshot(now = Date.now(), currency = ''): SessionSnapshot {
    return deriveSnapshot(this.events, now, currency);
  }

  all(): JournalEvent[] {
    return [...this.events];
  }

  /** For tests and for `guard reset`. */
  clear(): void {
    this.events = [];
  }
}
