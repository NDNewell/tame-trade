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
 * Whether a streamed update may put an order into the cache that was not there.
 *
 * It may not, and this is the rule that says so.
 *
 * The order feed replays recent history whenever it reconnects -- the same
 * behaviour that had fills counted five times over -- and a replayed order
 * arrives carrying whatever status it held at that moment. One that was open
 * days ago therefore arrives looking open now. Nothing announces it, because a
 * plain 'open' is not an event worth a log line, so it appears in ACTIVE ORDERS
 * with no trace anywhere else: an order the operator never placed, on an
 * account where that is the most alarming thing a screen can show.
 *
 * A genuinely new order reaches the cache by one of two honest routes. One this
 * application placed is put there when the exchange accepts it. One placed
 * anywhere else is found by the next authoritative snapshot. Neither needs the
 * feed to introduce it, and the feed cannot tell a replay from the present.
 *
 * So the feed may update an order the cache already knows, and may remove one.
 * It may not invent one.
 */
export function mayIntroduceOrder(
  disposition: OrderDisposition,
  known: boolean
): boolean {
  return known && disposition === 'working';
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
