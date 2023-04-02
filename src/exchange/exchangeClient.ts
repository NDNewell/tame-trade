import { pro as ccxtpro, Exchange, Market, Order } from 'ccxt';
import ccxt from 'ccxt';
import { ConfigManager } from '../config/configManager';
import { ErrorEvent, WebSocket } from 'ws';
import { EventEmitter } from 'events';

interface Position {
  symbol: string;
  contracts: number;
  notional: number;
  side: string;
}

interface StopOrder extends Order {
  stopPrice: number;
  stopDirection: 'Rising' | 'Falling';
  trigger: 'ByLastPrice' | 'ByMarkPrice' | 'ByIndexPrice';
  pegOffsetValueRp: number;
  pegOffsetProportionRr: number;
}

export class ExchangeClient {
  private static instance: ExchangeClient | null = null;
  private availableMarkets: Record<string, Market> | null = null;
  private supportedExchanges: string[] | null = null;
  exchange: Exchange | null = null;
  exchangeManager: ConfigManager;
  private ws: WebSocket | null = null;
  private eventEmitter: EventEmitter;

  private constructor() {
    this.exchangeManager = new ConfigManager();
    this.supportedExchanges = [];
    this.eventEmitter = new EventEmitter();
  }

  static getInstance(): ExchangeClient {
    if (!this.instance) {
      this.instance = new ExchangeClient();
    }
    return this.instance;
  }

  async init(exchangeId?: string): Promise<void> {
    if (exchangeId) {
      await this.setExchange(exchangeId);
      await this.loadMarkets();
    }
    await this.loadExchanges();
  }

  public getAvailableMethods(): Record<string, boolean | 'emulated'> {
    return this.exchange!.has;
  }

  isInitialized(): boolean {
    return this.supportedExchanges !== null;
  }

  async watchOrderBook(symbol: string): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient/watchOrderBook] Exchange not initialized. Please call 'init' or 'setExchange' before fetching order book.`
      );
      return;
    }

    if (!this.exchange.has.ws) {
      console.error(
        `[ExchangeClient/watchOrderBook] WebSocket not supported for the current exchange (${this.exchange.name}).`
      );
      return;
    }

    console.log(
      `[ExchangeClient/watchOrderBook] Subscribing to order book for ${symbol}`
    );
    try {
      while (true) {
        const orderbook = await this.exchange.watchOrderBook(symbol);
        console.log(new Date(), orderbook['asks'][0], orderbook['bids'][0]);
      }
    } catch (error) {
      console.error(
        `[ExchangeClient/watchOrderBook] Failed to subscribe to order book:`,
        error
      );
    }
  }

  async loadExchanges(): Promise<void> {
    const supportedExchanges: Set<string> = new Set();
    const exchangeIds = ccxt.exchanges;
    for (let i = 0; i < exchangeIds.length; i++) {
      const exchangeId = exchangeIds[i];
      try {
        const exchange = new (ccxtpro as any)[exchangeId]();
        if (exchange.has.ws) {
          supportedExchanges.add(exchange.name);
        }
      } catch (e) {
        continue;
      }
    }
    this.supportedExchanges = Array.from(supportedExchanges);
  }

  getMarketStructure(market: string): void {
    const marketStructure = Object.values(this.availableMarkets!).filter(
      (marketObj) => marketObj.symbol === market
    )[0];
    console.log(marketStructure);
  }

  async loadMarkets(): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return;
    }

    try {
      this.availableMarkets = await this.exchange.loadMarkets();
    } catch (error) {
      console.error(`[ExchangeClient] Failed to fetch markets:`, error);
    }
  }

  async setExchange(exchangeId: string): Promise<void> {
    console.log(`[ExchangeClient] Setting exchange to ${exchangeId}...`);
    const { key, secret } = await this.exchangeManager.getExchangeCredentials(
      exchangeId
    );

    this.exchange = new (ccxtpro as any)[exchangeId.toLowerCase()]({
      apiKey: key,
      secret: secret,
      enableRateLimit: true,
      options: {
        defaultType: 'future',
        adjustForTimeDifference: true,
      },
    });

    await this.loadMarkets();
    await this.loadExchanges();
    this.setEventListeners();
  }

  async getMarketTypes(): Promise<string[]> {
    const availableTypes = new Set<string>();
    if (this.availableMarkets !== null) {
      Object.values(this.availableMarkets).forEach((market) => {
        if (market.type) {
          availableTypes.add(market.type);
        }
      });

      return Array.from(availableTypes);
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }
  }

  getSupportedExchanges(): string[] {
    return this.supportedExchanges || [];
  }

  getExchangeInstance(): Exchange | null {
    return this.exchange;
  }

  getSelectedExchangeName(): string | null {
    return this.exchange ? this.exchange.name : null;
  }

  async getMarketSymbols(): Promise<Array<string>> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }

    if (this.availableMarkets !== null) {
      return Object.keys(this.availableMarkets);
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }
  }

  async getMarketByType(type: string): Promise<Array<string>> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }

    if (this.availableMarkets !== null) {
      return Object.keys(this.availableMarkets).filter(
        (symbol) => this.availableMarkets![symbol].type === type
      );
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching markets.`
      );
      return [];
    }
  }

  trimAmount(amount: number): string {
    const trimmedAmount = amount.toFixed(
      Math.max(
        2,
        amount.toString().split('.')[1]?.replace(/0+$/, '').length || 0
      )
    );

    return trimmedAmount;
  }

  setEventListeners(): void {
    this.eventEmitter.on('limitOrderFilled', (data) => {
      console.log(
        `${data.side[0].toUpperCase()}${data.side.slice(1)} limit filled ${
          data.filled
        } @${data.price}`
      );
    });

    this.eventEmitter.on('orderCanceled', (data) => {
      console.log(
        `${data.side[0].toUpperCase()}${data.side.slice(1)} order canceled!`
      );
    });
  }

  async watchOrders(symbol: string): Promise<void> {
    try {
      // Subscribe to order updates
      const orders: any[] = await this.exchange!.watchOrders(symbol);
      orders.forEach((order) => {
        const { status, type, side, price, filled, average } = order;
        if (status === 'closed') {
          if (type === 'limit') {
            this.eventEmitter.emit('limitOrderFilled', {
              side,
              filled,
              price,
            });
          }
          // You can add other types of orders like 'stop' or 'stop-limit' if needed.
        } else if (status === 'canceled') {
          this.eventEmitter.emit('orderCanceled', {
            side,
          });
        }
      });
      this.exchange!.watchOrders(symbol, undefined, { fetchOrder: 'stop' });
    } catch (error) {
      console.error(
        `[ExchangeClient/watchOrders] Failed to subscribe to order updates:`,
        error
      );
    }
  }

  async getQuantityPrecision(
    market: string,
    quantity: number
  ): Promise<number> {
    const marketInfo = this.availableMarkets![market];
    const minTradeAmount = marketInfo.precision.amount;

    if (quantity < minTradeAmount!) {
      throw new Error(`Minimum order size for ${market} is ${minTradeAmount}`);
    } else {
      return quantity;
    }
  }

  async executeOrder(
    method: string,
    market: string,
    ...args: any[]
  ): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before placing an order.`
      );
      return;
    }

    try {
      const order = await (this.exchange as any)[method](market, ...args);
      const orderType = order.info.order_type;

      if (orderType === 'market') {
        const filledAmount = parseFloat(order.filled);
        const trimmedFilledAmount = this.trimAmount(filledAmount);
        const trimmedPrice = parseFloat(order.price).toFixed(2);
        console.log(`Filled ${trimmedFilledAmount} @${trimmedPrice}`);
      } else if (orderType === 'limit') {
        const side = order.side;
        const amount = parseFloat(order.amount);
        const trimmedAmount = this.trimAmount(amount);
        const price = parseFloat(order.price).toFixed(2);
        console.log(
          `Limit order (${side}) of ${trimmedAmount} placed @${price}, order ID: ${order.id}`
        );
      } else if (orderType === 'stop_market') {
        const amount = parseFloat(order.amount);
        const trimmedAmount = this.trimAmount(amount);
        const price = parseFloat(order.stopPrice).toFixed(2);
        console.log(
          `Placed stop @${price} for amount ${trimmedAmount}, order ID: ${order.id}`
        );
      }
    } catch (error) {
      console.error(`[ExchangeClient] Failed to place order:`, error);
    }
  }

  async getPositionStructure(symbol: string): Promise<Position> {
    let positionStructure: Position = {
      symbol: '',
      contracts: 0,
      notional: 0,
      side: '',
    };

    if (!this.exchange) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching position.`
      );
      return positionStructure;
    }

    try {
      positionStructure = await this.exchange.fetchPosition(symbol);
      return positionStructure;
    } catch (error) {
      if (error instanceof ccxt.NotSupported) {
        try {
          const positions = await this.exchange.fetchPositions([symbol]);
          positionStructure = positions.find(
            (pos: Position) => pos.symbol === symbol
          );
          if (positionStructure) {
            return positionStructure;
          }
        } catch (error: unknown) {
          console.error('Error fetching positions:', (error as Error).message);
        }
      } else {
        console.error('Error fetching position:', (error as Error).message);
      }
    }

    return positionStructure;
  }

  async getPositionSize(symbol: string): Promise<number> {
    let positionSize = 0;

    const position = await this.getPositionStructure(symbol);
    if (position) {
      positionSize = position.contracts;
    }
    if (positionSize === 0) {
      return 0;
    } else if (positionSize > 0) {
      return positionSize;
    } else {
      return Math.abs(positionSize);
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    try {
      const openOrders = await this.exchange!.fetchOpenOrders(symbol);
      if (openOrders.length > 0) {
        await this.exchange!.cancelAllOrders(symbol);
      } else {
        throw new Error('No open orders to cancel');
      }
    } catch (error) {
      console.error('Error cancelling orders:', error);
      throw error;
    }
  }

  async cancelAllLimitOrders(symbol: string): Promise<void> {
    try {
      const openOrders = await this.exchange!.fetchOpenOrders(symbol);
      const limitOrders = openOrders.filter((order) => order.type === 'limit');

      if (limitOrders.length > 0) {
        const cancelPromises = limitOrders.map((order) =>
          this.exchange!.cancelOrder(order.id, symbol)
        );
        await Promise.all(cancelPromises);
      } else {
        throw new Error('No open limit orders to cancel');
      }
    } catch (error) {
      console.error('Error cancelling limit orders:', error);
      throw error;
    }
  }

  async cancelAllStopOrders(symbol: string): Promise<void> {
    try {
      let stopOrders;
      const openOrders = await this.exchange!.fetchOpenOrders(symbol);
      console.log('openOrders:', openOrders);
      stopOrders = openOrders.filter(
        (order) => order.info.order_type === 'stop_market'
      );

      if (stopOrders.length === 0) {
        stopOrders = openOrders.filter(
          (order) => order.type!.toLowerCase() === 'stop'
        );
      }

      if (stopOrders.length > 0) {
        for (const order of stopOrders) {
          await this.exchange!.cancelOrder(order.id, symbol);
        }
      } else {
        throw new Error('No open stop orders to cancel');
      }
    } catch (error) {
      console.error('Error cancelling stop orders:', error);
      throw error;
    }
  }

  async bumpOrders(symbol: string, priceChange: number): Promise<void> {
    try {
      const openOrders = await this.exchange!.fetchOpenOrders(symbol);

      if (openOrders.length > 0) {
        for (const order of openOrders) {
          const orderType = order.type.toLowerCase();
          let params;
          let newPrice;

          if (orderType.toLowerCase() === 'stop') {
            const stopOrder = order as StopOrder;
            newPrice = stopOrder.stopPrice + priceChange;
            params = {
              // stopLossPrice: price, // only available on Deribit so far
              stopPrice: newPrice, // Phemex's property name for a stop order
              // reduce_only: true, // only available on Deribit so far
            };
          } else if (orderType.toLowerCase() === 'limit') {
            newPrice = order.price + priceChange;
          }

          await this.exchange!.editOrder(
            order.id,
            symbol,
            orderType,
            order.side,
            order.amount,
            newPrice,
            params ? params : {}
          );
        }
      } else {
        throw new Error('No open orders to bump');
      }
    } catch (error) {
      console.error('Error bumping orders:', error);
      throw error;
    }
  }

  async closePosition(market: string): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before closing a position.`
      );
      return;
    }

    try {
      const position = await this.getPositionStructure(market);
      const side = position.side === 'long' ? 'sell' : 'buy';
      const quantity = Math.abs(position.contracts);

      if (quantity > 0) {
        await this.executeOrder(
          'createMarketOrder',
          market,
          side,
          await this.getQuantityPrecision(market, quantity)
        );
      } else {
        console.error(`[ExchangeClient] No positions found for ${market}.`);
      }
    } catch (error) {
      console.error(`[ExchangeClient] Failed to close position:`, error);
    }
  }

  async createMarketBuyOrder(market: string, quantity: number): Promise<void> {
    await this.executeOrder(
      'createMarketBuyOrder',
      market,
      await this.getQuantityPrecision(market, quantity)
    );
  }

  async createMarketSellOrder(market: string, quantity: number): Promise<void> {
    await this.executeOrder(
      'createMarketSellOrder',
      market,
      await this.getQuantityPrecision(market, quantity)
    );
  }

  async createLimitBuyOrder(
    market: string,
    price: number,
    quantity: number
  ): Promise<void> {
    await this.executeOrder(
      'createLimitBuyOrder',
      market,
      await this.getQuantityPrecision(market, quantity),
      price
    );
  }

  async createLimitSellOrder(
    market: string,
    price: number,
    quantity: number
  ): Promise<void> {
    await this.executeOrder(
      'createLimitSellOrder',
      market,
      await this.getQuantityPrecision(market, quantity),
      price
    );
  }

  async createStopOrder(
    market: string,
    price: number,
    quantity?: number
  ): Promise<void> {
    try {
      if (!quantity) {
        const openOrders = await this.exchange!.fetchOpenOrders(market);
        quantity = await this.getPositionSize(market);

        const openOrdersQuantity = openOrders.reduce((acc, order) => {
          if (order.type === 'limit') {
            return acc + order.remaining;
          } else {
            return acc;
          }
        }, 0);

        if (openOrdersQuantity > 0) {
          quantity += openOrdersQuantity;
        }
      }

      if (quantity > 0) {
        const position = await this.getPositionStructure(market);
        const side = position.side === 'buy' ? 'sell' : 'buy';
        const params = {
          // stopLossPrice: price, // only available on Deribit so far
          stopPrice: price, // Phemex's property name for a stop order
          reduce_only: true, // only available on Deribit so far
        };

        quantity = await this.getQuantityPrecision(market, quantity);

        await this.executeOrder(
          'createOrder',
          market,
          'stop', // Phemex's order type for a stop order is 'stop'
          side,
          quantity,
          price,
          params
        );
      } else {
        console.error(
          `[ExchangeClient] No positions found for ${market}. Please open a position before placing a stop order.`
        );
        return;
      }
    } catch (error) {
      console.error(`[ExchangeClient] Failed to place order:`, error);
    }
  }
}
