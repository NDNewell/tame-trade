// src/trading/trailTag.ts
//
// Encodes an adaptive trail's terms into the client order id it is placed with.
//
// The alternative was a registry in memory, which would be lost on restart: the
// trail would keep protecting the position but quietly stop adapting, and
// nothing on screen would say so. Putting the terms on the order makes the
// exchange itself the register. Whatever Tame has forgotten, the order still
// says what it is, so a restart picks it straight back up.

/** Anything not matching this is not ours, and is left alone. */
const TAG = /^TAMEATR(\d{1,6})-([0-9a-z]{1,5})-/i;

export interface TrailTag {
  /** Multiple of ATR this trail is sized at. */
  multiple: number;
  /** Candle size its ATR is measured on. */
  timeframe: string;
}

/**
 * Builds a client order id carrying the trail's terms.
 *
 * The multiple is stored hundredfold so it stays an integer: exchanges are
 * inconsistent about punctuation in client ids, and '2.5' risks being rejected
 * or silently altered where '250' will not.
 *
 * The random suffix keeps ids unique. An exchange that rejects a duplicate
 * client id would otherwise refuse the second trail placed on the same terms.
 */
export function buildTrailTag(tag: TrailTag, random = Math.random): string {
  const hundredths = Math.round(tag.multiple * 100);
  const suffix = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');

  return `TAMEATR${hundredths}-${tag.timeframe.toLowerCase()}-${suffix}`;
}

/**
 * Reads the terms back, or undefined for any id that is not one of ours.
 *
 * Deliberately strict. A misparse here would have Tame amending an order it
 * does not understand the terms of, which is worse than not managing it at all.
 */
export function readTrailTag(clientOrderId: unknown): TrailTag | undefined {
  const match = TAG.exec(String(clientOrderId ?? ''));
  if (!match) return undefined;

  const multiple = Number(match[1]) / 100;
  if (!Number.isFinite(multiple) || multiple <= 0) return undefined;

  return { multiple, timeframe: match[2].toLowerCase() };
}

/** Whether an order was placed as an adaptive trail by this application. */
export const isAdaptiveTrail = (clientOrderId: unknown): boolean =>
  readTrailTag(clientOrderId) !== undefined;
