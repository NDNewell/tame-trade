import ccxt, { Exchange, Market } from 'ccxt';
import { ConfigManager } from '../config/configManager';

export class ExchangeClient {
  private static instance: ExchangeClient | null = null;
  private availableMarkets: Record<string, Market> | null = null;
  private supportedExchanges: string[] | null = null;
  exchange: Exchange | null = null;
  exchangeManager: ConfigManager;

  private constructor() {
    this.exchangeManager = new ConfigManager();
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
    }
    await this.loadExchanges();
    await this.loadMarkets();
  }

  isInitialized(): boolean {
    return this.supportedExchanges !== null;
  }

  async loadExchanges(): Promise<void> {
    this.supportedExchanges = ccxt.exchanges;
  }

  async loadMarkets(): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching instruments.`
      );
      return;
    }

    try {
      this.availableMarkets = await this.exchange.loadMarkets();
    } catch (error) {
      console.error(`[ExchangeClient] Failed to fetch instruments:`, error);
    }
  }

  async setExchange(exchangeId: string): Promise<void> {
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
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching instruments.`
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
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching instruments.`
      );
      return [];
    }

    if (this.availableMarkets !== null) {
      return Object.keys(this.availableMarkets);
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching instruments.`
      );
      return [];
    }
  }

  async getMarketByType(type: string): Promise<Array<string>> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before fetching instruments.`
      );
      return [];
    }

    if (this.availableMarkets !== null) {
      return Object.keys(this.availableMarkets).filter(
        (symbol) => this.availableMarkets![symbol].type === type
      );
    } else {
      console.error(
        `[ExchangeClient] Available markets not initialized. Please call 'init' or 'setExchange' before fetching instruments.`
      );
      return [];
    }
  }

  async executeOrder(
    method: string,
    instrument: string,
    ...args: any[]
  ): Promise<void> {
    if (this.exchange === null) {
      console.error(
        `[ExchangeClient] Exchange not initialized. Please call 'init' or 'setExchange' before placing an order.`
      );
      return;
    }

    try {
      const order = await (this.exchange as any)[method](instrument, ...args);
      const filledAmount = parseFloat(order.filled);
      const trimmedFilledAmount = filledAmount.toFixed(
        Math.max(
          2,
          filledAmount.toString().split('.')[1].replace(/0+$/, '').length
        )
      );
      const trimmedPrice = parseFloat(order.price).toFixed(2);
      console.log(`Filled ${trimmedFilledAmount} @${trimmedPrice}`);
    } catch (error) {
      console.error(`[ExchangeClient] Failed to place order:`, error);
    }
  }

  async createMarketBuyOrder(
    instrument: string,
    quantity: number
  ): Promise<void> {
    await this.executeOrder('createMarketBuyOrder', instrument, quantity);
  }

  async createMarketSellOrder(
    instrument: string,
    quantity: number
  ): Promise<void> {
    await this.executeOrder('createMarketSellOrder', instrument, quantity);
  }

  async createLimitBuyOrder(
    instrument: string,
    quantity: number,
    price: number
  ): Promise<void> {
    await this.executeOrder('createLimitBuyOrder', instrument, quantity, price);
  }

  async createLimitSellOrder(
    instrument: string,
    quantity: number,
    price: number
  ): Promise<void> {
    await this.executeOrder(
      'createLimitSellOrder',
      instrument,
      quantity,
      price
    );
  }

  async createStopOrder(
    instrument: string,
    stopPrice: number,
    quantity: number
  ): Promise<void> {
    await this.executeOrder('createStopOrder', instrument, stopPrice, quantity);
  }
}
