// src/commands/exchangeCommand.ts

import { ExchangeClient } from '../exchange/exchangeClient';
import { AppError } from '../errors/appError';
import { ErrorType } from '../errors/errorType';

export enum OrderType {
  MARKET_BUY,
  MARKET_SELL,
  LIMIT_BUY,
  LIMIT_SELL,
  STOP,
  NULL,
}

export enum MarketType {
  FUTURES = 'Futures',
  PERPETUAL_SWAPS = 'Perpetual Swaps',
  OPTIONS = 'Options',
  SPOT = 'Spot',
}

export interface Command {
  execute(
    orderType: OrderType,
    currentMarket: string,
    price: number,
    quantity?: number
  ): Promise<void>;
}

export class ExchangeCommand implements Command {
  private exchangeClient: ExchangeClient;

  constructor() {
    this.exchangeClient = ExchangeClient.getInstance();
  }

  async listMarkets(marketType: MarketType) {
    console.log(`Listing markets of type: ${marketType}`);
    // Implement the logic for fetching and displaying markets for the chosen type
  }

  async execute(
    orderType: OrderType,
    currentMarket: string,
    price: number,
    quantity?: number
  ): Promise<void> {
    switch (orderType) {
      case OrderType.MARKET_BUY:
        await this.exchangeClient.createMarketBuyOrder(
          currentMarket,
          quantity!
        );
        break;
      case OrderType.MARKET_SELL:
        await this.exchangeClient.createMarketSellOrder(
          currentMarket,
          quantity!
        );
        break;
      case OrderType.LIMIT_BUY:
        if (price) {
          await this.exchangeClient.createLimitBuyOrder(
            currentMarket,
            price,
            quantity!
          );
        }
        break;
      case OrderType.LIMIT_SELL:
        if (price) {
          await this.exchangeClient.createLimitSellOrder(
            currentMarket,
            price,
            quantity!
          );
        }
        break;
      case OrderType.STOP:
        if (price) {
          await this.exchangeClient.createStopOrder(
            currentMarket,
            price,
            quantity!
          );
        }
        break;
      default:
        console.log('Invalid command. Please enter a valid command.');
        break;
    }
    // await this.exchangeClient.watchOrders(currentMarket);
  }

  getExchangeClient(): ExchangeClient {
    return this.exchangeClient;
  }
}

export namespace OrderType {
  export async function parseCommand(
    order: string
  ): Promise<{ type: OrderType; quantity?: number; price?: number } | null> {
    let type: OrderType = OrderType.NULL; // initialize to default value
    let quantity: number | undefined = undefined;
    let price: number | undefined = undefined;

    console.log(order);

    const args = order.split(/\s+/);
    const orderTypeString = args[0];

    if (orderTypeString === 'buy') {
      type = OrderType.MARKET_BUY;
    } else if (orderTypeString === 'sell') {
      type = OrderType.MARKET_SELL;
    } else if (orderTypeString === 'stop') {
      type = OrderType.STOP;
    } else if (orderTypeString === 'limit' && args.length === 4) {
      const sideString = args[1];
      if (sideString === 'buy') {
        type = OrderType.LIMIT_BUY;
      } else if (sideString === 'sell') {
        type = OrderType.LIMIT_SELL;
      } else {
        throw new AppError(ErrorType.INVALID_COMMAND);
      }
    }

    if (type !== OrderType.NULL) {
      // Apply your validation function here
      validateOrder(order, type);

      let priceString;
      let quantityString;

      if (type === OrderType.STOP) {
        if (args.length === 3) {
          if (!isNaN(Number(args[1]))) {
            quantity = Number(args[1]);
            priceString = args[2];
          } else {
            throw new AppError(ErrorType.INVALID_QUANTITY);
          }
        } else if (args.length === 2) {
          priceString = args[1];
        }
      } else {
        quantityString = args.length === 4 ? args[2] : args[1];
        priceString = args.length === 4 ? args[3] : args[2];

        if (!isNaN(Number(quantityString))) {
          quantity = Number(quantityString);
        } else {
          throw new AppError(ErrorType.INVALID_QUANTITY);
        }
      }

      if (
        type === OrderType.STOP ||
        type === OrderType.LIMIT_BUY ||
        type === OrderType.LIMIT_SELL
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

  export function validateOrder(order: string, type: OrderType): void {
    const args = order.trim().split(/\s+/);

    if (type === OrderType.MARKET_BUY || type === OrderType.MARKET_SELL) {
      if (args.length !== 2) {
        throw new AppError(ErrorType.INVALID_MARKET_ORDER);
      }
    } else if (type === OrderType.LIMIT_BUY || type === OrderType.LIMIT_SELL) {
      if (args.length !== 4) {
        throw new AppError(ErrorType.INVALID_LIMIT_ORDER);
      }
    } else if (type === OrderType.STOP) {
      if (args.length < 2 || args.length > 3) {
        throw new AppError(ErrorType.INVALID_STOP_ORDER);
      }
    }
  }
}
