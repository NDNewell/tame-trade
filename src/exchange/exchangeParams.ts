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
        ORDER_TYPE: OrderType.STOP,
        STOP_LOSS_PROP: StopLossProp.STOP_PRICE,
        REDUCE_ONLY: {
          SUPPORTED: false,
        },
      },
    },
  },
};
