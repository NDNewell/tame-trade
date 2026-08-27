// src/ui/activityLog.ts
//
// The ACTIVITY region's backing store.
//
// It is also where output that used to go straight to the console is routed. In
// a scrolling terminal a stray console.log is harmless; in a fixed workspace it
// tears the frame apart. Capturing it here keeps the display intact and, per the
// interface brief, keeps low-level client output out of the primary view.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ActivityRowView } from './frame.js';
import { NotificationManager, NType, EventDetail } from '../utils/notificationManager.js';
import { dayKey } from '../guard/sessionJournal.js';

export type ActivityCategory =
  | 'SYSTEM'
  | 'MARKET'
  | 'ORDER'
  | 'FILL'
  | 'WARNING'
  | 'ERROR';

export interface ActivityEvent {
  time: string;
  /** When the event actually happened, for ordering. */
  at: number;
  category: ActivityCategory;
  message: string;
  /**
   * Present on trade events. When set the row is rendered in columns rather
   * than as prose, so events align with each other and can be scanned.
   */
  detail?: EventDetail;
  /** Diagnostics are kept but not shown in the primary view. */
  debug: boolean;
  /**
   * The message as it arrived, when `message` is a shortened form of it.
   *
   * The log on disk gets this; the panel gets the short one. A request URL, its
   * parameters and the exchange's JSON reply are the evidence when something
   * has gone wrong and are worth keeping, but they are four wrapped rows of a
   * region whose value is that a session can be scanned in one glance.
   */
  full?: string;
}

/**
 * How wide a condensed event may be before it is trimmed.
 *
 * Chosen so that a row fits the activity region without wrapping at the widths
 * the workspace is actually used at, now that the coach sidebar has taken a
 * quarter of the terminal.
 */
const COMPACT_WIDTH = 76;

/**
 * What went wrong, in two words.
 *
 * The cause is the part of a failure worth reading. 'phemex GET https://...
 * 100 request timed out (10000 ms)' says one thing -- it timed out -- in a
 * hundred and twenty characters, and the hundred and twenty characters are the
 * same every time.
 */
const CAUSES: Array<[RegExp, string]> = [
  [/timed out|ETIMEDOUT|\btimeout\b/i, 'timeout'],
  [/rate ?limit|too many requests|\b429\b/i, 'rate limited'],
  [/not supported|NotSupported/i, 'unsupported'],
  [/ENOTFOUND|ECONNRESET|ECONNREFUSED|socket hang up|network/i, 'network'],
  [/unauthor|invalid api|signature|\b401\b|\b403\b/i, 'auth rejected'],
  [/insufficient/i, 'insufficient balance'],
];

/**
 * A failure as one readable row.
 *
 * Structured trading events -- a trail armed, an order placed, a stop moved --
 * come through here untouched: they are already short, already say what
 * happened, and shortening them further would cost the numbers that make them
 * worth logging. Only output carrying a payload is cut down.
 */
export function condense(raw: string): string {
  // Our own bracketed prefix says which module spoke, which the category on the
  // row beside it already says. Dropped whatever the length.
  const text = String(raw).trim().replace(/^\[[^\]]+\]\s*/, '');

  const hasPayload = /https?:\/\/|\{"|\{\s*\w+:/.test(text);
  if (text.length <= COMPACT_WIDTH && !hasPayload) return text;

  const cause = CAUSES.find(([pattern]) => pattern.test(text))?.[1];

  // The endpoint, in case the request is all there is: a failure with no prose
  // in front of it still has a name, and 'activeList' is a better row than
  // 'request failed'.
  const endpoint = /https?:\/\/[^\s?]*\/([\w-]+)(?:\?|\s|$)/.exec(text)?.[1];

  let head = text;

  // Everything from the request onwards is payload.
  head = head.split(/\s*[:,-]?\s*\b(?:phemex|binance|bybit)?\s*(?:GET|POST|PUT|DELETE)?\s*https?:\/\//i)[0];
  head = head.split(/\s*\{/)[0];
  head = head.replace(/[\s:,.-]+$/, '');

  // The one failure common enough to deserve a phrasing of its own.
  const candles = /could not (?:read|fetch) (\S+) candles/i.exec(head);
  if (candles) head = `MARKET DATA ${candles[1]} candles unavailable`;

  if (head.length > COMPACT_WIDTH) {
    head = `${head.slice(0, COMPACT_WIDTH - 1).trimEnd()}…`;
  }

  if (!head) head = endpoint ? `${endpoint} request failed` : 'request failed';

  return cause ? `${head} · ${cause}` : head;
}

const MAX_EVENTS = 500;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (value: string): string => value.replace(ANSI, '');

/** Output that is about the machinery rather than the trading. */
const DIAGNOSTIC = [
  /^\[ExchangeClient[\]/]/,
  /^\[Dev\]/,
  /not supported by/i,
  /DeprecationWarning/,
  /^\s*at\s/, // stack frames
];

export class ActivityLog {
  private static instance: ActivityLog | null = null;
  private events: ActivityEvent[] = [];
  private listeners: Array<() => void> = [];
  private restoreConsole: (() => void) | null = null;
  private file: string | undefined;
  private day = '';
  private directory: string | undefined;

  static getInstance(): ActivityLog {
    if (!this.instance) this.instance = new ActivityLog();
    return this.instance;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /**
   * Starts keeping the log on disk as well as in the ring buffer.
   *
   * The buffer holds five hundred events, which is the right size for a panel
   * and the wrong size for a record: a busy hour overruns it, and what scrolls
   * off is gone. Persisting is opt-in and off by default so that a test or a
   * one-off script does not start writing into a home directory by importing
   * this file.
   *
   * Diagnostics are written too. They are kept out of the trading view because
   * they are noise to someone trading, not because they are worthless -- when
   * something has gone wrong they are most of the evidence.
   */
  persistTo(directory = path.join(os.homedir(), '.tame', 'activity')): void {
    this.directory = directory;
  }

  /** Today's file, opened on demand so a session that spans midnight rolls over. */
  private open(at: number): string | undefined {
    if (!this.directory) return undefined;

    const day = dayKey(at);
    if (this.file && day === this.day) return this.file;

    try {
      if (!fs.existsSync(this.directory)) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      }
      this.day = day;
      this.file = path.join(this.directory, `${day}.jsonl`);
      return this.file;
    } catch {
      // Unwritable. The panel is unaffected and nothing is said, because a
      // warning here would itself be an activity event.
      this.directory = undefined;
      return undefined;
    }
  }

  /**
   * `at` is when the event happened, which is not always when we hear about it:
   * the order feed replays recent history on connect, and stamping that backlog
   * with the current time makes every past fill look like it just happened.
   */
  add(
    category: ActivityCategory,
    message: string,
    debug = false,
    at?: number,
    detail?: EventDetail
  ): void {
    const when = at !== undefined && Number.isFinite(at) ? at : Date.now();
    // Date as well as time: the feed replays events from earlier sessions, so a
    // bare clock time is ambiguous about which day it belongs to.
    const moment = new Date(when);
    const date = `${String(moment.getMonth() + 1).padStart(2, '0')}-${String(
      moment.getDate()
    ).padStart(2, '0')}`;
    const time = `${date} ${moment.toTimeString().slice(0, 8)}`;
    // Colour arrives embedded in captured output. Those bytes take no columns on
    // screen but count as characters, so leaving them in makes every layout
    // measurement wrong and the frame ends short of its border.
    const text = stripAnsi(String(message)).replace(/\s+/g, ' ').trim();
    if (text.length === 0 && !detail) return;

    // The panel gets the short form; the file below gets whatever arrived, so
    // the payload is available to whoever is diagnosing without being in front
    // of whoever is trading.
    const compact = condense(text);
    const event: ActivityEvent = {
      time,
      at: when,
      category,
      message: compact,
      detail,
      debug,
      full: compact === text ? undefined : text,
    };

    const file = this.open(when);
    if (file) {
      try {
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      } catch {
        // Losing the write costs the record, not the display.
      }
    }

    this.events.push(event);
    // A replayed backlog can arrive after messages that are newer than it, so
    // order by when things happened rather than when they were received.
    this.events.sort((a, b) => a.at - b.at);
    if (this.events.length > MAX_EVENTS) this.events.shift();

    for (const listener of this.listeners) listener();
  }

  /** Events for the primary view: everything except diagnostics. */
  visible(): ActivityRowView[] {
    return this.events
      .filter((event) => !event.debug)
      .map(({ time, category, message, detail }) => ({ time, category, message, detail }));
  }

  /** Everything, for the debug view. */
  all(): ActivityEvent[] {
    return [...this.events];
  }

  /**
   * Sends console output here instead of to the screen. Anything that looks like
   * machinery is marked as a diagnostic so it stays out of the primary view
   * without being lost.
   */
  captureConsole(): void {
    if (this.restoreConsole) return;

    // Notifications carry their own category, so a fill reads as a FILL rather
    // than as generic output.
    NotificationManager.setSink((message, type, category, at, detail, debug) => {
      const resolved: ActivityCategory =
        (category as ActivityCategory) ??
        (type === NType.ERROR ? 'ERROR' : type === NType.SUCCESS ? 'ORDER' : 'SYSTEM');
      // An explicit diagnostic is kept but stays out of the trading view,
      // whatever it contains.
      this.add(resolved, message, debug === true, at, detail);
    });

    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };

    const route = (category: ActivityCategory) => (...args: unknown[]) => {
      const message = args
        .map((arg) =>
          arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg)
        )
        .join(' ');
      // Only routine chatter is hidden. A warning or an error is never a
      // diagnostic however it is prefixed — hiding failures behind a noise
      // filter is how a rejected order goes unnoticed.
      const routine = category === 'SYSTEM';
      const debug = routine && DIAGNOSTIC.some((pattern) => pattern.test(message));
      this.add(category, message, debug);
    };

    console.log = route('SYSTEM');
    console.info = route('SYSTEM');
    console.warn = route('WARNING');
    console.error = route('ERROR');

    this.restoreConsole = () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
    };
  }

  releaseConsole(): void {
    NotificationManager.setSink(null);
    this.restoreConsole?.();
    this.restoreConsole = null;
  }
}
