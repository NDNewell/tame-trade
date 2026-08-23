// src/trading/positionRisk.ts
//
// Planned downside between a position's average entry and the protective stops
// that currently cover it.
//
// This is stop-based *planned* risk, not a guaranteed maximum loss: a stop can
// gap, slip, or fail to fill. It is deliberately not notional exposure, margin,
// liquidation distance, or current unrealized loss.
//
// The module is pure — no exchange, no market lookups — so every rule below can
// be tested directly.

/** A protective stop, normalised from whatever the exchange reported. */
export interface ProtectiveStopTranche {
  orderId: string;
  triggerPrice: number;
  /** What the order asked for. Ignored when `coversAll` is set. */
  requestedQuantity: number;
  /** The order closes the whole position, whatever it happens to be. */
  coversAll: boolean;
  reduceOnly: boolean;
  /** Orders sharing a group are alternatives, not additive coverage. */
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

export interface RiskTranche {
  orderId: string;
  triggerPrice: number;
  effectiveQuantity: number;
  riskPerUnit: number;
  trancheRisk: number;
}

export interface PositionRiskResult {
  /** Undefined when no protective coverage can be established. */
  totalRisk: number | undefined;
  currency: string;
  positionQuantity: number;
  protectedQuantity: number;
  unprotectedQuantity: number;
  coveragePercentage: number;
  isFullyProtected: boolean;
  /** Coverage exists but its shape can't be resolved; no number is offered. */
  isAmbiguous: boolean;
  ambiguityReason?: string;
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

  const perUnit =
    side === 'long' ? entryPrice - exitPrice : exitPrice - entryPrice;

  return Math.max(perUnit, 0) * quantity * contractSize;
}

/** Risk per single unit, for reporting rather than for the total. */
function riskPerUnit(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number
): number {
  const perUnit =
    side === 'long' ? entryPrice - exitPrice : exitPrice - entryPrice;
  return Math.max(perUnit, 0);
}

const unresolved = (
  input: PositionRiskInput,
  reason?: string
): PositionRiskResult => ({
  totalRisk: undefined,
  currency: input.currency,
  positionQuantity: input.quantity,
  protectedQuantity: 0,
  unprotectedQuantity: input.quantity,
  coveragePercentage: 0,
  isFullyProtected: false,
  isAmbiguous: reason !== undefined,
  ambiguityReason: reason,
  tranches: [],
});

export function calculatePositionRisk(
  input: PositionRiskInput
): PositionRiskResult {
  const contractSize = input.contractSize ?? 1;
  const inverse = input.inverse ?? false;

  if (!(input.quantity > 0) || !(input.entryPrice > 0)) {
    return unresolved(input);
  }

  const stops = input.stops.filter((stop) => stop.triggerPrice > 0);

  // No coverage at all is not zero risk — it is risk that cannot be stated.
  if (stops.length === 0) return unresolved(input);

  // Stops sharing a group are alternative outcomes. Which one is effective
  // depends on order semantics we don't have, so no total is offered rather
  // than one that assumes both can fire.
  const groups = new Map<string, number>();
  for (const stop of stops) {
    if (!stop.orderGroup) continue;
    groups.set(stop.orderGroup, (groups.get(stop.orderGroup) ?? 0) + 1);
  }
  for (const [group, count] of groups) {
    if (count > 1) {
      return unresolved(input, `stops in group ${group} are mutually exclusive`);
    }
  }

  const wholePositionStops = stops.filter((stop) => stop.coversAll);
  const sizedStops = stops.filter((stop) => !stop.coversAll);

  // Two orders each claiming the whole position can't both be independent
  // coverage, and nothing tells us which is effective.
  if (wholePositionStops.length > 1) {
    return unresolved(input, 'more than one whole-position stop');
  }

  // A whole-position stop alongside sized ones may be nested, staged or
  // alternative protection. Adding them would overstate coverage.
  if (wholePositionStops.length === 1 && sizedStops.length > 0) {
    return unresolved(input, 'whole-position stop combined with sized stops');
  }

  let allocations: Array<{ stop: ProtectiveStopTranche; quantity: number }>;

  if (wholePositionStops.length === 1) {
    // 'All' means the position as it stands now, not as it was when the order
    // was created.
    allocations = [{ stop: wholePositionStops[0], quantity: input.quantity }];
  } else {
    const requested = sizedStops.reduce(
      (total, stop) => total + Math.max(0, stop.requestedQuantity),
      0
    );

    // More stop quantity than position, with nothing to say how the orders
    // overlap. Capping arbitrarily would invent an allocation.
    if (requested > input.quantity + 1e-9) {
      return unresolved(
        input,
        `stops cover ${requested} against a position of ${input.quantity}`
      );
    }

    allocations = sizedStops.map((stop) => ({
      stop,
      quantity: Math.max(0, stop.requestedQuantity),
    }));
  }

  const tranches: RiskTranche[] = allocations.map(({ stop, quantity }) => ({
    orderId: stop.orderId,
    triggerPrice: stop.triggerPrice,
    effectiveQuantity: quantity,
    riskPerUnit: riskPerUnit(input.side, input.entryPrice, stop.triggerPrice),
    trancheRisk: lossFor(
      input.side,
      input.entryPrice,
      stop.triggerPrice,
      quantity,
      contractSize,
      inverse
    ),
  }));

  const protectedQuantity = tranches.reduce(
    (total, tranche) => total + tranche.effectiveQuantity,
    0
  );
  const totalRisk = tranches.reduce(
    (total, tranche) => total + tranche.trancheRisk,
    0
  );
  const unprotectedQuantity = Math.max(0, input.quantity - protectedQuantity);

  return {
    totalRisk,
    currency: input.currency,
    positionQuantity: input.quantity,
    protectedQuantity,
    unprotectedQuantity,
    coveragePercentage:
      input.quantity > 0 ? (protectedQuantity / input.quantity) * 100 : 0,
    isFullyProtected: unprotectedQuantity <= 1e-9,
    isAmbiguous: false,
    tranches,
  };
}
