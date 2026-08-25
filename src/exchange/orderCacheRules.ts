// src/exchange/orderCacheRules.ts
//
// The two decisions that keep the cached order list honest, kept pure so they
// can be tested without an exchange.
//
// Both exist because of the same failure: a chase repriced by cancel/replace,
// the cancelled order arrived on the feed carrying a status nothing matched, and
// it stayed on screen as a working order for the rest of the session while the
// exchange had no record of it.

/** Statuses that mean an order is still working. */
export const OPEN_ORDER_STATUSES = new Set(['open', 'partial', 'partially_filled']);

/** Statuses that mean it is finished, whatever it did. */
export const TERMINAL_ORDER_STATUSES = new Set([
  'closed',
  'canceled',
  'cancelled',
  'rejected',
  'expired',
]);

export type OrderDisposition = 'working' | 'finished' | 'unknown';

/**
 * What a status tells us about an order.
 *
 * 'unknown' is a real answer and the important one. The previous rule tested for
 * three exact strings and treated everything else as still working, so a status
 * it did not recognise silently became a claim that the order was live. An
 * unrecognised status means we have not been told; the caller is expected to go
 * and ask rather than assume.
 */
export function classifyOrderStatus(status: unknown): OrderDisposition {
  const value = String(status ?? '')
    .trim()
    .toLowerCase();

  if (TERMINAL_ORDER_STATUSES.has(value)) return 'finished';
  if (OPEN_ORDER_STATUSES.has(value)) return 'working';
  return 'unknown';
}

/**
 * Cached orders the exchange did not list, and which should therefore go.
 *
 * `authoritative` says whether the snapshot could have contained every cached
 * order. A filtered query -- untriggered orders only, say -- may not, and
 * reconciling the whole cache against one would delete every ordinary limit
 * order in it. Where the snapshot cannot speak for the whole set, nothing is
 * removed on its word.
 */
export function staleOrderIds(
  cached: Iterable<string>,
  snapshot: Iterable<string>,
  authoritative: boolean
): string[] {
  if (!authoritative) return [];

  const live = new Set(snapshot);
  const stale: string[] = [];

  for (const id of cached) {
    if (!live.has(id)) stale.push(id);
  }

  return stale;
}
