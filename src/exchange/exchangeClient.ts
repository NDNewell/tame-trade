// src/exchange/exchangeClient.ts

import ccxt from 'ccxt';
// import { Exchange } from 'ccxt';

export class ExchangeClient {
  // private exchange: Exchange;
  static testCcxt(): void {
    console.log(ccxt.exchanges);
  }

  // constructor(exchangeId: string, apiKey: string, secret: string) {
  //   this.exchange = new ccxt[exchangeId]({
  //     apiKey: apiKey,
  //     secret: secret,
  //     enableRateLimit: true,
  //     options: {
  //       defaultType: 'future',
  //       adjustForTimeDifference: true,
  //     },
  //   });
  // }

  // public async fetchOrderBook(symbol: string, limit?: number): Promise<any> {
  //   const orderbook = await this.exchange.fetchOrderBook(symbol, limit);
  //   return orderbook;
  // }

  // public async createOrder(
  //   symbol: string,
  //   side: string,
  //   type: string,
  //   amount: number,
  //   price?: number,
  //   params?: any
  // ): Promise<any> {
  //   const order = await this.exchange.createOrder(
  //     symbol,
  //     type,
  //     side,
  //     amount,
  //     price,
  //     params
  //   );
  //   return order;
  // }

  // public async cancelOrder(
  //   id: string,
  //   symbol: string,
  //   params?: any
  // ): Promise<any> {
  //   const result = await this.exchange.cancelOrder(id, symbol, params);
  //   return result;
  // }

  // public async fetchBalance(): Promise<any> {
  //   const balance = await this.exchange.fetchBalance();
  //   return balance;
  // }

  // public async fetchOpenOrders(
  //   symbol: string,
  //   since?: number,
  //   limit?: number,
  //   params?: any
  // ): Promise<any> {
  //   const openOrders = await this.exchange.fetchOpenOrders(
  //     symbol,
  //     since,
  //     limit,
  //     params
  //   );
  //   return openOrders;
  // }
}
