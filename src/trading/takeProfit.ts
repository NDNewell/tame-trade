// src/trading/takeProfit.ts
//
// Which side of the market a take profit has to sit on.
//
// A take profit and a stop are the same kind of order -- reduce-only, waiting
// on a trigger -- and the only thing that makes one or the other is where the
// trigger sits relative to the price now. So a take profit typed on the wrong
// side is not a badly priced take profit: it is a stop, or an order that fires
// the moment it arrives and closes the position at market. Neither is what was
// asked for, and neither announces itself, so it is refused here instead.
//
// Pure. Nothing here reads a clock, a price, or the network.

export type ClosingSide = 'buy' | 'sell';

/**
 * Why a take profit at this price cannot be placed, or undefined if it can.
 *
 * `closingSide` is the side of the order, not the position: 'sell' closes a
 * long and wants a trigger above the market, 'buy' closes a short and wants
 * one below.
 */
export function takeProfitProblem(
  closingSide: ClosingSide,
  price: number,
  marketPrice: number | undefined
): string | undefined {
  // No price to compare with. The exchange is left to judge it, exactly as it
  // is for a stop.
  if (marketPrice === undefined || !(marketPrice > 0)) return undefined;

  if (closingSide === 'sell' && price <= marketPrice) {
    return (
      `Take profit ${price} is not above the market price of ${marketPrice}. ` +
      `Closing a long, it has to be above. No order was placed. ` +
      `For a trigger below the market use 'stop <price> [size]'.`
    );
  }

  if (closingSide === 'buy' && price >= marketPrice) {
    return (
      `Take profit ${price} is not below the market price of ${marketPrice}. ` +
      `Closing a short, it has to be below. No order was placed. ` +
      `For a trigger above the market use 'stop <price> [size]'.`
    );
  }

  return undefined;
}

/** A resting take profit, reduced to what choosing between them needs. */
export interface RestingTakeProfit {
  id: string;
  trigger: number;
}

export type TakeProfitChoice =
  | { matches: RestingTakeProfit[]; problem?: undefined }
  | { matches?: undefined; problem: string };

const trimPrice = (value: number): string => String(Number(value.toFixed(8)));

/**
 * Which take profits 'move tp' is talking about.
 *
 * Named by the price they rest at, because that is what is on the panel and
 * what the operator typed to put them there. The match allows half a tick
 * either way: the exchange rounds what it is sent, and a target typed as 110.1
 * on a market that ticks in 0.5 is resting at 110.
 *
 * Every take profit at that price moves. Two orders at one level are one target
 * placed in two pieces, and moving half of it would leave a level the operator
 * no longer believes in.
 *
 * With no old price there has to be exactly one to move. Picking the nearest of
 * several would be a guess about which target was meant.
 */
export function chooseTakeProfits(
  resting: RestingTakeProfit[],
  oldPrice: number | undefined,
  tick: number | undefined
): TakeProfitChoice {
  if (resting.length === 0) {
    return { problem: 'No take profit found to move. Nothing was changed.' };
  }

  const levels = [...new Set(resting.map((order) => trimPrice(order.trigger)))].join(', ');

  if (oldPrice === undefined) {
    if (resting.length === 1) return { matches: resting };
    return {
      problem:
        `There are ${resting.length} take profits (${levels}). Say which: ` +
        `'move tp <old price> <new price>'. Nothing was changed.`,
    };
  }

  const tolerance = tick !== undefined && tick > 0 ? tick / 2 : 1e-9;
  const matches = resting.filter((order) => Math.abs(order.trigger - oldPrice) <= tolerance);

  if (matches.length === 0) {
    return {
      problem:
        `No take profit at ${trimPrice(oldPrice)}. Resting at: ${levels}. Nothing was changed.`,
    };
  }

  return { matches };
}
