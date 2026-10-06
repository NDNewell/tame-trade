interface ExchangeStopLossOrderParams {
  ORDER_TYPE: string;
  STOP_LOSS_PROP: string;
  REDUCE_ONLY: {
    SUPPORTED: boolean;
    REDUCE_ONLY_PROP?: string;
  };
}

/**
 * How a take profit differs from a stop on this exchange. Everything not named
 * here -- reduce-only, sizing, the trigger source -- is shared with stopLoss.
 */
interface ExchangeTakeProfitOrderParams {
  ORDER_TYPE: string;
  TAKE_PROFIT_PROP: string;
}

interface ExchangeParams {
  [key: string]: {
    orders: {
      stopLoss: ExchangeStopLossOrderParams;
      takeProfit: ExchangeTakeProfitOrderParams;
    };
  };
}

enum OrderType {
  MARKET = 'market',
  STOP = 'stop',
  STOP_MARKET = 'stop_market',
  TAKE_MARKET = 'take_market',
}

enum StopLossProp {
  STOP_LOSS_PRICE = 'stopLossPrice',
  STOP_PRICE = 'stopPrice',
}

enum TakeProfitProp {
  TAKE_PROFIT_PRICE = 'takeProfitPrice',
  STOP_PRICE = 'stopPrice',
}

enum ReduceOnlyProp {
  REDUCE_ONLY = 'reduce_only',
  REDUCE_ONLY_CAMEL = 'reduceOnly',
  // Phemex rejects reduceOnly on a conditional order ('Stop cannot accept order
  // reduce only'). closeOnTrigger is the equivalent for trigger orders: it
  // implies reduce-only and cancels other orders in the same direction.
  CLOSE_ON_TRIGGER = 'closeOnTrigger',
}

export const exchangeParams: ExchangeParams = {
  deribit: {
    orders: {
      stopLoss: {
        ORDER_TYPE: OrderType.STOP_MARKET,
        STOP_LOSS_PROP: StopLossProp.STOP_LOSS_PRICE,
        REDUCE_ONLY: {
          SUPPORTED: true,
          REDUCE_ONLY_PROP: ReduceOnlyProp.REDUCE_ONLY,
        },
      },
      takeProfit: {
        ORDER_TYPE: OrderType.TAKE_MARKET,
        TAKE_PROFIT_PROP: TakeProfitProp.TAKE_PROFIT_PRICE,
      },
    },
  },
  phemex: {
    orders: {
      stopLoss: {
        // 'market' rather than 'stop': ccxt turns a market order carrying a
        // trigger price into the right Phemex order type (Stop when the trigger
        // is on the losing side, MarketIfTouched when it isn't). Passing 'stop'
        // bypassed that and forced ordType 'Stop' in every direction.
        ORDER_TYPE: OrderType.MARKET,
        STOP_LOSS_PROP: StopLossProp.STOP_PRICE,
        // Phemex stops must not carry reduceOnly -- the exchange rejects the
        // order outright with 'Stop cannot accept order reduce only'. Sending
        // nothing at all was also wrong: the stop was then an ordinary order
        // that could open an opposite position instead of closing the one held.
        // closeOnTrigger is the flag conditional orders take.
        REDUCE_ONLY: {
          SUPPORTED: true,
          REDUCE_ONLY_PROP: ReduceOnlyProp.CLOSE_ON_TRIGGER,
        },
      },
      // The same request as a stop. Phemex has no separate take-profit
      // parameter: a market order with a trigger on the winning side is what
      // ccxt turns into MarketIfTouched, chosen by triggerDirection.
      takeProfit: {
        ORDER_TYPE: OrderType.MARKET,
        TAKE_PROFIT_PROP: TakeProfitProp.STOP_PRICE,
      },
    },
  },
  hyperliquid: {
    orders: {
      stopLoss: {
        ORDER_TYPE: OrderType.STOP_MARKET,
        STOP_LOSS_PROP: StopLossProp.STOP_PRICE,
        REDUCE_ONLY: {
          SUPPORTED: false,
        },
      },
      // ccxt marks the trigger 'tp' rather than 'sl' only when the price
      // arrives as takeProfitPrice; any other key makes it a stop-loss.
      takeProfit: {
        ORDER_TYPE: OrderType.MARKET,
        TAKE_PROFIT_PROP: TakeProfitProp.TAKE_PROFIT_PRICE,
      },
    },
  },
};
