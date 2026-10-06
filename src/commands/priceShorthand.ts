// src/commands/priceShorthand.ts
//
// 'bid' and 'ask' stand for the top of the book wherever a price goes in an
// order command, so 'limit buy 10 bid' joins the bid and 'tp ask' takes
// profit at the offer without first reading the number off the screen and
// typing it back, by which time it has moved.
//
// Only commands that take a price are rewritten. The words are ordinary
// English, and a coach question ('coach is the ask thin?') or a market name
// has to reach its handler untouched. The same restriction keeps 'buy ask'
// from being read as a market buy of ask-price units.
//
// Pure. The prices come from the caller; nothing here reads the network.

const PRICED_VERBS = new Set(['limit', 'stop', 'tp', 'move', 'bump', 'bracket']);

export interface TopOfBook {
  bid?: number;
  ask?: number;
}

/** Which top-of-book words an order command uses, or undefined if none. */
export function topOfBookWords(command: string): { bid: boolean; ask: boolean } | undefined {
  const words = command.trim().split(/\s+/);
  if (!PRICED_VERBS.has(words[0])) return undefined;

  const bid = words.includes('bid');
  const ask = words.includes('ask');
  return bid || ask ? { bid, ask } : undefined;
}

/**
 * The command with 'bid' and 'ask' replaced by the prices given, or the
 * reason it could not be. A price the book does not have is a refusal, not a
 * guess: an order at an unknown price is worse than no order.
 */
export function substituteTopOfBook(
  command: string,
  book: TopOfBook,
  market: string
): { command: string } | { error: string } {
  const words = topOfBookWords(command);
  if (!words) return { command };

  for (const side of ['bid', 'ask'] as const) {
    if (!words[side]) continue;
    const price = book[side];
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      return {
        error:
          `No ${side} price is available for ${market} right now. ` +
          'No order was placed. Type the price instead.',
      };
    }
  }

  const substituted = command
    .trim()
    .split(/\s+/)
    .map((word) => (word === 'bid' || word === 'ask' ? String(book[word]) : word))
    .join(' ');

  return { command: substituted };
}
