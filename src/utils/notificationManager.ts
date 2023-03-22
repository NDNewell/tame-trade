// src/utils/notificationManager.ts

import { formatOutput as fo, Color } from "../utils/formatOutput";

export enum NType {
  SUCCESS,
  ERROR,
  INFO,
}

export class NotificationManager {
  static notify(message: string, type: NType): void {
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
