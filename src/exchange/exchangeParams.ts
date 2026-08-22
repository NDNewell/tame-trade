interface ExchangeStopLossOrderParams {
  ORDER_TYPE: string;
  STOP_LOSS_PROP: string;
  REDUCE_ONLY: {
    SUPPORTED: boolean;
    REDUCE_ONLY_PROP?: string;
  };
}

interface ExchangeParams {
  [key: string]: {
    orders: {
      stopLoss: ExchangeStopLossOrderParams;
    };
  };
}

enum OrderType {
  MARKET = 'market',
  STOP = 'stop',
  STOP_MARKET = 'stop_market',
}

enum StopLossProp {
  STOP_LOSS_PRICE = 'stopLossPrice',
  STOP_PRICE = 'stopPrice',
}

enum ReduceOnlyProp {
  REDUCE_ONLY = 'reduce_only',
  REDUCE_ONLY_CAMEL = 'reduceOnly',
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
        // Phemex does support reduce-only; this was previously marked false, so
        // stops were sent as ordinary orders that could open a position in the
        // opposite direction instead of closing the one you hold.
        REDUCE_ONLY: {
          SUPPORTED: true,
          REDUCE_ONLY_PROP: ReduceOnlyProp.REDUCE_ONLY_CAMEL,
        },
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
    },
  },
};
