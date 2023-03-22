// src/trading/tradingApi.ts

export class TradingApi {
  // Replace this with the actual API call to the exchange
  async getMarkets(): Promise<string[]> {
    return ["btc-perp", "eth-perp"];
  }
}
