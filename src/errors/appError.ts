// src/errors/appError.ts

import { errorMessages } from './errorMessage.js';
import { ErrorType } from './errorType.js';

export class AppError extends Error {
  type: ErrorType;

  // `detail` adds context to the standard message, so a rejected command can say
  // what the expected form is instead of only that something was wrong.
  constructor(type: ErrorType, detail?: string) {
    const message = AppError.getMessage(type);
    super(detail ? `${message}. ${detail}` : message);
    this.type = type;
  }

  static getMessage(type: ErrorType): string {
    switch (type) {
      case ErrorType.PROFILE_NOT_FOUND:
        return errorMessages.configManager.PROFILE_NOT_FOUND;
      case ErrorType.DELETE_PROFILE_FAILED:
        return errorMessages.configManager.DELETE_PROFILE_FAILED;
      case ErrorType.EXCHANGE_NOT_FOUND:
        return errorMessages.exchangeManager.EXCHANGE_NOT_FOUND;
      case ErrorType.INVALID_PRICE:
        return errorMessages.exchangeCommand.INVALID_PRICE;
      case ErrorType.INVALID_QUANTITY:
        return errorMessages.exchangeCommand.INVALID_QUANTITY;
      case ErrorType.INVALID_COMMAND:
        return errorMessages.exchangeCommand.INVALID_COMMAND;
      case ErrorType.INVALID_MARKET_ORDER:
        return errorMessages.exchangeCommand.INVALID_MARKET_ORDER;
      case ErrorType.INVALID_LIMIT_ORDER:
        return errorMessages.exchangeCommand.INVALID_LIMIT_ORDER;
      case ErrorType.INVALID_STOP_ORDER:
        return errorMessages.exchangeCommand.INVALID_STOP_ORDER;
      default:
        return 'An unknown error occurred';
    }
  }
}
