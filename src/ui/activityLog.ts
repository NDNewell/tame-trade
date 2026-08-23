// src/ui/activityLog.ts
//
// The ACTIVITY region's backing store.
//
// It is also where output that used to go straight to the console is routed. In
// a scrolling terminal a stray console.log is harmless; in a fixed workspace it
// tears the frame apart. Capturing it here keeps the display intact and, per the
// interface brief, keeps low-level client output out of the primary view.

import { ActivityRowView } from './frame.js';
import { NotificationManager, NType, EventDetail } from '../utils/notificationManager.js';

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

  static getInstance(): ActivityLog {
    if (!this.instance) this.instance = new ActivityLog();
    return this.instance;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
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

    this.events.push({ time, at: when, category, message: text, detail, debug });
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
    NotificationManager.setSink((message, type, category, at, detail) => {
      const resolved: ActivityCategory =
        (category as ActivityCategory) ??
        (type === NType.ERROR ? 'ERROR' : type === NType.SUCCESS ? 'ORDER' : 'SYSTEM');
      this.add(resolved, message, false, at, detail);
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
