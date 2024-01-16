// src/exchange/exchangeClient.ts

import { pro as ccxtpro, Exchange, Market, Order } from 'ccxt';
import ccxt from 'ccxt';
import ora, { spinners } from 'ora';
import { ConfigManager } from '../config/configManager';
import { ErrorEvent, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { exchangeParams } from './exchangeParams';
import { parse } from 'path';
import readline from 'readline';

interface Position {
  symbol: string;
  contracts?: number | undefined;
  notional?: number | undefined;
  side: string;
  entryPrice?: number;
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
  private chaseLimitOrderActive: boolean = false;

  private constructor() {
    this.exchangeManager = new ConfigManager();
    this.supportedExchanges = [];
    this.eventEmitter = new EventEmitter();
    this.chaseLimitOrderActive = false;
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

  logAndReplace(msg: string) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(msg);
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
  ): Promise<any> {
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

      return order;
    } catch (error) {
      console.error(
        `[ExchangeClient] Failed to place order:`,
        (error as Error).message
      );
    }
  }

  async getMarketPrecision(market: string): Promise<number> {
    if (this.exchange === null) {
        console.error(
            `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching market precision.`
        );
        return 0;
    }
    // Ensure markets are loaded
    if (!this.availableMarkets) {
      await this.loadMarkets();
    }
    // Use the market name to access precision details
    const marketInfo = this.availableMarkets![market];
    if (!marketInfo) {
      throw new Error(`Market ${market} not found.`);
    }
    return marketInfo.precision.price ?? 0;
  }

  async getPositionStructure(symbol: string): Promise<Position | undefined> {
    let positionStructure: Position | undefined = {
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

  async getEntryPrice(symbol: string): Promise<number | undefined> {
    const position = await this.getPositionStructure(symbol);
    if (position && position.contracts !== undefined) {
      return position.entryPrice ?? 0;
    }
  }

  async getPositionSize(symbol: string): Promise<number> {
    let positionSize = 0;

    const position = await this.getPositionStructure(symbol);
    if (position && position.contracts !== undefined) {
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

  async cancelOrdersByDirection(
    market: string,
    direction?: string,
    rangeStart?: number,
    rangeEnd?: number
  ): Promise<void> {
    // Fetch the orders from the market symbol
    const orders = await this.exchange!.fetchOpenOrders(market);

    // Filter out stop orders
    const filteredOrders = orders.filter(
      (order) => order.type.toLowerCase() !== 'stop'
    );

    // Sort orders by price depending on the direction
    const sortedOrders =
      direction === 'bottom'
        ? filteredOrders.sort((a, b) => a.price - b.price)
        : filteredOrders.sort((a, b) => b.price - a.price);

    // Determine the range of orders to be canceled
    let start = rangeStart ? rangeStart - 1 : 0;
    let end = rangeEnd ? rangeEnd : sortedOrders.length;

    // Slice the orders array based on the determined range
    const ordersToCancel = sortedOrders.slice(start, end);

    // Cancel the orders within the range
    for (const order of ordersToCancel) {
      await this.exchange!.cancelOrder(order.id, market);
    }

    console.log(`${ordersToCancel.length} orders have been canceled.`);
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    this.cancelAllStopOrders(symbol);
    this.cancelAllLimitOrders(symbol);
  }

  async cancelAllLimitOrders(symbol: string): Promise<void> {
    try {
      // Fetch open orders for the given symbol/market
      const openOrders = await this.exchange!.fetchOpenOrders(symbol);
      // Filter orders to obtain only limit orders
      const limitOrders = openOrders.filter((order) => order.type === 'limit');

      // If there are no limit orders, simply return without doing anything further
      if (limitOrders.length === 0) {
        console.log('No open limit orders to cancel.');
        return;
      }

      // If there are limit orders, proceed with canceling them
      const cancelPromises = limitOrders.map((order) =>
        this.exchange!.cancelOrder(order.id, symbol)
      );
      // Wait for all cancellations to complete
      await Promise.all(cancelPromises);
    } catch (error) {
      // Log the error instead of throwing it
      console.error('Error cancelling limit orders:', error);
    }
  }

  async cancelAllStopOrders(symbol: string): Promise<void> {
    try {
        let stopOrders = [];
        const openOrders = await this.exchange!.fetchOpenOrders(symbol);
        stopOrders = openOrders.filter(
            (order) => order.info.order_type === 'stop_market'
        );
        if (stopOrders.length === 0) {
            stopOrders = openOrders.filter(
                (order) => order.type!.toLowerCase() === 'stop'
            );
        }
        if (stopOrders.length > 0) {
            const cancelPromises = stopOrders.map((order) =>
                this.exchange!.cancelOrder(order.id, symbol)
            );
            await Promise.all(cancelPromises);
        } else {
            console.log('No open stop orders to cancel.');
            return;  // Use return to gracefully exit without throwing an error.
        }
    } catch (error) {
        // Instead of throwing an error, log it and handle it gracefully.
        console.error('Error cancelling stop orders:', error);
    }
  }

  async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cancelChaseOrder(orderId: string, market: string): Promise<void> {
    try {
      await this.exchange!.cancelOrder(orderId, market);
      this.chaseLimitOrderActive = false;
    } catch (error) {
      console.error('Error cancelling chase order:', error);
      throw error;
    }
  }

  getChaseLimitOrderStatus(): boolean {
    return this.chaseLimitOrderActive;
  }

  async chaseLimitOrder(
    market: string,
    side: string,
    amount: number,
    decay?: string
  ): Promise<string | undefined | void> {
    this.chaseLimitOrderActive = true;
    const orderBook = await this.exchange!.fetchL2OrderBook(market);
    const bestPrice =
      side === 'buy' ? orderBook.bids[0][0] : orderBook.asks[0][0];
    const order = await (side === 'buy'
      ? await this.createLimitBuyOrder(market, bestPrice, amount)
      : await this.createLimitSellOrder(market, bestPrice, amount));

    if (!order) {
      console.log('Order filled immediately');
      this.chaseLimitOrderActive = false;
      return;
    }

    const orderId = order.id;
    let remainingAmount = amount;

    const executeChaseOrder = async () => {
      const openOrders = await this.exchange!.fetchOpenOrders(market);
      const order = openOrders.find((o) => o.id === orderId);

      if (!order) {
        if (this.chaseLimitOrderActive) {
          // console.log(`Chase ${side} order filled ${amount} ${market}`);
          this.logAndReplace(`Chase ${side} order filled ${amount} ${market}`);
          this.chaseLimitOrderActive = false;
        } else {
          // console.log(`Chase ${side} order cancelled ${amount} ${market}`);
          this.logAndReplace(
            `Chase ${side} order cancelled ${amount} ${market}`
          );
        }
        return;
      }

      const updatedOrderBook = await this.exchange!.fetchL2OrderBook(market);
      const updatedBestPrice =
        side === 'buy'
          ? updatedOrderBook.bids[0][0]
          : updatedOrderBook.asks[0][0];

      if (
        (side === 'buy' && updatedBestPrice > order.price) ||
        (side === 'sell' && updatedBestPrice < order.price)
      ) {
        await this.editOrder(
          orderId,
          market,
          'limit',
          updatedBestPrice,
          order.remaining
        );
      }

      remainingAmount = order.remaining;

      if (remainingAmount > 0) {
        setTimeout(executeChaseOrder, 100); // Adjust the delay interval as needed
      }
    };
    executeChaseOrder();

    // let's parse the decay time. 'decay' that takes a time argument in seconds e.g. `5s` or minutes e.g. `1m`
    const parseDecayTime = (decay: string): number => {
      const time = decay.slice(0, -1);
      const unit = decay.slice(-1);
      let decayTime = 0;

      if (unit === 's') {
        decayTime = parseInt(time) * 1000;
      } else if (unit === 'm') {
        decayTime = parseInt(time) * 60000;
      } else {
        throw new Error('Invalid decay time');
      }

      return decayTime;
    };

    if (decay) {
      const decayTime = parseDecayTime(decay);
      setTimeout(() => {
        if (this.chaseLimitOrderActive) {
          this.cancelChaseOrder(orderId, market);
        }
      }, decayTime);
    }

    return orderId;
  }

  async editOrder(
    orderId: string,
    symbol: string,
    orderType: string,
    price: number,
    quantity?: number
  ): Promise<void> {
    try {
      const orders = await this.exchange!.fetchOrders(symbol);
      let order = orders.find((order) => order.id === orderId);

      if (!order) {
        throw new Error(`Order with id ${orderId} not found`);
      }

      // If quantity is not provided, use the order's amount
      quantity = quantity !== undefined ? quantity : order.amount;

      await this.exchange!.editOrder(
        order.id,
        symbol,
        orderType,
        order.side,
        quantity,
        price
      );
    } catch (error) {
      console.error('Error editing order:', error);
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
      let quantity = 0;
      if (!position) {
        console.error('Position is not defined');
        return;
      }
      const side = position.side === 'long' ? 'sell' : 'buy';

      if (typeof position.contracts === 'number') {
        quantity = Math.abs(position.contracts);
      } else {
        throw new Error('Position size is not defined');
      }

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

  calculatePositionSize(
    totalCapitalToRisk: number,
    riskPercentage: number,
    entryPrice: number,
    stopPrice: number
  ): number {
    const riskAmount = (totalCapitalToRisk * riskPercentage) / 100;
    const positionRisk = Math.abs(entryPrice - stopPrice);
    if (positionRisk === 0) {
      throw new Error(
        'Position risk cannot be zero. Entry price and stop price cannot be the same.'
      );
    }
    return riskAmount / positionRisk;
  }

  calculateRiskReturnRatio(
    entryPrice: number,
    stopPrice: number,
    takeProfitPrice: number
  ): number {
    const potentialProfit = Math.abs(entryPrice - takeProfitPrice);
    const potentialLoss = Math.abs(entryPrice - stopPrice);
    if (potentialLoss === 0) {
      throw new Error(
        'Potential loss cannot be zero. Entry price and stop price cannot be the same.'
      );
    }
    return potentialProfit / potentialLoss;
  }

  async createBracketLimitOrder(
    market: string,
    side: string,
    capitalToRisk: number,
    riskPercentage: number,
    stopPrice: number,
    entryPrice: number
  ): Promise<void> {
    const slippageAdjustmentFactor = 1.75;
    const riskAmount = (capitalToRisk * riskPercentage) / 100;
    const quantity = riskAmount / Math.abs(entryPrice - stopPrice);
    const slippageAdjustedQuantity = quantity / slippageAdjustmentFactor;

    await (side === 'buy'
      ? this.createLimitBuyOrder(market, entryPrice, slippageAdjustedQuantity)
      : this.createLimitSellOrder(
          market,
          entryPrice,
          slippageAdjustedQuantity
        ));

    await this.createStopOrder(market, stopPrice, slippageAdjustedQuantity);

    const potentialLoss = Math.abs(entryPrice - stopPrice) * quantity;
    console.log(
      `Bracket ${side} order of ${slippageAdjustedQuantity.toFixed(
        2
      )} placed @ $${entryPrice.toFixed(2)}`
    );
    console.log(`Potential loss of around: $${potentialLoss.toFixed(2)}`);
  }

  async submitRangeOrders(
    action: string,
    market: string,
    startPrice: number,
    endPrice: number,
    numOrders: number,
    totalRiskPercentage: number,
    stopPrice: number,
    takeProfitPrice: number,
    totalCapitalToRisk: number,
    riskReturnRatioThreshold: number
  ) {
    const priceStep = (endPrice - startPrice) / (numOrders - 1);
    const riskPercentagePerOrder = totalRiskPercentage / numOrders;

    const spinner = ora(`Posting range ${action} orders...`).start();

    for (let i = 0; i < numOrders; i++) {
      const orderPrice = startPrice + priceStep * i;
      const positionSize = this.calculatePositionSize(
        totalCapitalToRisk,
        riskPercentagePerOrder,
        orderPrice,
        stopPrice
      );
      const riskReturnRatio = this.calculateRiskReturnRatio(
        orderPrice,
        stopPrice,
        takeProfitPrice
      );

      if (riskReturnRatio <= riskReturnRatioThreshold) {
        throw new Error(
          `Risk/return ratio of ${riskReturnRatio} is below the threshold of ${riskReturnRatioThreshold}.`
        );
      }

      if (action === 'buy') {
        await this.createLimitBuyOrder(market, orderPrice, positionSize);
      } else if (action === 'sell') {
        await this.createLimitSellOrder(market, orderPrice, positionSize);
      } else {
        throw new Error(`Invalid action: ${action}. Expected 'buy' or 'sell'`);
      }
    }

    spinner.stop();

    this.createStopOrder(market, stopPrice);

    const allOrders = await this.exchange!.fetchOrders(market);
    const openOrders = allOrders.filter((order) => order.status === 'open');
    const openQuantity = openOrders.reduce((acc, order) => {
      if (order.type !== 'stop' && !isNaN(order.remaining)) {
        return acc + order.remaining;
      } else {
        return acc;
      }
    }, 0);
    const avgOrderPrice =
      openOrders.reduce((acc, order) => {
        if (!isNaN(order.price)) {
          return acc + order.price;
        } else {
          return acc;
        }
      }, 0) / openOrders.length;
    const totalPotentialProfit =
      Math.abs(avgOrderPrice - takeProfitPrice) * openQuantity;
    const totalPotentialLoss =
      Math.abs(avgOrderPrice - stopPrice) * openQuantity;
    const totalRiskReturnRatio = totalPotentialProfit / totalPotentialLoss;

    console.log(`Average order price: ${avgOrderPrice.toFixed(2)}`);

    console.log(
      `Total position size: ${openQuantity.toFixed(3)} ${market.split('/')[0]}`
    );
    console.log(
      `Total potential profit: ${totalPotentialProfit.toFixed(2)} ${
        market.split('/')[1].split(':')[0]
      }`
    );
    console.log(
      `Total potential loss: ${totalPotentialLoss.toFixed(2)} ${
        market.split('/')[1].split(':')[0]
      }`
    );
    console.log(`Total risk/return ratio: ${totalRiskReturnRatio.toFixed(2)}`);
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
  ): Promise<any> {
    const order = await this.executeOrder(
      'createLimitBuyOrder',
      market,
      await this.getQuantityPrecision(market, quantity),
      price
    );
    return order;
  }

  async createLimitSellOrder(
    market: string,
    price: number,
    quantity: number
  ): Promise<any> {
    const order = await this.executeOrder(
      'createLimitSellOrder',
      market,
      await this.getQuantityPrecision(market, quantity),
      price
    );
    return order;
  }

  async editCurrentStopOrder(symbol: string, newStopPrice: number): Promise<string | undefined> {
    if (this.exchange === null) {
        console.error(
            `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching the stop order ID.`
        );
        return;
    }
    try {
        const openOrders = await this.exchange.fetchOpenOrders(symbol);
        const stopOrder = openOrders.find(
            (order) => (order as any).type.toLowerCase() === 'stop'
        );

        if (!stopOrder) {
          return undefined;
        } else {
          let params;

          // stopOrder = order as StopOrder;
          params = {
            // stopLossPrice: price, // only available on Deribit so far
            stopPrice: newStopPrice, // Phemex's property name for a stop order
            // reduce_only: true, // only available on Deribit so far
          }

          await this.exchange!.editOrder(
            stopOrder.id,
            symbol,
            'stop',
            stopOrder.side,
            stopOrder.amount,
            newStopPrice,
            params ? params : {}
          );
          return stopOrder.id;
        }
    } catch (error) {
        console.error(`[ExchangeClient] Failed to fetch stop order ID:`, error);
    }
  }

  async createStopOrder(
    market: string,
    price: number,
    quantity?: number
  ): Promise<void> {
    try {
      let side;
      const openOrders = await this.exchange!.fetchOpenOrders(market);
      const limitOrders = openOrders.filter((order) => order.type === 'limit');

      // If no quantity is provided, calculate the quantity based on open orders and position size
      if (!quantity) {
        // Get the position size for the given market
        quantity = await this.getPositionSize(market);

        // Calculate the total quantity of open limit orders
        const openOrdersQuantity = limitOrders.reduce((acc, order) => {
          return acc + order.remaining;
        }, 0);

        // Add the open limit orders quantity to the calculated position size
        if (openOrdersQuantity > 0) {
          quantity += openOrdersQuantity;
        }
      }

      // If there's a non-zero quantity, proceed with creating the stop order
      if (quantity > 0) {
        // Get limit orders only and determine their side if there are no open positions from which to determine the side
        const position = await this.getPositionStructure(market);

        if (position?.contracts !== undefined && position.contracts > 0) {
          side = position?.side === 'long' ? 'sell' : 'buy';
        } else if (limitOrders.length > 0) {
          side = limitOrders[0].side === 'buy' ? 'sell' : 'buy';
        } else {
          throw new Error(
            `Unable to determine side of stop order for market ${market}.`
          );
        }

        // Get the appropriate exchange parameters based on the current exchange
        const exchangeName = this.exchange!.id;
        const orderType =
          exchangeParams[exchangeName].orders.stopLoss.ORDER_TYPE;
        const stopLossProp =
          exchangeParams[exchangeName].orders.stopLoss.STOP_LOSS_PROP;
        const reduceOnlySupported =
          exchangeParams[exchangeName].orders.stopLoss.REDUCE_ONLY.SUPPORTED;
        const reduceOnlyProp =
          exchangeParams[exchangeName].orders.stopLoss.REDUCE_ONLY
            .REDUCE_ONLY_PROP || '';

        // Create an object for the order parameters, setting the stop loss price according to the appropriate property
        const params: { [key: string]: any } = {
          [stopLossProp]: price,
        };

        // If the reduce-only feature is supported by the exchange, add the corresponding property to the parameters object
        if (reduceOnlySupported) {
          params[reduceOnlyProp] = true;
        }

        // Adjust the quantity to match the exchange's precision requirements
        quantity = await this.getQuantityPrecision(market, quantity);

        // Execute the stop order with the provided details
        await this.executeOrder(
          'createOrder',
          market,
          orderType,
          side,
          quantity,
          price,
          params
        );
      } else {
        // If there's no position found, log an error message and return
        console.error(
          `[ExchangeClient] No positions found for ${market}. Please open a position before placing a stop order.`
        );
        return;
      }
    } catch (error) {
      // If any errors occur during the process, log the error message
      console.error(`[ExchangeClient] Failed to place order:`, error);
    }
  }
  async updateStopOrder(market: string, newAmount?: number): Promise<void> {
    try {
        const openOrders = await this.exchange?.fetchOpenOrders(market);
        const stopOrders = openOrders?.filter(order => order.type.toLowerCase().includes('stop'));
        if (stopOrders?.length === 0) {
          throw new Error('No active stop orders found.');
        } else if ((stopOrders?.length ?? 0) > 1) {
          throw new Error('Multiple stop orders found. Cannot update multiple stops.');
        }
        let order = stopOrders?.[0] as StopOrder
        let amountToUpdate = newAmount;

        if (!newAmount) {
          // Calculate quantity to be used for the stop order
          let positionSize = 0;
          const position = await this.getPositionStructure(market);
          if (position) {
            positionSize += position.contracts ?? 0;
          }

          const limitOrders = openOrders?.filter(order => order.type === 'limit') ?? [];
          const openOrdersQuantity = limitOrders.reduce((acc, order) => acc + order.remaining, 0);

          amountToUpdate = positionSize + openOrdersQuantity;
        }

        // check if amountToUpdate is defined and greater than zero
        if (!amountToUpdate || amountToUpdate <= 0) {
          throw new Error('Calculated quantity for stop order is zero or negative.');
        }

        try {
          await this.cancelAllStopOrders(market);
          await this.createStopOrder(market, order.stopPrice, amountToUpdate);
        } catch (error) {
          console.error(`[ExchangeClient] Failed to update stop order: ${error}`);
          throw error;
        }
    } catch (error) {
        console.error(`[ExchangeClient] Failed to update stop order: ${error}`);
        throw error;
    }
  }
}
