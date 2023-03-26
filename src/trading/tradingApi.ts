// src/trading/tradingApi.ts

import { ExchangeClient } from '../exchange/exchangeClient';

export class TradingApi {
  exchangeClient: ExchangeClient;
  cachedMarkets: string[] | null = null;

  constructor() {
    this.exchangeClient = ExchangeClient.getInstance();
  }

  async getMarkets(): Promise<string[]> {
    const markets = await this.exchangeClient.exchange?.loadMarkets();

    if (!markets) {
      console.error(
        `[TradingApi] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }

    const symbols = Object.keys(markets);
    this.cachedMarkets = symbols;
    console.log('Fetched markets:', symbols);
    return symbols;
  }
}
