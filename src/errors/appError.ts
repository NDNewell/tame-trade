// src/errors/appError.ts

import { errorMessages } from "./errorMessage";
import { ErrorType } from "./errorType";

export class AppError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    const message = AppError.getMessage(type);
    super(message);
    this.type = type;
  }

  static getMessage(type: ErrorType): string {
    switch (type) {
      case ErrorType.PROFILE_NOT_FOUND:
        return errorMessages.configManager.PROFILE_NOT_FOUND;
      case ErrorType.DELETE_PROFILE_FAILED:
        return errorMessages.configManager.DELETE_PROFILE_FAILED;
      default:
        return "An unknown error occurred";
    }
  }
}
