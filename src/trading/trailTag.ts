// src/trading/trailTag.ts
//
// Encodes a trail's terms into the client order id it is placed with.
//
// The alternative was a registry in memory, which would be lost on restart: the
// trail would keep protecting the position but quietly stop adapting, and
// nothing on screen would say so. Putting the terms on the order makes the
// exchange itself the register. Whatever Tame has forgotten, the order still
// says what it is, so a restart picks it straight back up.
//
// Only orders this process has work to do on are tagged. A plain fixed trail is
// handed to the exchange as a peg and never touched again, so it carries
// nothing.

/** What the trail's distance is derived from. */
export type TrailKind = 'atr' | 'fixed';

export interface TrailTag {
  kind: TrailKind;
  /** Multiple of ATR, or the distance in price units for a fixed trail. */
  value: number;
  /** Candle size the ATR is measured on. Absent for fixed trails. */
  timeframe?: string;
  /**
   * Price at which a delayed trail starts trailing. Absent if it trails
   * immediately.
   *
   * Stored rather than recomputed because both halves of `entry + distance`
   * move: adding to a position changes its average entry, and an ATR cushion
   * changes every candle. A trail whose arming price drifted after it was
   * placed would be a different order from the one that was asked for.
   */
  armPrice?: number;
}

const NONE = '_';
/** Hundredths keep every field an integer; exchanges are inconsistent about punctuation. */
const SCALE = 100;

const encode = (value: number): string => String(Math.round(value * SCALE));
const decode = (raw: string): number | undefined => {
  const value = Number(raw) / SCALE;
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * Builds a client order id carrying the trail's terms.
 *
 * Fields are positional and always present, using '_' for absent, so parsing
 * cannot mistake a timeframe for an arming price. The random suffix keeps ids
 * unique, since an exchange that rejects duplicates would otherwise refuse the
 * second trail placed on identical terms.
 */
export function buildTrailTag(tag: TrailTag, random = Math.random): string {
  const kind = tag.kind === 'atr' ? 'ATR' : 'FIX';
  const timeframe = tag.timeframe ? tag.timeframe.toLowerCase() : NONE;
  const arm = tag.armPrice !== undefined ? encode(tag.armPrice) : NONE;
  const suffix = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');

  return `TAME${kind}${encode(tag.value)}-${timeframe}-${arm}-${suffix}`;
}

/**
 * Reads the terms back, or undefined for any id that is not one of ours.
 *
 * Deliberately strict. A misparse would have Tame moving an order whose terms
 * it has guessed at, which is worse than not managing it at all.
 *
 * The three-field form is also accepted: trails placed before arming existed
 * carry it, and they are still running.
 */
export function readTrailTag(clientOrderId: unknown): TrailTag | undefined {
  const id = String(clientOrderId ?? '');

  const current = /^TAME(ATR|FIX)(\d{1,9})-([0-9a-z_]{1,5})-(\d{1,12}|_)-/i.exec(id);
  if (current) {
    const value = decode(current[2]);
    if (value === undefined) return undefined;

    const timeframe = current[3] === NONE ? undefined : current[3].toLowerCase();
    const kind: TrailKind = current[1].toUpperCase() === 'ATR' ? 'atr' : 'fixed';
    if (kind === 'atr' && timeframe === undefined) return undefined;

    return {
      kind,
      value,
      timeframe,
      armPrice: current[4] === NONE ? undefined : decode(current[4]),
    };
  }

  // Trails placed before arming existed: TAMEATR<mult>-<tf>-<rand>.
  const legacy = /^TAMEATR(\d{1,9})-([0-9a-z]{1,5})-/i.exec(id);
  if (legacy) {
    const value = decode(legacy[1]);
    if (value === undefined) return undefined;
    return { kind: 'atr', value, timeframe: legacy[2].toLowerCase() };
  }

  return undefined;
}

/** Whether an order was placed as a managed trail by this application. */
export const isManagedTrail = (clientOrderId: unknown): boolean =>
  readTrailTag(clientOrderId) !== undefined;
