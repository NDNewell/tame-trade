// src/ui/activityLog.ts
//
// The ACTIVITY region's backing store.
//
// It is also where output that used to go straight to the console is routed. In
// a scrolling terminal a stray console.log is harmless; in a fixed workspace it
// tears the frame apart. Capturing it here keeps the display intact and, per the
// interface brief, keeps low-level client output out of the primary view.

import { ActivityRowView } from './frame.js';

export type ActivityCategory =
  | 'SYSTEM'
  | 'MARKET'
  | 'ORDER'
  | 'FILL'
  | 'WARNING'
  | 'ERROR';

export interface ActivityEvent {
  time: string;
  category: ActivityCategory;
  message: string;
  /** Diagnostics are kept but not shown in the primary view. */
  debug: boolean;
}

const MAX_EVENTS = 500;

/** Output that is about the machinery rather than the trading. */
const DIAGNOSTIC = [
  /^\[ExchangeClient\]/,
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

  add(category: ActivityCategory, message: string, debug = false): void {
    const time = new Date().toTimeString().slice(0, 8);
    const text = String(message).replace(/\s+/g, ' ').trim();
    if (text.length === 0) return;

    this.events.push({ time, category, message: text, debug });
    if (this.events.length > MAX_EVENTS) this.events.shift();

    for (const listener of this.listeners) listener();
  }

  /** Events for the primary view: everything except diagnostics. */
  visible(): ActivityRowView[] {
    return this.events
      .filter((event) => !event.debug)
      .map(({ time, category, message }) => ({ time, category, message }));
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
    this.restoreConsole?.();
    this.restoreConsole = null;
  }
}
