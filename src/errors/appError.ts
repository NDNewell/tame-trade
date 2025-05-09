// src/errors/appError.ts

import { errorMessages } from './errorMessage.js';
import { ErrorType } from './errorType.js';

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
