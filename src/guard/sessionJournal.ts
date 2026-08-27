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
  /** The order this was a fill of, where the feed says. */
  orderId?: string;
  /**
   * How much of that order had filled once this fill was in, which together
   * with the order id names the fill exactly.
   *
   * Present so that hearing about a fill twice cannot count it twice. The order
   * feed replays recent history whenever it reconnects, and every reader of it
   * starts out believing nothing has filled yet, so the same partial fill
   * arrives again looking new. It went unnoticed because it does not corrupt
   * anything visibly: the position on screen comes from the exchange and stayed
   * correct, while the journal beside it quietly counted five sessions' worth
   * of trading for one session's worth of trades.
   */
  filledTotal?: number;
}

export interface OrderPlacedEvent {
  type: 'order-placed';
  at: number;
  market: string;
  orderId?: string;
  /**
   * What the order will do, in the words the panel uses.
   *
   * An id and a market say an order happened and nothing about what it was, so
   * a record of the day could not distinguish an entry from the stop protecting
   * it. Optional because the counter that reads this event predates the field
   * and must keep working on files that have none.
   */
  description?: string;
  /** True for a record written by observing the exchange, not by placing it. */
  reconstructed?: boolean;
}

/**
 * What the exchange said was true, as opposed to what the journal derived.
 *
 * The journal builds the position from fills it was told about, and it is not
 * always told: fills that land while Tame is closed, or that a stream drops,
 * leave it holding a position the exchange does not agree with. Nothing on
 * screen shows the disagreement, because the panel reads the exchange directly
 * -- only the guard is working from the derived figure, which is the one that
 * decides whether a size is too large.
 *
 * Recorded as an observation rather than reconciled into fills. Inventing the
 * fills that would explain the difference would make the arithmetic agree by
 * fabricating trades, and a record that lies plausibly is worse than one that
 * admits a gap.
 */
export interface ReconciliationEvent {
  type: 'reconciliation';
  at: number;
  market: string;
  /** As the exchange reports it. Absent when the exchange says flat. */
  observed?: {
    side: Direction;
    size: number;
    entry?: number;
  };
  /** What the journal derived at the same moment, for the difference. */
  derived?: {
    side: Direction;
    size: number;
    entry?: number;
  };
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

/**
 * A command the operator typed, and what became of it.
 *
 * The intention, as opposed to its consequences. Everything else in this file
 * is an effect observed after the fact -- an order appeared, a fill arrived --
 * and effects do not say what was being attempted. 'trail 3atr 15m arm 96.2' is
 * a sentence about a plan; the stop it produces is not, and a reader given only
 * the stop has to guess at the plan and will sometimes guess wrong.
 */
export interface CommandEvent {
  type: 'command';
  at: number;
  /** As typed, before any substitution. */
  text: string;
  market?: string;
  /** False when the command was refused, with the reason in `error`. */
  accepted: boolean;
  error?: string;
}

/** An order's price or size was changed rather than replaced. */
export interface OrderAmendedEvent {
  type: 'order-amended';
  at: number;
  market: string;
  orderId?: string;
  field: 'price' | 'trigger' | 'quantity';
  from?: number;
  to?: number;
  /** What moved it: a chase, a managed trail, or the operator. */
  by: 'chase' | 'trail' | 'operator';
}

/**
 * A delayed trail started trailing.
 *
 * The moment a stop stops being fixed. Worth a line of its own because it is
 * the only transition in the system that nothing on the order records: the
 * order is identical either side of it, and the difference is entirely in
 * whether this process has begun moving it.
 */
export interface TrailArmedEvent {
  type: 'trail-armed';
  at: number;
  market: string;
  orderId?: string;
  armPrice: number;
  trigger: number;
}

/** A worked exit was planned, with the terms it was planned on. */
export interface ExitPlannedEvent {
  type: 'exit-planned';
  at: number;
  market: string;
  urgency: string;
  slices: number;
  quantity: number;
  /** The plan as it was described to the operator, verbatim. */
  description?: string;
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
  | LockoutLiftedEvent
  | CommandEvent
  | OrderAmendedEvent
  | TrailArmedEvent
  | ExitPlannedEvent
  | ReconciliationEvent;

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

  /**
   * What was typed, what was amended, what armed, what was planned.
   *
   * Carried rather than counted. No detector reads these -- they exist so that
   * an account of the session can say what was being attempted, not only what
   * arrived -- and a count would answer one question where the list answers
   * whichever one is asked later.
   */
  commands: CommandEvent[];
  amendments: OrderAmendedEvent[];
  trailArmings: TrailArmedEvent[];
  exitPlans: ExitPlannedEvent[];
  /** The most recent observation of the exchange, per market. */
  reconciliations: ReconciliationEvent[];
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
  const commands: CommandEvent[] = [];
  const amendments: OrderAmendedEvent[] = [];
  const trailArmings: TrailArmedEvent[] = [];
  const exitPlans: ExitPlannedEvent[] = [];
  const reconciled = new Map<string, ReconciliationEvent>();
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
      case 'command':
        commands.push(event);
        break;
      case 'order-amended':
        amendments.push(event);
        break;
      case 'trail-armed':
        trailArmings.push(event);
        break;
      case 'exit-planned':
        exitPlans.push(event);
        break;
      case 'reconciliation':
        // Only the newest per market. An older observation has been overtaken
        // by definition, and a list of them would invite reading a stale one.
        reconciled.set(event.market, event);
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
    commands,
    amendments,
    trailArmings,
    exitPlans,
    reconciliations: [...reconciled.values()],
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
 * One day's events off disk, oldest first.
 *
 * Separate from the journal class because reading a past day is not what a
 * journal does -- it holds the session in progress -- and the history that
 * assembles the coach's longer memory has to read days that no journal is
 * keeping. Both go through here so there is one idea of what the file format
 * is.
 *
 * A line that will not parse is skipped rather than fatal: a corrupt journal
 * must degrade the record, never stop the application from trading.
 */
export function readJournalDay(directory: string, day: string): JournalEvent[] {
  const events: JournalEvent[] = [];

  try {
    const file = path.join(directory, `${day}.jsonl`);
    if (!fs.existsSync(file)) return events;

    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as JournalEvent;
        if (parsed && typeof parsed.at === 'number' && typeof parsed.type === 'string') {
          events.push(parsed);
        }
      } catch {
        // One unreadable line loses one event, not the day.
      }
    }
  } catch {
    // No journal on disk, or it cannot be read. The caller gets nothing.
  }

  return events;
}

/** Days with a journal, newest first. */
export function journalDays(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.replace(/\.jsonl$/, ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

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
  /** Fills already counted, so a replayed one is not counted again. */
  private seenFills = new Set<string>();

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

      for (const event of readJournalDay(this.directory, this.day)) {
        this.events.push(event);
        // Rebuilt from what is on disk, so a restart mid-session does not
        // re-count the fills it is reading back in.
        if (event.type === 'fill') {
          const key = SessionJournal.fillKey(event);
          if (key !== undefined) this.seenFills.add(key);
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

  /**
   * What names a fill, or undefined for a fill the feed did not name.
   *
   * The order id alone will not do -- one order can fill in five parts -- and
   * neither will the size and price, since an order worked in equal slices
   * produces genuinely identical ones. The running total is what distinguishes
   * the third slice from the fourth.
   *
   * Where the feed gives no order id there is nothing to key on, and the fill
   * is recorded. Counting a rare duplicate is the better error: the alternative
   * is silently dropping a real fill because it resembled another one.
   */
  private static fillKey(event: FillEvent): string | undefined {
    if (!event.orderId) return undefined;
    return `${event.market}|${event.orderId}|${event.filledTotal ?? event.size}`;
  }

  record(event: JournalEvent): void {
    if (event.type === 'fill') {
      const key = SessionJournal.fillKey(event);
      if (key !== undefined) {
        if (this.seenFills.has(key)) return;
        this.seenFills.add(key);
      }
    }

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
    this.seenFills.clear();
  }
}
