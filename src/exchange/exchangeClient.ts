// src/exchange/exchangeClient.ts

import ccxt, { Exchange } from 'ccxt';
import { ConfigManager } from '../config/configManager';

export class ExchangeClient {
  exchange: Exchange;
  exchangeManager: ConfigManager;

  constructor() {
    this.exchange = new ccxt.kraken();
    this.exchangeManager = new ConfigManager();
  }

  async setExchange(exchangeId: string) {
    const { key, secret } = await this.exchangeManager.getExchangeCredentials(
      exchangeId
    );

    this.exchange = new (ccxt as any)[exchangeId.toLowerCase()]({
      apiKey: key,
      secret: secret,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
        adjustForTimeDifference: true,
      },
    });
  }

  async createMarketBuyOrder(
    instrument: string,
    quantity: number
  ): Promise<void> {
    console.log(
      `[ExchangeClient] Creating market buy order for ${instrument} with quantity: ${quantity}`
    );
    // Add the actual API call to place a market buy order here
  }

  async createMarketSellOrder(
    instrument: string,
    quantity: number
  ): Promise<void> {
    console.log(
      `[ExchangeClient] Creating market sell order for ${instrument} with quantity: ${quantity}`
    );
    // Add the actual API call to place a market sell order here
  }

  async createLimitBuyOrder(
    instrument: string,
    quantity: number,
    price: number
  ): Promise<void> {
    console.log(
      `[ExchangeClient] Creating limit buy order for ${instrument} with quantity: ${quantity} and price: ${price}`
    );
    // Add the actual API call to place a limit buy order here
  }

  async createLimitSellOrder(
    instrument: string,
    quantity: number,
    price: number
  ): Promise<void> {
    console.log(
      `[ExchangeClient] Creating limit sell order for ${instrument} with quantity: ${quantity} and price: ${price}`
    );
    // Add the actual API call to place a limit sell order here
  }

  async createStopOrder(
    instrument: string,
    quantity: number,
    price: number
  ): Promise<void> {
    console.log(
      `[ExchangeClient] Creating stop order for ${instrument} with quantity: ${quantity} and price: ${price}`
    );
    // Add the actual API call to place a stop order here
  }
}
