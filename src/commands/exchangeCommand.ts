// src/commands/exchangeCommand.ts

import { ExchangeClient } from '../exchange/exchangeClient';
import { AppError } from '../errors/appError';
import { ErrorType } from '../errors/errorType';

export enum CommandType {
  BUY,
  SELL,
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
    price: number
  ): Promise<void> {
    switch (commandType) {
      case CommandType.BUY:
        console.log(
          `Buy command executed for instrument: ${currentInstrument} with quantity: ${quantity} and price: ${price}`
        );
        // Execute the buy command with the exchangeClient
        // await this.exchangeClient.createMarketBuyOrder(
        //   currentInstrument,
        //   quantity
        // );
        break;
      case CommandType.SELL:
        console.log(
          `Sell command executed for instrument: ${currentInstrument} with quantity: ${quantity} and price: ${price}`
        );
        // Execute the sell command with the exchangeClient
        // await this.exchangeClient.createMarketSellOrder(
        //   currentInstrument,
        //   quantity
        // );
        break;
      case CommandType.STOP:
        console.log(
          `Stop command executed for instrument: ${currentInstrument} with quantity: ${quantity} and price: ${price}`
        );
        // Execute the stop command with the exchangeClient
        // await this.exchangeClient.createStopOrder(
        //   currentInstrument,
        //   quantity,
        //   price
        // );
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

    const [typeString, quantityString, priceString] = command.split(/\s+/);

    if (typeString === 'buy') {
      type = CommandType.BUY;
    } else if (typeString === 'sell') {
      type = CommandType.SELL;
    } else if (typeString === 'stop') {
      type = CommandType.STOP;
    } else {
      throw new AppError(ErrorType.INVALID_COMMAND);
    }

    if (!isNaN(Number(quantityString))) {
      quantity = Number(quantityString);
    } else {
      throw new AppError(ErrorType.INVALID_QUANTITY);
    }

    if (!isNaN(Number(priceString))) {
      price = Number(priceString);
    } else {
      throw new AppError(ErrorType.INVALID_PRICE);
    }

    return { type, quantity, price };
  }
}
