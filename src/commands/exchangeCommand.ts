// src/commands/exchangeCommand.ts

import { ExchangeClient } from '../exchange/exchangeClient';
import { AppError } from '../errors/appError';
import { ErrorType } from '../errors/errorType';

export enum CommandType {
  MARKET_BUY,
  MARKET_SELL,
  LIMIT_BUY,
  LIMIT_SELL,
  STOP,
  NULL,
}

export interface Command {
  execute(
    commandType: CommandType,
    currentInstrument: string,
    quantity: number,
    price: number
  ): Promise<void>;
}

export class ExchangeCommand implements Command {
  private exchangeClient: ExchangeClient;

  constructor() {
    this.exchangeClient = new ExchangeClient();
  }

  async execute(
    commandType: CommandType,
    currentInstrument: string,
    quantity: number,
    price?: number
  ): Promise<void> {
    switch (commandType) {
      case CommandType.MARKET_BUY:
        await this.exchangeClient.createMarketBuyOrder(
          currentInstrument,
          quantity
        );
        break;
      case CommandType.MARKET_SELL:
        await this.exchangeClient.createMarketSellOrder(
          currentInstrument,
          quantity
        );
        break;
      case CommandType.LIMIT_BUY:
        if (price) {
          await this.exchangeClient.createLimitBuyOrder(
            currentInstrument,
            quantity,
            price
          );
        }
        break;
      case CommandType.LIMIT_SELL:
        if (price) {
          await this.exchangeClient.createLimitSellOrder(
            currentInstrument,
            quantity,
            price
          );
        }
        break;
      case CommandType.STOP:
        if (price) {
          await this.exchangeClient.createStopOrder(
            currentInstrument,
            quantity,
            price
          );
        }
        break;
      default:
        console.log('Invalid command. Please enter a valid command.');
        break;
    }
  }
}

export namespace CommandType {
  export async function parseCommand(
    command: string
  ): Promise<{ type: CommandType; quantity?: number; price?: number } | null> {
    let type: CommandType = CommandType.NULL; // initialize to default value
    let quantity: number | undefined = undefined;
    let price: number | undefined = undefined;

    const args = command.split(/\s+/);
    const typeString = args[0];

    if (typeString === 'buy') {
      type = CommandType.MARKET_BUY;
    } else if (typeString === 'sell') {
      type = CommandType.MARKET_SELL;
    } else if (typeString === 'stop') {
      type = CommandType.STOP;
    } else if (typeString === 'limit' && args.length === 4) {
      const sideString = args[1];
      if (sideString === 'buy') {
        type = CommandType.LIMIT_BUY;
      } else if (sideString === 'sell') {
        type = CommandType.LIMIT_SELL;
      } else {
        throw new AppError(ErrorType.INVALID_COMMAND);
      }
    }

    if (type !== CommandType.NULL) {
      // Apply your validation function here
      validateCommand(command, type);

      const quantityString = args.length === 4 ? args[2] : args[1];
      const priceString = args.length === 4 ? args[3] : args[2];

      if (!isNaN(Number(quantityString))) {
        quantity = Number(quantityString);
      } else {
        throw new AppError(ErrorType.INVALID_QUANTITY);
      }

      if (
        type === CommandType.STOP ||
        type === CommandType.LIMIT_BUY ||
        type === CommandType.LIMIT_SELL
      ) {
        if (!isNaN(Number(priceString))) {
          price = Number(priceString);
        } else {
          throw new AppError(ErrorType.INVALID_PRICE);
        }
      }

      return { type, quantity, price };
    } else {
      throw new AppError(ErrorType.INVALID_COMMAND);
    }
  }

  export function validateCommand(command: string, type: CommandType): void {
    const args = command.trim().split(/\s+/);

    if (type === CommandType.MARKET_BUY || type === CommandType.MARKET_SELL) {
      if (args.length !== 2) {
        throw new AppError(ErrorType.INVALID_MARKET_ORDER);
      }
    } else if (
      type === CommandType.LIMIT_BUY ||
      type === CommandType.LIMIT_SELL
    ) {
      if (args.length !== 4) {
        throw new AppError(ErrorType.INVALID_LIMIT_ORDER);
      }
    } else if (type === CommandType.STOP) {
      if (args.length !== 3) {
        throw new AppError(ErrorType.INVALID_STOP_ORDER);
      }
    }
  }
}
