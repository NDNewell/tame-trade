// src/guard/history.ts
//
// What happened before today.
//
// The journal already outlived the process; this makes it outlive the session.
// A coach that starts each morning knowing nothing can only ever comment on the
// morning, and the things worth coaching -- a stop that keeps getting moved, a
// size that climbs after every loss, the same question asked on four separate
// days -- are not visible inside one day at all. They are only visible across
// days, which means somebody has to carry the days.
//
// How far back is a fair question, and the answer turned out to be further than
// expected. A day of trading looks like a hundred and seventy kilobytes until
// the equity samples are taken out of it, at which point it is about twelve
// hundred tokens: a month fits comfortably inside a prompt with room left for
// the candles. So the limit here is not the window. It is that verbatim detail
// stops earning its place after a week -- what happened on a Tuesday three
// weeks ago matters as a number, not as a timeline -- and that a prefix which
// grows without bound is a prefix that gets rewritten into the cache every time
// it changes.
//
// Hence two registers. The last week reads as a narrative, because that is the
// span over which one day explains the next. Everything before it reads as one
// line a day, which is enough to see a trend and cheap enough to keep for as
// long as there is a journal.
//
// Assembled, like everything else the coach is shown, explicitly: this file
// decides what leaves the machine.

import * as os from 'os';
import * as path from 'path';

import { CoachLog, CoachTurn } from './coachLog.js';
import {
  ClosedTrade,
  JournalEvent,
  SessionSnapshot,
  dayKey,
  deriveSnapshot,
  journalDays,
  readJournalDay,
} from './sessionJournal.js';

export interface HistoryOptions {
  journalDirectory?: string;
  coachDirectory?: string;
  /** Days rendered as a timeline, today excluded. */
  detailedDays?: number;
  /** How far back the one-line summaries go. */
  summaryDays?: number;
}

/** A week is about as far as one day still explains the next. */
const DEFAULT_DETAILED_DAYS = 7;
/** Far enough to show a trend; short enough that the prefix stops growing. */
const DEFAULT_SUMMARY_DAYS = 90;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Local time, to the minute. The journal's days are local days. */
const clock = (at: number): string => {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
};

const money = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value)
    ? '-'
    : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

const trim = (value: number | undefined, digits = 8): string =>
  value === undefined || !Number.isFinite(value) ? '?' : String(Number(value.toFixed(digits)));

/** The market without its settlement suffix, which is noise in prose. */
const shortMarket = (market: string): string => market.split(':')[0];

/**
 * One journal event as a line of narrative.
 *
 * Returns undefined for events that belong in the arithmetic rather than the
 * story. Equity samples are the whole of that category and there are a great
 * many of them; printing each one would bury the four lines that matter under
 * a column of a number that barely moved.
 */
function timelineLine(event: JournalEvent): string | undefined {
  const when = clock(event.at);

  switch (event.type) {
    case 'command':
      return event.accepted
        ? `${when}  typed: ${event.text}`
        : `${when}  typed: ${event.text}  -- refused: ${event.error ?? 'no reason recorded'}`;

    case 'fill':
      return (
        `${when}  filled ${event.side.toUpperCase()} ${trim(event.size)} ` +
        `${shortMarket(event.market)} at ${trim(event.price)}` +
        (event.fee ? ` (fee ${trim(event.fee, 4)})` : '')
      );

    case 'order-placed':
      return (
        `${when}  ${event.reconstructed ? 'order in place' : 'order placed'} on ` +
        `${shortMarket(event.market)}` +
        (event.description ? `: ${event.description}` : '') +
        (event.reconstructed ? '  (read from the exchange, not seen being placed)' : '')
      );

    case 'reconciliation': {
      const observed = event.observed
        ? `${event.observed.side} ${trim(event.observed.size)}` +
          (event.observed.entry !== undefined ? ` at ${trim(event.observed.entry)}` : '')
        : 'flat';
      const derived = event.derived
        ? `${event.derived.side} ${trim(event.derived.size)}`
        : 'flat';

      return observed === derived
        ? `${when}  checked against the exchange: ${observed}, and the journal agrees`
        : `${when}  checked against the exchange: it says ${observed}, this journal ` +
            `derived ${derived} -- the difference is fills that were never recorded`;
    }

    case 'order-cancelled':
      return `${when}  order cancelled on ${shortMarket(event.market)}`;

    case 'order-amended':
      return (
        `${when}  ${event.by} moved an order's ${event.field} ` +
        `from ${trim(event.from)} to ${trim(event.to)}`
      );

    case 'trail-armed':
      return (
        `${when}  trail armed: price reached ${trim(event.armPrice)}, ` +
        `the stop at ${trim(event.trigger)} is now following`
      );

    case 'exit-planned':
      return (
        `${when}  worked exit planned on ${shortMarket(event.market)}: ` +
        `${trim(event.quantity)} in ${event.slices} slices, ${event.urgency}` +
        (event.description ? ` -- ${event.description}` : '')
      );

    case 'stop-moved':
      // Direction is the whole point of a stop move, and it is the one thing a
      // pair of numbers does not say on its own to a reader skimming.
      return (
        `${when}  stop moved ${trim(event.from)} -> ${trim(event.to)} ` +
        `(${event.side}, ${
          (event.side === 'long' && event.to > event.from) ||
          (event.side === 'short' && event.to < event.from)
            ? 'tighter'
            : 'looser'
        })`
      );

    case 'stop-cancelled':
      return (
        `${when}  stop at ${trim(event.trigger)} cancelled` +
        (event.underwater ? ' while the position was losing' : '')
      );

    case 'flag':
      return `${when}  GUARD ${event.behaviour} (${event.severity})`;

    case 'override':
      return `${when}  override: pushed through ${event.behaviour}`;

    case 'lockout':
      return `${when}  LOCKED OUT until ${clock(event.until)} -- ${event.reason}`;

    case 'lockout-lifted':
      return `${when}  lockout lifted -- ${event.reason}`;

    case 'equity':
      return undefined;
  }
}

/** A round trip on one line: what it was, how long it was held, what it made. */
function tradeLine(trade: ClosedTrade): string {
  const minutes = Math.round((trade.closedAt - trade.openedAt) / 60_000);
  const held = minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`;

  return (
    `  ${clock(trade.openedAt)}-${clock(trade.closedAt)} ${trade.side} ` +
    `${shortMarket(trade.market)} ${trim(trade.size)} ` +
    `${trim(trade.entryPrice)} -> ${trim(trade.exitPrice)}, held ${held}, ${money(trade.realizedPnl)}`
  );
}

/** The day's arithmetic, in a sentence. */
function headline(day: string, snapshot: SessionSnapshot, active: boolean): string {
  const wins = snapshot.trades.filter((trade) => trade.realizedPnl > 0).length;
  const losses = snapshot.trades.filter((trade) => trade.realizedPnl < 0).length;
  const weekday = WEEKDAY[new Date(`${day}T12:00:00`).getDay()];

  // Measured from the events themselves rather than from the round trips: a day
  // spent building a position that is still open is a day of activity, and
  // reading it as an idle one is the opposite of the truth.
  const span = active
    ? `${clock(snapshot.startedAt)}-${clock(snapshot.now)}`
    : 'no activity';

  const equity =
    snapshot.openingEquity !== undefined
      ? `Equity ${snapshot.openingEquity.toFixed(2)} -> ${(snapshot.equity ?? snapshot.openingEquity).toFixed(2)}` +
        (snapshot.peakEquity !== undefined ? ` (peak ${snapshot.peakEquity.toFixed(2)})` : '')
      : 'Equity not recorded';

  return (
    `${day} (${weekday}), ${span}. ${equity}. ` +
    `Realized ${money(snapshot.realizedPnl)}${snapshot.currency ? ` ${snapshot.currency}` : ''} over ` +
    `${snapshot.trades.length} round trip${snapshot.trades.length === 1 ? '' : 's'} ` +
    `(${wins} won, ${losses} lost).`
  );
}

/**
 * A past day at full length: the arithmetic, the round trips, what was done in
 * what order, and what was said about it.
 */
function detailDay(day: string, events: JournalEvent[], turns: CoachTurn[]): string {
  if (events.length === 0 && turns.length === 0) return '';

  const last = events.length > 0 ? events[events.length - 1].at : Date.now();
  const snapshot = deriveSnapshot(events, last);

  const out: string[] = ['', `--- ${headline(day, snapshot, events.length > 0)}`];

  if (snapshot.trades.length > 0) {
    out.push('Round trips:');
    for (const trade of snapshot.trades) out.push(tradeLine(trade));
  }

  // What was still open when the day ended, because it was still open when the
  // next one began. A position carried overnight is the single most useful
  // thing yesterday can tell today.
  for (const open of snapshot.openPositions) {
    out.push(
      `Carried out of the day: ${open.side} ${trim(open.size)} ${shortMarket(open.market)} ` +
        `at ${trim(open.averageEntry)}, opened ${clock(open.openedAt)}`
    );
  }

  const timeline = events.map(timelineLine).filter((line): line is string => line !== undefined);
  if (timeline.length > 0) {
    out.push('What happened:');
    for (const line of timeline) out.push(`  ${line}`);
  }

  // The panel's own voice is dropped: 'no coach configured' is a fact about the
  // application, not something either party said, and a transcript full of it
  // reads as though the conversation kept being interrupted by furniture.
  const said = turns.filter((turn) => turn.speaker !== 'system');
  if (said.length > 0) {
    out.push('What was said:');
    for (const turn of said) {
      out.push(`  ${clock(turn.at)} ${turn.speaker}: ${turn.text}`);
    }
  }

  return out.join('\n');
}

/** A past day in one line, for the stretch where the timeline has stopped earning its place. */
function summaryDay(day: string, events: JournalEvent[]): string {
  if (events.length === 0) return '';

  const last = events[events.length - 1].at;
  const snapshot = deriveSnapshot(events, last);
  if (snapshot.trades.length === 0 && snapshot.flags.length === 0) return '';

  const wins = snapshot.trades.filter((trade) => trade.realizedPnl > 0).length;
  const losses = snapshot.trades.filter((trade) => trade.realizedPnl < 0).length;

  // Counted rather than listed: the same guardrail firing eleven times is one
  // fact about the day, and eleven copies of its name is not a better way to
  // say it.
  const tally = new Map<string, number>();
  for (const flag of snapshot.flags) {
    tally.set(flag.behaviour, (tally.get(flag.behaviour) ?? 0) + 1);
  }
  const flagged = [...tally.entries()]
    .map(([behaviour, count]) => (count > 1 ? `${behaviour} x${count}` : behaviour))
    .join(', ');

  return (
    `${day}  ${String(snapshot.trades.length).padStart(2)} trades  ` +
    `${money(snapshot.realizedPnl).padStart(10)}  ${wins}W/${losses}L` +
    (flagged ? `  flagged: ${flagged}` : '') +
    (snapshot.overrides.length > 0 ? `  overrides: ${snapshot.overrides.length}` : '')
  );
}

/**
 * The days before today, assembled once and handed over as a block.
 *
 * Deliberately a string rather than a structure. It goes into the prompt as a
 * cache prefix, and a prefix has to be byte-identical from call to call to be
 * worth having -- anything that re-serialises differently on a whim would be
 * paid for again every time.
 */
export class SessionHistory {
  private journalDirectory: string;
  private coachLog: CoachLog;
  private detailedDays: number;
  private summaryDays: number;

  /** Built once per day and reused, since a past day cannot change. */
  private cached: { day: string; text: string } | undefined;

  constructor(options: HistoryOptions = {}) {
    this.journalDirectory =
      options.journalDirectory ?? path.join(os.homedir(), '.tame', 'journal');
    this.coachLog = new CoachLog(options.coachDirectory);
    this.detailedDays = options.detailedDays ?? DEFAULT_DETAILED_DAYS;
    this.summaryDays = options.summaryDays ?? DEFAULT_SUMMARY_DAYS;
  }

  /**
   * Everything before today, newest day first within each register.
   *
   * Empty on the first day of use, which is answered honestly rather than with
   * an apology: a coach told 'there is no history' knows where it stands, and a
   * coach told nothing assumes the history was withheld.
   */
  build(now = Date.now()): string {
    const today = dayKey(now);
    if (this.cached?.day === today) return this.cached.text;

    const days = journalDays(this.journalDirectory).filter((day) => day < today);

    const detailed = days.slice(0, this.detailedDays);
    const summarised = days.slice(this.detailedDays, this.summaryDays);

    const out: string[] = [];

    if (days.length === 0) {
      out.push('PREVIOUS SESSIONS: none. This is the first recorded day.');
    } else {
      const summaries = summarised
        .map((day) => summaryDay(day, readJournalDay(this.journalDirectory, day)))
        .filter(Boolean);

      if (summaries.length > 0) {
        out.push(`EARLIER SESSIONS  one line per day, oldest last`);
        out.push('date        trades      realized  W/L');
        out.push(...summaries);
        out.push('');
      }

      out.push(
        `PREVIOUS SESSIONS, in full. The last ${detailed.length} trading ` +
          `day${detailed.length === 1 ? '' : 's'}, newest first. Times are local.`
      );

      for (const day of detailed) {
        const text = detailDay(
          day,
          readJournalDay(this.journalDirectory, day),
          this.coachLog.read(day)
        );
        if (text) out.push(text);
      }
    }

    const text = out.join('\n');
    this.cached = { day: today, text };
    return text;
  }
}
