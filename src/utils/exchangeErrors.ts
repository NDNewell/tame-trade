// src/utils/exchangeErrors.ts
//
// Turns an exchange rejection into something a trader can act on, while keeping
// the original for diagnostics.
//
// The primary activity feed answers "what failed, and what does it mean for me".
// The raw payload answers "what exactly did the API return" and belongs in the
// diagnostic log, not across the middle of the screen.

export interface ExchangeFailure {
  /** Short, user-facing. Fits an activity row. */
  summary: string;
  /** The exchange's own code, when one could be found. */
  code?: string;
  /** Everything the exchange said, for the diagnostic log. */
  raw: string;
}

/**
 * Only codes whose meaning is known are translated. An unknown code keeps a
 * plain fallback rather than a guess dressed up as an explanation.
 */
const KNOWN_CODES: Record<string, string> = {
  TE_POS_ZERO_CANNOT_CREATE_TP_SL_ORDER: 'No position available to protect',
  TE_CANNOT_UPDATE_ORDER_STATUS: 'Order can no longer be changed',
  TE_ORDER_NOT_EXIST: 'Order no longer exists',
  TE_NO_ENOUGH_AVAILABLE_BALANCE: 'Insufficient margin',
  TE_INVALID_ORDER_QTY: 'Invalid quantity',
  TE_INVALID_PRICE: 'Invalid price',
  TE_REDUCE_ONLY_ORDER_WOULD_INCREASE_POSITION: 'Would increase the position, not reduce it',
  TE_ORDER_WOULD_TRIGGER_IMMEDIATELY: 'Would trigger immediately at this price',
};

/** Pulls the exchange's own error code out of a message or JSON payload. */
function findCode(raw: string): string | undefined {
  const fromJson = raw.match(/"msg"\s*:\s*"([A-Z_0-9]+)"/);
  if (fromJson) return fromJson[1];

  const bare = raw.match(/\b(TE_[A-Z_0-9]+)\b/);
  if (bare) return bare[1];

  return undefined;
}

export function describeExchangeError(error: unknown): ExchangeFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const code = findCode(raw);

  if (code && KNOWN_CODES[code]) {
    return { summary: KNOWN_CODES[code], code, raw };
  }

  // A payload with no recognised code would otherwise put JSON across the row.
  if (/[{[]/.test(raw) || raw.length > 60) {
    return { summary: 'Exchange rejected request', code, raw };
  }

  return { summary: raw, code, raw };
}
