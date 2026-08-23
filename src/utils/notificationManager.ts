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
  detail?: EventDetail
) => void;

export class NotificationManager {
  private static sink: Sink | null = null;

  /** Routes notifications somewhere other than the console (the activity log). */
  static setSink(sink: Sink | null): void {
    this.sink = sink;
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
