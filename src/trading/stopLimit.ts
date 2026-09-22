// src/trading/stopLimit.ts
//
// Reads 'stop limit buy|sell <trigger price> <limit price> <size>'.
//
// A stop-limit is a conditional order the exchange holds: when the last price
// reaches the trigger, a limit order at the limit price is placed. Nothing
// here has to be running for that to happen, which is the whole appeal over a
// stop this process would have to place itself.
//
// The side is spelled out rather than inferred. A stop-limit is as often an
// entry (buy the breakout above 105, but not above 105.50) as an exit, and the
// same trigger price reads as either depending on the side.
//
// Pure. Nothing here reads a clock, a price, or the network.

export interface StopLimitCommand {
  side: 'buy' | 'sell';
  triggerPrice: number;
  limitPrice: number;
  size: number;
}

export type StopLimitParse = StopLimitCommand | { error: string } | undefined;

export const STOP_LIMIT_USAGE =
  'Usage: stop limit buy|sell <trigger price> <limit price> <size>';

export function parseStopLimit(command: string): StopLimitParse {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'stop' || words[1] !== 'limit') return undefined;

  if (words.length !== 6) return { error: STOP_LIMIT_USAGE };

  const side = words[2];
  if (side !== 'buy' && side !== 'sell') return { error: STOP_LIMIT_USAGE };

  const [triggerPrice, limitPrice, size] = [words[3], words[4], words[5]].map(Number);
  for (const [raw, value] of [[words[3], triggerPrice], [words[4], limitPrice]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `Invalid price. '${raw}' is not a usable price. ${STOP_LIMIT_USAGE}` };
    }
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { error: `Invalid quantity. '${words[5]}' is not a usable size. ${STOP_LIMIT_USAGE}` };
  }

  return { side, triggerPrice, limitPrice, size };
}

/**
 * A limit price on the far side of the trigger from the way the order will be
 * filled. Not refused -- it can be meant -- but worth a word, because a sell
 * that triggers at 95 and then asks for 96 is asking a falling market to come
 * back before it fills, and a stop that does not fill is the case a stop-limit
 * has to be chosen with eyes open.
 */
export function stopLimitCaution(order: StopLimitCommand): string | undefined {
  if (order.side === 'sell' && order.limitPrice > order.triggerPrice) {
    return (
      `Limit ${order.limitPrice} is above the trigger ${order.triggerPrice}. ` +
      `Once triggered on the way down, it fills only if price comes back up to it.`
    );
  }
  if (order.side === 'buy' && order.limitPrice < order.triggerPrice) {
    return (
      `Limit ${order.limitPrice} is below the trigger ${order.triggerPrice}. ` +
      `Once triggered on the way up, it fills only if price comes back down to it.`
    );
  }
  return undefined;
}
