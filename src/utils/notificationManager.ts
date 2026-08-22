// src/utils/notificationManager.ts

import { formatOutput as fo, Color } from "./formatOutput.js";

export enum NType {
  SUCCESS,
  ERROR,
  INFO,
}

type Sink = (message: string, type: NType, category?: string, at?: number) => void;

export class NotificationManager {
  private static sink: Sink | null = null;

  /** Routes notifications somewhere other than the console (the activity log). */
  static setSink(sink: Sink | null): void {
    this.sink = sink;
  }

  static notify(message: string, type: NType, category?: string, at?: number): void {
    if (this.sink) {
      this.sink(message, type, category, at);
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
