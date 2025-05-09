// src/exchange/exchangeClient.ts

import { pro as ccxtpro, Exchange, Market, Order } from 'ccxt';
import ccxt from 'ccxt';
import ora, { spinners } from 'ora';
import { ConfigManager } from '../config/configManager.js';
import { ErrorEvent, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { exchangeParams } from './exchangeParams.js';
import { parse } from 'path';
import readline from 'readline';

// Define a more flexible Position interface to handle ccxt's types
interface Position {
  symbol: string;
  contracts?: number | undefined;
  notional?: number | undefined;
  side: string | any; // Use any to accommodate ccxt's Str type
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
      (marketObj) => marketObj?.symbol === market
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
    const credentials = await this.exchangeManager.getExchangeCredentials(exchangeId);

    const exchangeConfig: any = {
      enableRateLimit: true,
      options: {
        defaultType: 'future',
        adjustForTimeDifference: true,
      }
    };

    if (exchangeId.toLowerCase() === 'hyperliquid') {
      if (!credentials.privateKey || !credentials.walletAddress) {
        throw new Error('Private key and wallet address are required for Hyperliquid');
      }
      exchangeConfig.privateKey = credentials.privateKey;
      exchangeConfig.walletAddress = credentials.walletAddress;
      exchangeConfig.publicAddress = credentials.publicAddress || credentials.walletAddress;
      exchangeConfig.options.defaultSlippage = 0.05;
    } else {
      if (!credentials.key || !credentials.secret) {
        throw new Error('API key and secret are required for this exchange');
      }
      exchangeConfig.apiKey = credentials.key;
      exchangeConfig.secret = credentials.secret;
    }

    this.exchange = new (ccxtpro as any)[exchangeId.toLowerCase()](exchangeConfig);

    await this.loadMarkets();
    await this.loadExchanges();
    this.setEventListeners();

    // Call the time synchronization method here
    await this.synchronizeTimeWithExchange();
  }

  async getMarketTypes(): Promise<string[]> {
    const availableTypes = new Set<string>();
    if (this.availableMarkets !== null) {
      Object.values(this.availableMarkets).forEach((market) => {
        if (market?.type) {
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
    return this.exchange ? String(this.exchange.name ?? '') : null;
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
        (symbol) => this.availableMarkets![symbol]?.type === type
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
    if (!marketInfo) {
      throw new Error(`Market ${market} not found.`);
    }
    const minTradeAmount = marketInfo.precision?.amount ?? 0;

    if (quantity < minTradeAmount) {
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

    // Extract potential postOnly flag and params from the end of args
    let finalParams: Record<string, any> = {};
    let postOnly = false;
    let originalArgs = [...args]; // Copy original args

    // Check if the last arg is a params object
    if (originalArgs.length > 0 && typeof originalArgs[originalArgs.length - 1] === 'object' && originalArgs[originalArgs.length - 1] !== null) {
        finalParams = { ...originalArgs.pop() }; // Pop and copy params object
    }

    // Check if the (new) last arg is the postOnly boolean
    if (originalArgs.length > 0 && typeof originalArgs[originalArgs.length - 1] === 'boolean') {
        postOnly = originalArgs.pop(); // Pop boolean
    }

    if (postOnly) {
        finalParams['postOnly'] = true;
    }

    try {
      // Special handling for Hyperliquid market orders (shouldn't apply to limit chase)
      if (this.exchange.id === 'hyperliquid' && method.includes('Market')) {
        const ticker = await this.exchange.fetchTicker(market);
        const currentPrice = ticker.last || 0;
        finalParams.price = currentPrice;
        finalParams.slippage = 0.05;
      }

      // Call the underlying exchange method with market, remaining original args, and the final combined params
      const order = await (this.exchange as any)[method](market, ...originalArgs, finalParams);

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
      // Special handling for Hyperliquid
      if (this.exchange.id === 'hyperliquid') {
        // Get the public wallet address from the exchange configuration for queries
        const walletAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;

        if (!walletAddress) {
          console.error(`[ExchangeClient] Wallet address not found in exchange configuration`);
          return positionStructure;
        }

        // Generate different symbol formats to try - for Hyperliquid the format is different
        const baseSymbol = symbol.split('/')[0]; // Get the base, e.g. "SOL" from "SOL/USDC:USDC"
        const symbolVariations = [
          baseSymbol,           // Just the base: SOL
          symbol,               // Original format: SOL/USDC:USDC
          `${baseSymbol}-USD`,  // SOL-USD
          `${baseSymbol}/USD`,  // SOL/USD
          `${baseSymbol}USD`,   // SOLUSD
        ];

        // Helper function to check if position has real data
        const isValidPosition = (pos: any): boolean => {
          if (!pos) return false;

          // Check if it's an empty object
          if (Object.keys(pos).length === 0) return false;

          // Check if it has essential position properties
          if (!pos.symbol) return false;

          // If we have contracts, side, or entryPrice, it's likely valid
          if (pos.contracts !== undefined && pos.contracts !== 0) return true;
          if (pos.side && pos.side !== '') return true;
          if (pos.entryPrice) return true;

          return false;
        };

        try {
          // Try to fetch account balance for this user which might include position info
          try {
            const balanceParams = { 'user': walletAddress };
            const balance = await this.exchange.fetchBalance(balanceParams);

            // Check if there's position info in the balance
            if (balance && balance.info && balance.info.positions) {
              const positions = balance.info.positions;
              for (const pos of positions) {
                const posCoin = String(pos.coin || '').toLowerCase();
                const baseSymbolLower = baseSymbol.toLowerCase();

                if (posCoin === baseSymbolLower) {
                  // Convert to our Position structure
                  positionStructure = {
                    symbol: baseSymbol,
                    contracts: Number(pos.szi || 0),
                    notional: Number(pos.notional || 0),
                    side: Number(pos.szi || 0) > 0 ? 'long' : (Number(pos.szi || 0) < 0 ? 'short' : ''),
                    entryPrice: Number(pos.entryPx || 0)
                  };

                  return positionStructure;
                }
              }
            }
          } catch (error) {
            console.error(`[ExchangeClient] Error fetching balance:`, (error as Error).message);
          }

          // First try the direct fetchPosition method with each symbol variation
          for (const symVar of symbolVariations) {
            try {
              const params = { 'user': walletAddress };
              const position = await this.exchange.fetchPosition(symVar, params);

              if (position && isValidPosition(position)) {
                return position;
              }
            } catch (error) {
              // Suppress individual symbol errors
            }
          }

          // If direct fetching fails, try fetchPositions which gets all positions
          try {
            const params = { 'user': walletAddress };
            const allPositions = await this.exchange.fetchPositions(undefined, params);

            if (allPositions && allPositions.length > 0) {
              // Try to match by symbol, preferring an exact match with the input symbol or base symbol
              const targetSymbols = [
                symbol, // Original symbol first (e.g., SOL/USDC:USDC)
                baseSymbol, // Base symbol (e.g., SOL)
                // Add other common variations if necessary, but be specific
              ];

              for (const tSymbol of targetSymbols) {
                const foundPosition = allPositions.find(p => p.symbol && p.symbol.toLowerCase() === tSymbol.toLowerCase() && isValidPosition(p));
                if (foundPosition) {
                  return foundPosition; // Return the first exact match found
                }
              }

              // Stricter fallback: only if a position explicitly contains the baseSymbol AND has contracts
              // This avoids returning an unrelated active position if the target market has no position.
              const fallbackPosition = allPositions.find(p =>
                p.symbol && p.symbol.toLowerCase().includes(baseSymbol.toLowerCase()) &&
                isValidPosition(p) &&
                (p.contracts !== undefined && p.contracts !== 0) // Ensure it's an actual position
              );
              if (fallbackPosition) {
                // Before returning a fallback, log a warning if its symbol isn't an exact match
                if (!targetSymbols.some(ts => ts.toLowerCase() === fallbackPosition.symbol.toLowerCase())) {
                    console.warn(`[ExchangeClient/getPositionStructure] Hyperliquid: No exact symbol match for ${symbol}. ` +
                                 `Returning fallback position for ${fallbackPosition.symbol} as it includes base ${baseSymbol} and has contracts.`);
                }
                return fallbackPosition;
              }
            }
          } catch (error) {
            console.error(`[ExchangeClient] Error fetching positions:`, (error as Error).message);
          }
        } catch (error) {
          console.error(`[ExchangeClient] Error with wallet address ${walletAddress}:`, (error as Error).message);
        }

        console.log(`[ExchangeClient] No valid positions found for ${symbol}`);
        return positionStructure;
      }

      // Standard handling for other exchanges
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
    let hyperliquidParams: { user?: string } = {};
    const isHyperliquid = this.exchange?.id === 'hyperliquid';

    if (isHyperliquid) {
      const publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
      if (!publicAddress) {
        throw new Error('[ExchangeClient/cancelOrdersByDirection] Hyperliquid requires publicAddress.');
      }
      hyperliquidParams = { 'user': publicAddress };
    }

    // Fetch the orders from the market symbol, including user param for Hyperliquid
    const openOrders = await this.exchange!.fetchOpenOrders(market, undefined, undefined, isHyperliquid ? hyperliquidParams : undefined);

    // Filter to get only relevant limit orders
    const limitOrdersToConsider = openOrders.filter((order) => {
      if (isHyperliquid) {
        const isBasicLimit = order.type === 'limit' ||
                             (order.info && (order.info.orderType === 'Limit' || order.info.orderType === 'LimitOrder'));
        const isNotTrigger = order.info?.isTrigger !== true &&
                             order.info?.orderType !== 'Stop Limit' &&
                             order.info?.orderType !== 'Trigger' &&
                             order.info?.orderType !== 'StopMarket';
        return isBasicLimit && isNotTrigger;
      } else {
        // Original filter for non-Hyperliquid exchanges: effectively, non-stop orders
        return order.type?.toLowerCase() !== 'stop';
      }
    });

    // Sort orders by price depending on the direction
    const sortedOrders =
      direction === 'bottom'
        ? limitOrdersToConsider.sort((a, b) => a.price - b.price)
        : limitOrdersToConsider.sort((a, b) => b.price - a.price);

    // Determine the range of orders to be canceled
    let start = rangeStart ? rangeStart - 1 : 0; // rangeStart is 1-indexed from user
    let end = rangeEnd ? rangeEnd : sortedOrders.length;

    // Slice the orders array based on the determined range
    const ordersToCancel = sortedOrders.slice(start, end);

    // Cancel the orders within the range
    if (ordersToCancel.length > 0) {
      const cancelPromises = ordersToCancel.map((order) =>
        this.exchange!.cancelOrder(order.id, market, isHyperliquid ? hyperliquidParams : undefined)
      );
      await Promise.all(cancelPromises);
      console.log(`${ordersToCancel.length} limit orders have been canceled.`);
    } else {
      console.log('No matching limit orders found to cancel.');
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    this.cancelAllStopOrders(symbol);
    this.cancelAllLimitOrders(symbol);
  }

  async cancelAllLimitOrders(symbol: string): Promise<void> {
    try {
      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // Fetch open orders with wallet address for Hyperliquid
      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined,
        walletAddress ? { 'user': walletAddress } : undefined);

      // Filter orders to obtain only limit orders
      const limitOrders = openOrders.filter((order) => {
        // For Hyperliquid, check both standard limit orders and Hyperliquid's specific limit order types
        if (this.exchange!.id === 'hyperliquid') {
          const isBasicLimit = order.type === 'limit' ||
                               (order.info && (order.info.orderType === 'Limit' || order.info.orderType === 'LimitOrder'));
          // Ensure it's not a trigger order (like stop-limit)
          const isNotTrigger = order.info?.isTrigger !== true &&
                               order.info?.orderType !== 'Stop Limit' &&
                               order.info?.orderType !== 'Trigger' &&
                               order.info?.orderType !== 'StopMarket';
          return isBasicLimit && isNotTrigger;
        }
        return order.type === 'limit';
      });

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
      console.error('Error cancelling limit orders:', error);
    }
  }

  async cancelAllStopOrders(symbol: string): Promise<void> {
    try {
      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // For Hyperliquid, we need to use the public wallet address to fetch orders
      const params = walletAddress ? { 'user': walletAddress } : undefined;

      // Fetch open orders with wallet address for Hyperliquid
      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined, params);

      let stopOrders = [];

      // For Hyperliquid, check for both standard stop orders and Hyperliquid's specific stop order types
      if (this.exchange!.id === 'hyperliquid') {
        stopOrders = openOrders.filter(
          (order) => {
            return order.type === 'stop' ||
                   order.info?.orderType === 'Stop Limit' ||
                   order.info?.orderType === 'Trigger' ||
                   order.info?.orderType === 'StopMarket' ||
                   (order.info?.isTrigger === true);
          }
        );
      } else {
        // For other exchanges, use standard stop order detection
        stopOrders = openOrders.filter(
          (order) =>
            order.type === 'stop' ||
            order.info?.order_type === 'stop_market'
        );
      }

      if (stopOrders.length > 0) {
        const cancelPromises = stopOrders.map((order) =>
          this.exchange!.cancelOrder(order.id, symbol, params)
        );
        await Promise.all(cancelPromises);
      }
    } catch (error) {
      console.error('Error cancelling stop orders:', error);
    }
  }

  async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cancelChaseOrder(orderId: string, market: string, params?: Record<string, any>): Promise<void> {
    // Always set the active flag to false when cancellation is attempted
    this.chaseLimitOrderActive = false;
    try {
      await this.exchange!.cancelOrder(orderId, market, params);
    } catch (error: any) {
        // Check if it's a benign OrderNotFound error
        const errorMessage = String(error.message || '');
        const isOrderNotFound = errorMessage.includes('OrderNotFound') ||
                                errorMessage.includes('Order was never placed, already canceled, or filled');

        if (isOrderNotFound) {
            // Log simplified warning or omit if preferred
            // console.warn(`[cancelChaseOrder] Attempted to cancel chase order ${orderId}, but it was likely already finalized.`);
        } else {
            // Log other errors as actual problems
            console.error('Error cancelling chase order:', error);
            // Optionally re-throw if needed downstream
            // throw error;
        }
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
    if (!this.exchange) { throw new Error('Exchange not initialized'); }
    this.chaseLimitOrderActive = true;

    // --- Hyperliquid Params ---
    let params: Record<string, any> | undefined = undefined;
    if (this.getExchangeId() === 'hyperliquid') {
        const publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
        if (!publicAddress) {
          throw new Error('[ExchangeClient/chaseLimitOrder] Hyperliquid requires publicAddress.');
        }
        params = { 'user': publicAddress };
        // Use Add Liquidity Only TIF for initial placement instead of postOnly flag
        params.timeInForce = 'Alo';
    }
    // --- End Hyperliquid Params ---

    const orderBook = await this.exchange!.fetchL2OrderBook(market);
    const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0][0] : 0;
    const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0][0] : Infinity;

    // Use best bid/ask directly, rely on TIF: Alo in params
    const initialPrice = side === 'buy' ? bestBid : bestAsk;
    if (!isFinite(initialPrice) || initialPrice <= 0) {
        // Basic validation, might need refinement
        throw new Error(`Invalid initial best price calculated: ${initialPrice}`);
    }

    // Pass params (containing TIF: Alo for Hyperliquid) AND postOnly: true flag
    const order = await (side === 'buy'
      ? await this.createLimitBuyOrder(market, initialPrice, amount, params, true)
      : await this.createLimitSellOrder(market, initialPrice, amount, params, true));

    if (!order) {
      console.log('Order filled immediately');
      this.chaseLimitOrderActive = false;
      return;
    }

    // Use let instead of const to allow potential reassignment after edits
    let orderId = order.id;
    let remainingAmount = amount;

    const executeChaseOrder = async () => {
      // Pass params to fetchOpenOrders
      const openOrders = await this.exchange!.fetchOpenOrders(market, undefined, undefined, params);
      const order = openOrders.find((o) => o.id === orderId);

      if (!order) {
        if (this.chaseLimitOrderActive) {
          this.logAndReplace(`Chase ${side} order filled for ${amount} ${market}`);
          this.chaseLimitOrderActive = false;
        } else {
          this.logAndReplace(`Chase ${side} order cancelled for ${amount} ${market}`);
        }
        return;
      }

      const updatedOrderBook = await this.exchange!.fetchL2OrderBook(market);
      const updatedBestPrice =
        side === 'buy'
          ? updatedOrderBook.bids[0][0]
          : updatedOrderBook.asks[0][0];

      try {
        if (
          (side === 'buy' && updatedBestPrice > order.price) ||
          (side === 'sell' && updatedBestPrice < order.price)
        ) {
          // Pass params to editOrder
          const editResult = await this.editOrder(
            orderId,
            market,
            'limit',
            updatedBestPrice,
            order.remaining,
            params // Pass Hyperliquid params here
          );

          // Check if the order ID changed after edit (esp. for cancel/replace exchanges)
          if (editResult && editResult.id !== orderId) {
            orderId = editResult.id; // Update orderId for subsequent checks
          }
        }
      } catch (error) {
        // Suppress the error output
        // Optionally, you can log the error to a file or handle it in another way
      }

      remainingAmount = order.remaining;

      if (remainingAmount > 0) {
        // Use a longer interval for Hyperliquid due to higher latency
        const chaseInterval = this.getExchangeId() === 'hyperliquid' ? 1500 : 100;
        setTimeout(executeChaseOrder, chaseInterval);
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
          // Pass params to cancelChaseOrder
          this.cancelChaseOrder(orderId, market, params);
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
    quantity?: number,
    params?: Record<string, any>
  ): Promise<Order | undefined> {
    try {
      // Pass params to fetchOrders for exchanges like Hyperliquid that require user context
      const orders = await this.exchange!.fetchOrders(symbol, undefined, undefined, params);
      let order = orders.find((order) => order.id === orderId);

      if (!order) {
        throw new Error(`Order with id ${orderId} not found`);
      }

      // If quantity is not provided, use the order's amount
      quantity = quantity !== undefined ? quantity : order.amount;

      const editedOrder = await this.exchange!.editOrder(
        order.id,
        symbol,
        orderType,
        String(order.side ?? ''),
        quantity,
        price,
        params
      );
      // Return the result of the exchange edit call
      return editedOrder;
    } catch (error) {
      // console.error('Error editing order:', error);
      // This has been disabled for now since it keeps throwing an error and polluting the console
      throw error;
    }
  }

  async bumpOrders(symbol: string, priceChange: number): Promise<void> {
    try {
      let hyperliquidParams: { user?: string } = {};
      let isHyperliquid = this.exchange?.id === 'hyperliquid';

      if (isHyperliquid) {
        const publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
        if (!publicAddress) {
          throw new Error('[ExchangeClient/bumpOrders] Hyperliquid requires publicAddress for bumping orders.');
        }
        hyperliquidParams = { 'user': publicAddress };
      }

      const openOrders = await this.exchange!.fetchOpenOrders(symbol, undefined, undefined, isHyperliquid ? hyperliquidParams : undefined);

      if (openOrders.length > 0) {
        for (const order of openOrders) {
          const orderType = order.type?.toLowerCase() ?? '';
          let newPrice: number | undefined;

          if (isHyperliquid) {
            // Hyperliquid-specific logic
            if (orderType.includes('stop') || order.info?.isTrigger === true || order.info?.orderType?.toLowerCase().includes('stop')) {
              const currentStopPrice = order.stopPrice ?? order.price;
              if (currentStopPrice === undefined) {
                continue;
              }
              newPrice = currentStopPrice + priceChange;
              await this.updateStopOrder(symbol, order.amount, newPrice);
            } else if (orderType === 'limit') {
              newPrice = order.price + priceChange;
              await this.exchange!.editOrder(
                order.id,
                symbol,
                orderType, // 'limit'
                String(order.side ?? ''),
                order.amount,
                newPrice,
                hyperliquidParams
              );
            } else {
              // console.warn(`[ExchangeClient/bumpOrders] Hyperliquid: Skipping unsupported order type '${orderType}' for order ${order.id}`); // Removed log
            }
          } else {
            // Original logic for other exchanges (restored)
            let paramsForEdit: Record<string, any> | undefined = undefined; // Keep it undefined initially
            let originalNewPrice: number | undefined = undefined;

            if (orderType === 'stop') {
              const stopOrder = order as StopOrder;
              if (typeof stopOrder.stopPrice === 'number') {
                originalNewPrice = stopOrder.stopPrice + priceChange;
                // For non-Hyperliquid stop orders, params for editOrder might be needed by CCXT implicitly or explicitly by exchange
                // The original code example for Phemex used params = { stopPrice: newPrice }
                // A generic approach might be to ensure the trigger price field is in params if needed.
                // For ccxt unified editOrder, it often expects the new stop price as the main price argument for stop orders,
                // or within params if the exchange requires it differently. We'll pass it as main price for now.
                paramsForEdit = { [exchangeParams[this.exchange!.id]?.orders.stopLoss.STOP_LOSS_PROP || 'stopPrice']: originalNewPrice };
              } else {
                 console.warn(`[ExchangeClient/bumpOrders] Non-Hyperliquid: Order ${order.id} is type 'stop' but has no valid stopPrice. Skipping.`);
                 continue;
              }
            } else if (orderType === 'limit') {
              originalNewPrice = order.price + priceChange;
              // No special params typically needed for limit order price changes beyond the price itself.
            } else {
                console.warn(`[ExchangeClient/bumpOrders] Non-Hyperliquid: Skipping unsupported order type '${orderType}' for order ${order.id}`);
                continue;
            }

            if (originalNewPrice !== undefined) {
                console.log(`[ExchangeClient/bumpOrders] Non-Hyperliquid: Bumping ${orderType} order ${order.id} to ${originalNewPrice}`);
                await this.exchange!.editOrder(
                    order.id,
                    symbol,
                    orderType,
                    String(order.side ?? ''),
                    order.amount,
                    originalNewPrice, // Pass the new price directly
                    paramsForEdit // Pass specific params if any (like for stop orders)
                );
            }
          }
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
      // Safely check position side - convert to string and compare
      const positionSide = String(position.side || '');
      const side = positionSide === 'long' ? 'sell' : 'buy';

      if (typeof position.contracts === 'number') {
        quantity = Math.abs(position.contracts);
      } else {
        throw new Error('Position size is not defined');
      }

      if (quantity > 0) {
        // Special handling for Hyperliquid market orders
        if (this.exchange.id === 'hyperliquid') {
          // Get current market price
          const ticker = await this.exchange.fetchTicker(market);
          const currentPrice = ticker.last || 0;

          // Add a buffer to ensure the order executes immediately
          const adjustedPrice = side === 'buy' ? currentPrice * 1.05 : currentPrice * 0.95;

          // Create a limit order that behaves like a market order
          await this.executeOrder(
            side === 'buy' ? 'createLimitBuyOrder' : 'createLimitSellOrder',
            market,
            await this.getQuantityPrecision(market, quantity),
            adjustedPrice
          );
        } else {
          await this.executeOrder(
            'createMarketOrder',
            market,
            side,
            await this.getQuantityPrecision(market, quantity)
          );
        }
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
    return Math.abs(takeProfitPrice - entryPrice) / Math.abs(entryPrice - stopPrice);
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
    if (this.exchange?.id === 'hyperliquid') {
      // For Hyperliquid, create a "limit" order that behaves like a market order
      const ticker = await this.exchange.fetchTicker(market);
      const currentPrice = ticker.last || 0; // Add default value to avoid undefined

      // Add a buffer to ensure the order executes immediately
      const adjustedPrice = currentPrice * 1.05; // 5% above market price

      // Create a limit order with post-only=false to ensure it executes immediately
      await this.createLimitBuyOrder(
        market,
        adjustedPrice,
        await this.getQuantityPrecision(market, quantity)
      );
    } else {
      await this.executeOrder(
        'createMarketBuyOrder',
        market,
        await this.getQuantityPrecision(market, quantity)
      );
    }
  }

  async createMarketSellOrder(market: string, quantity: number): Promise<void> {
    if (this.exchange?.id === 'hyperliquid') {
      // For Hyperliquid, create a "limit" order that behaves like a market order
      const ticker = await this.exchange.fetchTicker(market);
      const currentPrice = ticker.last || 0; // Add default value to avoid undefined

      // Add a buffer to ensure the order executes immediately
      const adjustedPrice = currentPrice * 0.95; // 5% below market price

      // Create a limit order with post-only=false to ensure it executes immediately
      await this.createLimitSellOrder(
        market,
        adjustedPrice,
        await this.getQuantityPrecision(market, quantity)
      );
    } else {
      await this.executeOrder(
        'createMarketSellOrder',
        market,
        await this.getQuantityPrecision(market, quantity)
      );
    }
  }

  async createLimitBuyOrder(
    market: string,
    price: number,
    quantity: number,
    params?: Record<string, any>,
    postOnly?: boolean
  ): Promise<any> {
    const order = await this.executeOrder(
      'createLimitBuyOrder',
      market,
      await this.getQuantityPrecision(market, quantity),
      price,
      postOnly,
      params
    );
    return order;
  }

  async createLimitSellOrder(
    market: string,
    price: number,
    quantity: number,
    params?: Record<string, any>,
    postOnly?: boolean
  ): Promise<any> {
    const order = await this.executeOrder(
      'createLimitSellOrder',
      market,
      await this.getQuantityPrecision(market, quantity),
      price,
      postOnly,
      params
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

    // --- Hyperliquid Handling ---
    if (this.getExchangeId() === 'hyperliquid') {
        try {
            // For Hyperliquid, use the cancel/replace strategy via updateStopOrder
            // Capture and return the new order ID from updateStopOrder
            const newOrderId = await this.updateStopOrder(symbol, undefined, newStopPrice);
            return newOrderId;
        } catch (error) {
            console.error(`[ExchangeClient] Failed to update stop order for Hyperliquid via editCurrentStopOrder:`, error);
            // Re-throw or return undefined based on desired error handling
            throw error;
        }
    }

    // --- Original Logic for Other Exchanges ---
    try {
        // Original fetch without params - might need adjustment if other exchanges require user context here too
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
            String(stopOrder.side ?? ''),
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

  // Helper method to calculate default stop amount
  private async _calculateDefaultStopAmount(market: string): Promise<number> {
    // Get public wallet address from exchange config for Hyperliquid
    const publicAddress = this.exchange?.id === 'hyperliquid' ?
      (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

    // Fetch open orders, potentially with user filter for Hyperliquid
    const openOrders = await this.exchange!.fetchOpenOrders(market, undefined, undefined,
        publicAddress ? { 'user': publicAddress } : undefined);

    // Filter to only include limit orders, excluding stop/market orders
    // This logic might need refinement based on exact CCXT/Hyperliquid behavior
    const limitOrders = openOrders?.filter((order) => {
        const isLimit = order.type === 'limit' || (order.info && order.info.orderType === 'Limit');
        // Refined check to explicitly exclude known stop/trigger types
        const isNotStopTrigger = !(order.type?.toLowerCase().includes('stop') ||
                                 order.info?.type === 'trigger' ||
                                 order.info?.orderType === 'StopMarket' ||
                                 order.info?.orderType === 'Stop Limit' ||
                                 order.info?.isTrigger === true);
        return isLimit && isNotStopTrigger;
    });

    // Get the position size for the given market
    const position = await this.getPositionStructure(market);
    // Ensure positionSize is non-negative
    const positionSize = Math.abs(position?.contracts ?? 0);

    // Calculate the total quantity of open limit orders
    const openOrdersQuantity = limitOrders?.reduce((acc, order) => {
        // Ensure order.remaining is treated as a number
        return acc + (order.remaining ?? 0);
    }, 0) ?? 0;

    // Total quantity is position size plus open limit orders quantity
    let quantity = positionSize;
    if (openOrdersQuantity > 0) {
        quantity += openOrdersQuantity;
    }
    return quantity;
  }

  async createStopOrder(
    market: string,
    price: number,
    quantity?: number,
    suppressLog?: boolean
  ): Promise<Order | undefined> {
    if (!this.exchange) {
        console.error('[ExchangeClient/createStopOrder] Exchange not initialized.');
        return undefined;
    }
    try {
      // Format price according to market precision
      const marketInfo = this.availableMarkets![market];
      if (!marketInfo || !marketInfo.precision || marketInfo.precision.price === undefined) {
        throw new Error(`Market ${market} precision info not found`);
      }
      // Format price to required decimal places
      price = Number(price.toFixed(Math.abs(Math.log10(marketInfo.precision.price))));

      let side;

      // Get public wallet address from exchange config for Hyperliquid
      const walletAddress = this.exchange?.id === 'hyperliquid' ?
        (this.exchange as any).publicAddress || (this.exchange as any).walletAddress : undefined;

      // Fetch open orders needed for side determination if quantity is calculated
      const openOrders = await this.exchange!.fetchOpenOrders(market, undefined, undefined,
        walletAddress ? { 'user': walletAddress } : undefined);

       // Filter to only include limit orders, excluding stop/market orders (needed for side calculation)
      const limitOrders = openOrders?.filter((order) => {
          const isLimit = order.type === 'limit' || (order.info && order.info.orderType === 'Limit');
          const isNotStopTrigger = !(order.type?.toLowerCase().includes('stop') ||
                                   order.info?.type === 'trigger' ||
                                   order.info?.orderType === 'StopMarket' ||
                                   order.info?.orderType === 'Stop Limit' ||
                                   order.info?.isTrigger === true);
          return isLimit && isNotStopTrigger;
      });

      // If no quantity is provided, calculate it using the helper method
      if (quantity === undefined) {
         quantity = await this._calculateDefaultStopAmount(market);
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
          // Get current market price to determine side
          const ticker = await this.exchange!.fetchTicker(market);
          const currentPrice = ticker.last || 0;

          // If stop price is below current price, it's a sell stop
          // If stop price is above current price, it's a buy stop
          side = price < currentPrice ? 'sell' : 'buy';
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

        // Special handling for Hyperliquid stop orders
        if (this.exchange!.id === 'hyperliquid') {
          // Add any specific parameters needed for Hyperliquid stop orders
          params.trigger = 'ByLastPrice'; // Assuming this is the default trigger type for Hyperliquid

          // Add the wallet address parameter for Hyperliquid if available
          if (walletAddress) {
            params.user = walletAddress;
          }
        }

        // Add triggerDirection for Phemex stop orders
        if (this.exchange!.id === 'phemex') {
          // For sell stops, trigger when price goes down (2)
          // For buy stops, trigger when price goes up (1)
          params.triggerDirection = side === 'sell' ? 2 : 1; // Phemex requires 1 (up) or 2 (down)
          params.trigger = 'ByLastPrice'; // Explicitly set trigger type for Phemex
        }

        // If the reduce-only feature is supported by the exchange, add the corresponding property to the parameters object
        if (reduceOnlySupported) {
          params[reduceOnlyProp] = true;
        }

        // Adjust the quantity to match the exchange's precision requirements
        quantity = await this.getQuantityPrecision(market, quantity);

        // --- Adjust parameters for Hyperliquid Stop Market ---
        let finalOrderType = orderType;
        let finalPriceArg: number | undefined = price; // Initialize with the stop price
        let finalParams = { ...params };

        if (this.exchange.id === 'hyperliquid') {
            finalOrderType = 'market'; // Use market type for stop-market
            finalPriceArg = price; // Pass the trigger price as the main price argument for slippage calculation
            if (!finalParams.triggerPrice) finalParams.triggerPrice = price;
            finalParams.reduceOnly = true;
        } else if (finalOrderType.toLowerCase() === 'stop') {
            // For Phemex (and potentially other exchanges where 'Stop' means stop-market),
            // the main price argument for createOrder should be undefined.
            // The trigger price is already in finalParams.stopPx (or equivalent).
            finalPriceArg = undefined;
        }
        // --- End Hyperliquid Adjustment ---

        // Execute the stop order and get the created order object
        const createdOrder = await this.executeOrder(
          'createOrder',
          market,
          finalOrderType, // Use adjusted type
          side,
          quantity,
          finalPriceArg, // Use adjusted price arg (potentially undefined for Phemex stop-market)
          finalParams // Use adjusted params
        );

        // Only log and return if the order was successfully created
        if (createdOrder) {
          if (!suppressLog) {
              console.log(`Stop order placed at ${price} for ${quantity} ${market}`);
          }
          return createdOrder;
        } else {
          // executeOrder already logs specific errors, so we just return undefined
          return undefined;
        }
      } else {
        // If there's no position found, log an error message and return undefined
        console.error(
          `[ExchangeClient] No positions or open orders found to determine quantity/side for market ${market}. Cannot create stop order.`
        );
        return undefined; // Return undefined if order not created
      }
    } catch (error) {
      // If any errors occur during the process, log the error message
      console.error(`[ExchangeClient] Failed to place order:`, error);
      return undefined; // Return undefined on error
    }
  }

  async updateStopOrder(
    market: string,
    newAmount?: number,
    newStopPrice?: number
  ): Promise<string | undefined> {
    if (!this.exchange) {
      throw new Error('Exchange not initialized');
    }
    let newOrderId: string | undefined = undefined;

    try {
      let params: Record<string, any> = {};
      let publicAddress: string | undefined;

      // Hyperliquid specific logic: requires publicAddress
      if (this.exchange.id === 'hyperliquid') {
        publicAddress = (this.exchange as any).publicAddress || (this.exchange as any).walletAddress;
        if (!publicAddress) {
          throw new Error('[ExchangeClient] Hyperliquid requires publicAddress (or walletAddress) for fetching/editing orders.');
        }
        // Use 'user' as the key for Hyperliquid params, matching other methods
        params = { 'user': publicAddress };
      }

      const openOrders = await this.exchange.fetchOpenOrders(market, undefined, undefined, params);

      // Find the stop order (using Hyperliquid-specific checks if necessary)
      const stopOrder = openOrders.find(order => {
        const isStop = order.type?.toLowerCase().includes('stop');
        if (this.exchange?.id === 'hyperliquid') {
          return isStop ||
                 order.info?.type === 'trigger' ||
                 order.info?.orderType === 'StopMarket' ||
                 order.info?.orderType === 'Stop Limit' || // Added 'Stop Limit'
                 order.info?.isTrigger === true;
        } else {
          return isStop;
        }
      });

      if (!stopOrder) {
        console.warn(`[ExchangeClient] No open stop order found for ${market} to update.`);
        return;
      }

      // Ensure the found stop order has a stop price defined before proceeding
      if (stopOrder.stopPrice === undefined) {
        console.error(`[ExchangeClient] Found stop order ${stopOrder.id} for ${market}, but its stopPrice is undefined. Cannot update.`);
        return;
      }

      // Determine the final amount
      let finalAmount: number;
      if (newAmount !== undefined) {
        finalAmount = await this.getQuantityPrecision(market, newAmount);
      } else {
        // If newAmount is not provided, calculate the default amount using the helper
        finalAmount = await this._calculateDefaultStopAmount(market);
        finalAmount = await this.getQuantityPrecision(market, finalAmount); // Apply precision
      }

      // Determine the final stop price
      // Use existing stop price if newStopPrice is not provided
      const finalStopPrice: number = newStopPrice !== undefined ? newStopPrice : stopOrder.stopPrice;

      // Validate the calculated/provided final amount
      if (finalAmount <= 0) {
        console.warn(`[ExchangeClient] Calculated/Provided amount (${finalAmount}) is zero or negative. Cannot update stop order ${stopOrder.id}.`);
        // If only price was provided, maybe allow price-only update?
        // Current logic requires a valid amount to proceed.
        // Consider if a price-only update makes sense when amount becomes invalid.
        if (newAmount === undefined && newStopPrice !== undefined && stopOrder.amount > 0) {
             // Attempt price-only update if original amount was valid and new amount calculation failed
             this.logAndReplace(`Calculated amount is invalid (${finalAmount}), attempting to update price only for stop order ${stopOrder.id} to ${finalStopPrice}`);
              await this.editOrder(
                 stopOrder.id,
                 market,
                 stopOrder.type ?? 'limit',
                 finalStopPrice,
                 stopOrder.amount, // Use original amount
                 params
              );
              this.logAndReplace(`Updated stop order ${stopOrder.id} price to ${finalStopPrice}`);
        } else {
             console.warn(`[ExchangeClient] Invalid amount (${finalAmount}) prevents update for stop order ${stopOrder.id}.`);
        }
        return; // Exit if amount is invalid
      }

       // Parameters for cancel/create (mainly the user ID for Hyperliquid)
      let cancelReplaceParams: Record<string, any> = { ...params }; // Copy base params (like user)

      // --- Always use Cancel/Replace Logic ---
      try {
          // 1. Cancel the existing order
          await this.exchange.cancelOrder(stopOrder.id, market, cancelReplaceParams);

          // 2. Create a new stop order and capture the result
          const newOrder = await this.createStopOrder(market, finalStopPrice, finalAmount, true);
          newOrderId = newOrder?.id; // Store the new order ID

      } catch (replaceError) {
          console.error(`[ExchangeClient] Error during cancel/replace:`, replaceError);
          // Rethrow or handle - potentially the cancel succeeded but create failed, leaving no stop.
          throw replaceError;
      }

    } catch (error: any) {
        if (error.message && error.message.includes('Order not found')) {
            console.warn(`[ExchangeClient] Attempted to update stop order ${market}, but it might have been filled or cancelled.`);
        } else {
            console.error(`[ExchangeClient] Failed to update stop order for ${market}:`, error);
            // Potentially re-throw or handle specific errors differently
             throw error;
        }
    }
    return newOrderId; // Return the ID of the new order (or undefined)
  }

  async synchronizeTimeWithExchange() {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before synchronizing time.`
      );
      return;
    }

    // Check if the exchange supports the fetchTime method
    if (!this.exchange.has['fetchTime']) {
      console.log(`[ExchangeClient] fetchTime not supported by ${this.exchange.name}.`);
      return;
    }

    try {
      const serverTime = await this.exchange.fetchTime() ?? 0;
      const localTime = Date.now();
      const timeDifference = serverTime - localTime;

      // Synchronize time if there is any difference
      if (timeDifference !== 0) {
        // Adjust the exchange's API object to account for the time difference
        this.exchange.options.adjustForTimeDifference = true;
        this.exchange.options.timeDifference = timeDifference;

        console.log(`Time synchronized with exchange. Time difference: ${timeDifference} ms`);
      } else {
        console.log(`No need to synchronize time. Time difference: ${timeDifference} ms`);
      }
    } catch (error) {
      console.error(`[ExchangeClient] Failed to synchronize time with exchange:`, error);
    }
  }

  // Getter for the current exchange ID
  public getExchangeId(): string | undefined {
    return this.exchange?.id;
  }

  // Helper to get market price tick size
  private getMarketPriceTickSize(marketSymbol: string): number {
    if (!this.availableMarkets) {
        console.warn('[ExchangeClient] Markets not loaded, cannot get tick size. Defaulting to small value.');
        // Return a reasonably small default if markets aren't loaded
        // This might need adjustment based on typical market values
        return 0.01;
    }
    const marketInfo = this.availableMarkets[marketSymbol];
    if (!marketInfo || !marketInfo.precision || marketInfo.precision.price === undefined) {
        console.warn(`[ExchangeClient] Precision info not found for ${marketSymbol}. Defaulting to small value.`);
        return 0.01;
    }
    // ccxt stores precision as 1 / tickSize (e.g., 0.01 precision means tick size of 100 is wrong) -> needs tickSize directly if available, or calculate
    // Let's assume marketInfo.precision.price IS the tick size for now, which is common.
    // If errors persist, investigate if ccxt provides tickSize differently for this exchange.
    return marketInfo.precision.price;
  }

  // --- REMOVE Temporary Latency Ping Method --- START
  /*
  async pingExchangeLatency(numPings: number = 10): Promise<number> { ... }
  */
  // --- REMOVE Temporary Latency Ping Method --- END
}
