// backfill-state.ts
//
// Writes what is actually in place into the journal.
//
// The journal records things as they happen, which means it records nothing
// about anything that happened while it was not watching. Orders placed before
// the journal existed, or during a session it was not running for, are resting
// on the exchange with no line anywhere saying so -- and a coach reading the
// record sees an unprotected position where there is a stop, or a position of
// one size where the exchange holds another.
//
// So this reads the exchange and writes down what it finds. Read-only against
// the exchange: it places nothing, cancels nothing, and amends nothing.
//
// Two kinds of line come out of it, and neither is a fill. Working orders are
// recorded as placed, marked `reconstructed` so nobody later mistakes an
// observation for an event that was witnessed. The position is recorded as a
// reconciliation: what the exchange says beside what the journal derived, with
// the difference left visible rather than reconciled away. Inventing the fills
// that would explain a gap would make the arithmetic agree by fabricating
// trades, which is a worse record than an honest disagreement.
//
// A trail is only written down as armed if it demonstrably armed -- the candle
// history since it was placed shows price reaching its arming price. Arming is
// sticky and measured against the high-water mark, so this is the same test the
// running client applies, and a trail that has not armed gets no line, because
// nothing has happened to it yet.
//
//   npx tsx backfill-state.ts          what it would write
//   npx tsx backfill-state.ts --write  write it

import ccxt from 'ccxt';
import https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describeOrders, orderSentence } from './src/trading/orderView.js';
import {
  Direction,
  JournalEvent,
  dayKey,
  deriveSnapshot,
  readJournalDay,
} from './src/guard/sessionJournal.js';

const write = process.argv.includes('--write');
const directory = path.join(os.homedir(), '.tame', 'journal');

const config = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.tame', 'config.json'), 'utf8')
);
const credentials = config.exchanges?.find(
  (entry: any) => String(entry.exchange).toLowerCase() === 'phemex'
);
if (!credentials) {
  console.error('No Phemex credentials in ~/.tame/config.json');
  process.exit(1);
}

const exchange = new ccxt.phemex({
  apiKey: credentials.key,
  secret: credentials.secret,
  agent: new https.Agent({ family: 4 }),
  options: { defaultType: 'swap' },
});

await exchange.loadMarkets();

const now = Date.now();
const today = dayKey(now);
const existing = readJournalDay(directory, today);
const snapshot = deriveSnapshot(existing, now);

/** Ids already written down, so running this twice does not double the record. */
const alreadyRecorded = new Set(
  existing
    .filter((event): event is Extract<JournalEvent, { type: 'order-placed' }> =>
      event.type === 'order-placed'
    )
    .map((event) => event.orderId)
    .filter((id): id is string => id !== undefined)
);

const armedAlready = new Set(
  existing
    .filter((event): event is Extract<JournalEvent, { type: 'trail-armed' }> =>
      event.type === 'trail-armed'
    )
    .map((event) => event.orderId)
    .filter((id): id is string => id !== undefined)
);

const pending: JournalEvent[] = [];

const positions = (await exchange.fetchPositions()).filter(
  (position: any) => Number(position.contracts ?? 0) > 0
);

const markets = [...new Set(positions.map((position: any) => String(position.symbol)))];
for (const open of snapshot.openPositions) {
  if (!markets.includes(open.market)) markets.push(open.market);
}

for (const market of markets as string[]) {
  const live: any = positions.find((position: any) => position.symbol === market);
  const derivedPosition = snapshot.openPositions.find((open) => open.market === market);

  const observed = live
    ? {
        side: (String(live.side).toLowerCase() === 'long' ? 'long' : 'short') as Direction,
        size: Number(live.contracts),
        entry: Number(live.entryPrice),
      }
    : undefined;

  const derived = derivedPosition
    ? {
        side: derivedPosition.side,
        size: derivedPosition.size,
        entry: derivedPosition.averageEntry,
      }
    : undefined;

  pending.push({ type: 'reconciliation', at: now, market, observed, derived });

  const raw = await exchange.fetchOpenOrders(market);
  const views = describeOrders(raw as any[], {
    // Nothing here has the running client's memory of what armed, so the
    // question is answered from the candles below rather than assumed.
    isTrailArmed: () => false,
  });

  for (let index = 0; index < views.length; index++) {
    const view = views[index];
    const placedAt = view.placedAt ?? now;

    if (!alreadyRecorded.has(view.id)) {
      pending.push({
        type: 'order-placed',
        at: placedAt,
        market,
        orderId: view.id,
        description: orderSentence(view),
        reconstructed: true,
      });
    }

    const trail = view.trail;
    if (!trail || trail.armPrice === undefined || armedAlready.has(view.id)) continue;

    // Did it arm? Measured against the extreme reached since the order was
    // placed, not the current price: arming is sticky, and a pullback after the
    // fact does not undo it.
    const candles = await exchange.fetchOHLCV(market, '5m', placedAt, 1000);
    const selling = view.side === 'SELL';
    const extreme = candles.reduce(
      (best: number, row: any) => (selling ? Math.max(best, Number(row[2])) : Math.min(best, Number(row[3]))),
      selling ? -Infinity : Infinity
    );

    const armed = selling ? extreme >= trail.armPrice : extreme <= trail.armPrice;

    if (!armed) {
      console.log(
        `  ${market} ${view.id.slice(0, 8)}: trail has NOT armed -- ` +
          `arms at ${trail.armPrice}, the extreme since it was placed is ` +
          `${Number(extreme.toFixed(4))}. Nothing to record.`
      );
      continue;
    }

    // Stamped at the candle that first reached the arming price, rather than
    // now: the arming happened then, and dating it now would put it after
    // events it actually preceded.
    const reached = candles.find((row: any) =>
      selling ? Number(row[2]) >= trail.armPrice! : Number(row[3]) <= trail.armPrice!
    );

    pending.push({
      type: 'trail-armed',
      at: reached ? Number(reached[0]) : placedAt,
      market,
      orderId: view.id,
      armPrice: trail.armPrice,
      trigger: view.trigger ?? 0,
    });
  }
}

console.log(`\n=== ${pending.length} event${pending.length === 1 ? '' : 's'} to write ===\n`);
for (const event of pending) {
  console.log(`${new Date(event.at).toISOString()}  ${JSON.stringify(event)}`);
}

if (!write) {
  console.log('\nDry run. Re-run with --write to append these to the journal.');
} else if (pending.length > 0) {
  const file = path.join(directory, `${today}.jsonl`);
  // Appended, never rewritten. Tame may well be running and appending to the
  // same file; an append is atomic and additive, whereas a rewrite would race
  // it and lose whatever it wrote in between.
  fs.appendFileSync(
    file,
    `${pending.map((event) => JSON.stringify(event)).join('\n')}\n`,
    { mode: 0o600 }
  );
  console.log(`\nAppended to ${file}.`);
}
