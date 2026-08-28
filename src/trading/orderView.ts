// src/trading/orderView.ts
//
// What a working order actually is, in one place.
//
// This existed twice: once in the panel, which had the whole truth, and once in
// the block handed to the coach, which had a lossy copy of it. The copy dropped
// exactly the things that distinguish one stop from another -- a zero quantity
// means the whole position rather than nothing, and a delayed trail carries no
// peg, so to anything reading the exchange's own fields it is indistinguishable
// from a stop that will sit where it was put. The coach was reading orders it
// could not tell apart and describing them as though it could.
//
// So the reading is done once and both consumers take the result. The panel
// renders it to six narrow columns; the coach gets it as a sentence. Neither
// re-derives it, which is the point: the screen and the prose cannot disagree
// about what is protecting the position.
//
// Pure. Nothing here reads a clock, a price, or the network.

import { TrailTag, readTrailTag } from './trailTag.js';

/** What this process is doing to an order, as opposed to what the order is. */
export type OrderManagement =
  /** A limit order being re-priced towards the book by a running chase. */
  | 'CHASE'
  /** A managed trail that has not started trailing yet. */
  | 'ARM'
  /** A managed trail whose distance is a multiple of measured volatility. */
  | 'ATR'
  /** Trailing at a fixed distance, by us or by the exchange. */
  | 'TRAIL';

export interface TrailTerms extends TrailTag {
  /**
   * Whether it has started trailing.
   *
   * A delayed trail is an ordinary stop until price reaches its arming price;
   * only afterwards does anything move it. The difference is the difference
   * between a stop that is following the position up and one that is not, and
   * nothing on the order itself says which it is -- the arming is remembered by
   * the process that is doing the moving.
   */
  armed: boolean;
}

export interface OrderView {
  id: string;
  side: string;
  /**
   * Undefined when the order covers whatever the position happens to be.
   *
   * The exchange encodes that as a quantity of zero, which reads as an empty
   * order to anything that does not know the convention. Keeping it undefined
   * with `wholePosition` set means a consumer has to handle the case rather
   * than print a nought.
   */
  quantity?: number;
  wholePosition: boolean;
  filled: number;
  price?: number;
  trigger?: number;
  type: 'LIMIT' | 'MARKET' | 'STOP';
  status: string;
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  /** A peg the exchange itself moves, as opposed to a trail we move. */
  exchangeTrailing: boolean;
  trail?: TrailTerms;
  managed?: OrderManagement;
  placedAt?: number;
}

/** What the reader needs to know that the order itself does not carry. */
export interface OrderContext {
  /** Whether a delayed trail has started trailing. */
  isTrailArmed?: (orderId: string) => boolean;
  /** The order a chase is currently working, if one is running. */
  chaseOrderId?: string;
}

const number = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const truthy = (value: unknown): boolean =>
  value === true || value === 'true' || value === 1 || value === '1';

/**
 * Reads one order as the exchange returned it.
 *
 * Tolerant by necessity -- the same field arrives under three names depending
 * on the endpoint and the settlement scale -- but never inventive: a field it
 * cannot find is absent, not guessed.
 */
export function describeOrder(raw: any, context: OrderContext = {}): OrderView {
  const info = raw?.info ?? {};
  const id = String(raw?.id ?? '');

  const trigger = number(raw?.triggerPrice ?? info.stopPxRp ?? info.stopPxEp);
  const isTrigger = trigger !== undefined && trigger > 0;

  const size = number(raw?.remaining ?? raw?.amount) ?? 0;
  // A trigger order sized zero closes whatever is open when it fires. A limit
  // order sized zero is a different matter and is left to read as zero.
  const wholePosition = isTrigger && size <= 0;

  const filled = number(raw?.filled) ?? 0;

  const type: OrderView['type'] = isTrigger
    ? 'STOP'
    : String(raw?.type ?? 'limit').toLowerCase() === 'market'
      ? 'MARKET'
      : 'LIMIT';

  // The exchange trails a peg itself. Ours carry no peg at all -- to the
  // exchange they are ordinary stops -- so only the tag distinguishes them.
  const peg = number(info.pegOffsetValueRp ?? info.pegOffsetValueEp) ?? 0;
  const exchangeTrailing =
    peg !== 0 && String(info.pegPriceType ?? '').toLowerCase().includes('trailing');

  const tag = readTrailTag(raw?.clientOrderId ?? info.clOrdID);
  const trail: TrailTerms | undefined = tag
    ? {
        ...tag,
        // A trail with no arming price trails from the moment it is placed, so
        // it is armed by definition; one with an arming price is armed only if
        // the process that moves it says so.
        armed:
          tag.armPrice === undefined ? true : (context.isTrailArmed?.(id) ?? false),
      }
    : undefined;

  const status = isTrigger
    ? 'WORKING'
    : filled > 0 && size > 0
      ? 'PARTIAL'
      : String(raw?.status ?? 'open').toLowerCase() === 'open'
        ? 'WORKING'
        : String(raw?.status ?? '').toUpperCase();

  // Checked in this order deliberately. A chase means this process is actively
  // working the order, which is a stronger claim than the exchange trailing it;
  // and a trail that has not armed is not trailing whatever its terms say.
  const managed: OrderManagement | undefined =
    context.chaseOrderId && id === context.chaseOrderId
      ? 'CHASE'
      : trail && !trail.armed
        ? 'ARM'
        : trail?.kind === 'atr'
          ? 'ATR'
          : trail !== undefined || exchangeTrailing
            ? 'TRAIL'
            : undefined;

  return {
    id,
    side: String(raw?.side ?? '').toUpperCase(),
    quantity: wholePosition ? undefined : size,
    wholePosition,
    filled,
    price: isTrigger ? undefined : number(raw?.price),
    trigger: isTrigger ? trigger : undefined,
    type,
    status,
    reduceOnly: truthy(raw?.reduceOnly ?? info.reduceOnly),
    closeOnTrigger: truthy(info.closeOnTrigger ?? raw?.closeOnTrigger),
    exchangeTrailing,
    trail,
    managed,
    placedAt: number(raw?.timestamp),
  };
}

export const describeOrders = (raw: any[], context: OrderContext = {}): OrderView[] =>
  (raw ?? []).map((order) => describeOrder(order, context));

/** Trims trailing zeros so a tick-sized number does not gain false precision. */
const trim = (value: number, digits = 8): string => String(Number(value.toFixed(digits)));

/**
 * How a trail's distance was specified, in the operator's own terms.
 *
 * '3x ATR(15m)' rather than a resolved price, because the resolved price is
 * already on the order and the multiple is the thing that is not: a coach shown
 * only the trigger cannot tell a tight trail in a quiet market from a loose one
 * in a violent one.
 */
function trailPhrase(trail: TrailTerms): string {
  const distance =
    trail.kind === 'atr'
      ? `${trim(trail.value, 2)}x ATR(${trail.timeframe ?? '?'})`
      : `${trim(trail.value)} away`;

  if (trail.armPrice === undefined) return `trailing ${distance}`;

  return trail.armed
    ? `trailing ${distance}, armed at ${trim(trail.armPrice)}`
    : `will trail ${distance} once price reaches ${trim(trail.armPrice)}; ` +
        `until then it is a fixed stop and does not move`;
}

/**
 * One order as a sentence, for the coach.
 *
 * Says what the order will do rather than which fields it carries. The
 * distinction that matters most is spelled out rather than abbreviated: 'ARM'
 * is a column heading, and a reader who has to infer what it means will infer
 * something.
 */
export function orderSentence(view: OrderView): string {
  const size = view.wholePosition
    ? 'the whole position'
    : view.quantity !== undefined
      ? trim(view.quantity)
      : '?';

  const parts: string[] = [`${view.side} ${size}`];

  if (view.type === 'STOP') {
    parts.push(`stop, triggers at ${view.trigger !== undefined ? trim(view.trigger) : '?'}`);
  } else if (view.price !== undefined) {
    parts.push(`${view.type.toLowerCase()} at ${trim(view.price)}`);
  } else {
    parts.push(view.type.toLowerCase());
  }

  if (view.trail) parts.push(trailPhrase(view.trail));
  else if (view.exchangeTrailing) parts.push('trailed by the exchange');

  if (view.managed === 'CHASE') parts.push('being chased towards the book');
  if (view.reduceOnly || view.closeOnTrigger) parts.push('reduce-only');
  if (view.status === 'PARTIAL') parts.push(`partially filled (${trim(view.filled)} done)`);

  return parts.join(', ');
}
