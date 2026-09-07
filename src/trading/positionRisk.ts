// src/trading/positionRisk.ts
//
// Planned downside between a position's average entry and the protective stops
// that currently cover it.
//
// This is stop-based *planned* risk, not a guaranteed maximum loss: a stop can
// gap, slip, or fail to fill. It is deliberately not notional exposure, margin,
// liquidation distance, or current unrealized loss.
//
// The stops are read in the order price would trigger them. That is the whole
// method, and it is what makes any combination of stops resolvable: a sized
// stop takes what it asked for out of whatever is still open when price reaches
// it, a whole-position stop takes all of it, and once nothing is open the
// stops further out never fire. A 500 stop above entry with a whole-position
// stop at entry underneath it is not an ambiguous pair, it is a plan -- half
// out with a profit, the rest at breakeven -- and this reads it as one.
//
// An earlier version refused to add stops it could not tell apart and showed
// '[AMBIGUOUS STOPS]' instead, on the reasoning that a wrong number looks more
// precise than no number. The reasoning was sound and the premise was not:
// the caller only ever passes stops the exchange has typed as Stops, which puts
// every trigger on the losing side of the current price, and on that side the
// firing order is the price order. Nothing is left to guess.
//
// The module is pure -- no exchange, no market lookups -- so every rule below
// can be tested directly.

/** A protective stop, normalised from whatever the exchange reported. */
export interface ProtectiveStopTranche {
  orderId: string;
  /**
   * Where it fires. The caller guarantees this is on the losing side of the
   * current price: a trigger on the winning side is a take profit, which the
   * exchange types differently and the caller leaves out.
   */
  triggerPrice: number;
  /** What the order asked for. Ignored when `coversAll` is set. */
  requestedQuantity: number;
  /** The order closes the whole position, whatever it happens to be. */
  coversAll: boolean;
  reduceOnly: boolean;
  /**
   * Orders sharing a group are one-cancels-the-other: the first to fire
   * cancels the rest, so at most one of them ever closes anything.
   */
  orderGroup?: string;
}

export interface PositionRiskInput {
  side: 'long' | 'short';
  /** Current open quantity, in the instrument's own units. */
  quantity: number;
  /** Current average entry, as reported by the position. */
  entryPrice: number;
  currency: string;
  contractSize?: number;
  inverse?: boolean;
  stops: ProtectiveStopTranche[];
}

/**
 * One stop's share of the position, in firing order.
 *
 * `effectiveQuantity` is what the stop would actually close when price reaches
 * it -- which is zero for a stop behind one that has already closed everything,
 * or behind a group-mate that fired first. Those are kept in the list rather
 * than dropped, so a reader can say which order is doing nothing and why.
 */
export interface RiskTranche {
  orderId: string;
  triggerPrice: number;
  effectiveQuantity: number;
  riskPerUnit: number;
  trancheRisk: number;
}

export interface PositionRiskResult {
  /** Undefined when nothing protects the position at all. */
  totalRisk: number | undefined;
  currency: string;
  positionQuantity: number;
  protectedQuantity: number;
  unprotectedQuantity: number;
  coveragePercentage: number;
  isFullyProtected: boolean;
  /** Every stop passed in, in the order price would reach them. */
  tranches: RiskTranche[];
}

/**
 * Loss for a quantity exiting at `exitPrice`, floored at zero.
 *
 * The floor matters: a stop moved past breakeven protects rather than risks, and
 * must contribute nothing rather than a negative that offsets a real risk
 * elsewhere. Inverse contracts settle in the base asset, so their loss is not a
 * simple price difference.
 */
function lossFor(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  contractSize: number,
  inverse: boolean
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return 0;
  if (entryPrice <= 0 || exitPrice <= 0 || quantity <= 0) return 0;

  if (inverse) {
    const value =
      side === 'long'
        ? quantity * contractSize * (1 / exitPrice - 1 / entryPrice)
        : quantity * contractSize * (1 / entryPrice - 1 / exitPrice);
    return Math.max(value, 0);
  }

  const perUnit = side === 'long' ? entryPrice - exitPrice : exitPrice - entryPrice;

  return Math.max(perUnit, 0) * quantity * contractSize;
}

/** Risk per single unit, for reporting rather than for the total. */
function riskPerUnit(side: 'long' | 'short', entryPrice: number, exitPrice: number): number {
  const perUnit = side === 'long' ? entryPrice - exitPrice : exitPrice - entryPrice;
  return Math.max(perUnit, 0);
}

/** Quantities this close to zero are zero; the exchange's own precision is coarser. */
const EPSILON = 1e-9;

/** No coverage at all: not zero risk, but risk that cannot be stated. */
const unprotected = (input: PositionRiskInput): PositionRiskResult => ({
  totalRisk: undefined,
  currency: input.currency,
  positionQuantity: input.quantity,
  protectedQuantity: 0,
  unprotectedQuantity: input.quantity,
  coveragePercentage: 0,
  isFullyProtected: false,
  tranches: [],
});

/**
 * The stops in the order price reaches them on the way against the position.
 *
 * For a long, price falls into the highest trigger first; for a short, it
 * rises into the lowest. Ties keep their given order, which is the order the
 * exchange listed them in.
 */
function inFiringOrder(
  side: 'long' | 'short',
  stops: ProtectiveStopTranche[]
): ProtectiveStopTranche[] {
  return [...stops].sort((a, b) =>
    side === 'long' ? b.triggerPrice - a.triggerPrice : a.triggerPrice - b.triggerPrice
  );
}

export function calculatePositionRisk(input: PositionRiskInput): PositionRiskResult {
  const contractSize = input.contractSize ?? 1;
  const inverse = input.inverse ?? false;

  if (!(input.quantity > 0) || !(input.entryPrice > 0)) {
    return unprotected(input);
  }

  const stops = input.stops.filter((stop) => stop.triggerPrice > 0);
  if (stops.length === 0) return unprotected(input);

  // Walk the stops as price would, handing each one what is still open when
  // it fires. A group-mate of a stop that fired is cancelled by it, and a stop
  // behind the point where nothing is open has nothing to close.
  let remaining = input.quantity;
  const firedGroups = new Set<string>();
  const tranches: RiskTranche[] = [];

  for (const stop of inFiringOrder(input.side, stops)) {
    const cancelled = stop.orderGroup !== undefined && firedGroups.has(stop.orderGroup);
    const quantity = cancelled
      ? 0
      : stop.coversAll
        ? remaining
        : Math.min(Math.max(0, stop.requestedQuantity), remaining);

    if (quantity > EPSILON) {
      remaining -= quantity;
      if (stop.orderGroup !== undefined) firedGroups.add(stop.orderGroup);
    }

    tranches.push({
      orderId: stop.orderId,
      triggerPrice: stop.triggerPrice,
      effectiveQuantity: quantity > EPSILON ? quantity : 0,
      riskPerUnit: riskPerUnit(input.side, input.entryPrice, stop.triggerPrice),
      trancheRisk: lossFor(
        input.side,
        input.entryPrice,
        stop.triggerPrice,
        quantity,
        contractSize,
        inverse
      ),
    });
  }

  const protectedQuantity = tranches.reduce((total, t) => total + t.effectiveQuantity, 0);
  const totalRisk = tranches.reduce((total, t) => total + t.trancheRisk, 0);
  const unprotectedQuantity = Math.max(0, input.quantity - protectedQuantity);

  return {
    totalRisk,
    currency: input.currency,
    positionQuantity: input.quantity,
    protectedQuantity,
    unprotectedQuantity,
    coveragePercentage: (protectedQuantity / input.quantity) * 100,
    isFullyProtected: unprotectedQuantity <= EPSILON,
    tranches,
  };
}
