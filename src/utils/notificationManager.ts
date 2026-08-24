// src/utils/notificationManager.ts

import { formatOutput as fo, Color } from "./formatOutput.js";

export enum NType {
  SUCCESS,
  ERROR,
  INFO,
}

/** Structured fields for a trade event, so the UI can column-align it. */
export interface EventDetail {
  side?: string;
  quantity?: string;
  price?: string;
  status?: string;
}

type Sink = (
  message: string,
  type: NType,
  category?: string,
  at?: number,
  detail?: EventDetail,
  debug?: boolean
) => void;

export class NotificationManager {
  private static sink: Sink | null = null;

  /** Routes notifications somewhere other than the console (the activity log). */
  static setSink(sink: Sink | null): void {
    this.sink = sink;
  }

  /**
   * Detail for the diagnostic log rather than the trading view.
   *
   * Raw exchange payloads belong here: they answer 'what exactly did the API
   * return', which is a different question from 'what happened to my order',
   * and putting them in the activity feed breaks the row structure.
   */
  static diagnostic(message: string): void {
    if (this.sink) {
      this.sink(message, NType.INFO, 'SYSTEM', undefined, undefined, true);
      return;
    }
    console.error(message);
  }

  static notify(
    message: string,
    type: NType,
    category?: string,
    at?: number,
    detail?: EventDetail
  ): void {
    if (this.sink) {
      this.sink(message, type, category, at, detail);
      return;
    }

    let color: Color = "white";

    switch (type) {
      case NType.SUCCESS:
        color = "green";
        break;
      case NType.ERROR:
        color = "red";
        break;
      case NType.INFO:
        color = "cyan";
    }

    console.log(fo(message, color));
  }
}
