// Round trips, realized PnL, and what the session snapshot derives from them.
import {
  applyFill,
  deriveSnapshot,
  realizedFor,
  FillEvent,
  JournalEvent,
  OpenPosition,
} from './sessionJournal.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};
const near = (a: number | undefined, b: number, tolerance = 1e-6) =>
  a !== undefined && Math.abs(a - b) < tolerance;

const fill = (
  side: 'buy' | 'sell',
  size: number,
  price: number,
  at: number,
  extra: Partial<FillEvent> = {}
): FillEvent => ({
  type: 'fill',
  at,
  market: 'BTC/USDT:USDT',
  side,
  size,
  price,
  ...extra,
});

// --- one round trip --------------------------------------------------------
let state = applyFill(undefined, fill('buy', 1, 100, 1000));
check('   a first fill opens a position and counts as an entry',
  state.open?.side === 'long' && state.entry?.added === false && !state.closed,
  `side=${state.open?.side} entry=${state.entry !== undefined}`);

let done = applyFill(state.open, fill('sell', 1, 110, 2000));
check('   closing a long reports the profit and clears the position',
  done.open === undefined && near(done.closed?.realizedPnl, 10),
  `pnl=${done.closed?.realizedPnl}`);

// --- scaling out -----------------------------------------------------------
state = applyFill(undefined, fill('buy', 2, 100, 1000));
state = applyFill(state.open, fill('sell', 1, 110, 2000));
check('   a partial exit does not close the trade',
  state.closed === undefined && state.open?.size === 1,
  `size=${state.open?.size} carried=${state.open?.realizedSoFar}`);

done = applyFill(state.open, fill('sell', 1, 90, 3000));
check('   a scaled-out trade reports one number, not one per tranche',
  near(done.closed?.realizedPnl, 0),
  `pnl=${done.closed?.realizedPnl} (+10 then -10)`);

// --- adding ----------------------------------------------------------------
state = applyFill(undefined, fill('buy', 1, 100, 1000));
state = applyFill(state.open, fill('buy', 1, 120, 2000));
check('   adding re-averages the entry and is recorded as an add',
  near(state.open?.averageEntry, 110) && state.entry?.added === true,
  `entry=${state.open?.averageEntry} added=${state.entry?.added}`);

// --- reversing through flat ------------------------------------------------
state = applyFill(undefined, fill('buy', 1, 100, 1000));
done = applyFill(state.open, fill('sell', 3, 110, 2000));
check('   a reversal closes the old trade and opens the new one',
  near(done.closed?.realizedPnl, 10) &&
    done.open?.side === 'short' &&
    done.open?.size === 2 &&
    done.entry?.side === 'short',
  `closed=${done.closed?.realizedPnl} newSide=${done.open?.side} newSize=${done.open?.size}`);

// --- shorts ----------------------------------------------------------------
state = applyFill(undefined, fill('sell', 1, 100, 1000));
done = applyFill(state.open, fill('buy', 1, 90, 2000));
check('   a short profits when price falls',
  near(done.closed?.realizedPnl, 10), `pnl=${done.closed?.realizedPnl}`);

// --- inverse contracts -----------------------------------------------------
const inverseProfit = realizedFor('long', 100, 110, 1000, 1, true);
check('   inverse longs settle in the base asset and profit when price rises',
  inverseProfit > 0 && near(inverseProfit, 1000 * (1 / 100 - 1 / 110)),
  `profit=${inverseProfit.toFixed(6)}`);
check('   inverse shorts are the mirror of that',
  near(realizedFor('short', 100, 90, 1000, 1, true), 1000 * (1 / 90 - 1 / 100)),
  `profit=${realizedFor('short', 100, 90, 1000, 1, true).toFixed(6)}`);

// --- fees ------------------------------------------------------------------
state = applyFill(undefined, fill('buy', 1, 100, 1000, { fee: 1 }));
done = applyFill(state.open, fill('sell', 1, 110, 2000, { fee: 1 }));
check('   fees on both sides come out of the realized number',
  near(done.closed?.realizedPnl, 8), `pnl=${done.closed?.realizedPnl}`);

// --- snapshot --------------------------------------------------------------
const events: JournalEvent[] = [
  { type: 'equity', at: 1000, equity: 10_000, currency: 'USDT' },
  fill('buy', 1, 100, 1100),
  fill('sell', 1, 90, 1200),
  { type: 'equity', at: 1300, equity: 10_500, currency: 'USDT' },
  fill('buy', 1, 100, 1400),
  fill('sell', 1, 95, 1500),
  { type: 'equity', at: 1600, equity: 10_100, currency: 'USDT' },
  fill('buy', 1, 100, 1700),
  fill('sell', 1, 98, 1800),
];

let snapshot = deriveSnapshot(events, 2000);
check('   the snapshot counts round trips and sums their realized PnL',
  snapshot.trades.length === 3 && near(snapshot.realizedPnl, -17),
  `trades=${snapshot.trades.length} pnl=${snapshot.realizedPnl}`);
check('   a losing streak is counted back from the most recent trade',
  snapshot.consecutiveLosses === 3, `streak=${snapshot.consecutiveLosses}`);
check('   the equity peak ratchets and the opening equity is the first seen',
  snapshot.peakEquity === 10_500 && snapshot.openingEquity === 10_000,
  `peak=${snapshot.peakEquity} opening=${snapshot.openingEquity}`);
check('   the currency is picked up from the equity samples',
  snapshot.currency === 'USDT', `currency="${snapshot.currency}"`);

// A win in the middle breaks the streak.
snapshot = deriveSnapshot(
  [...events, fill('buy', 1, 100, 1900), fill('sell', 1, 120, 1950)],
  2000
);
check('   a winning trade ends the streak',
  snapshot.consecutiveLosses === 0, `streak=${snapshot.consecutiveLosses}`);

// --- lockouts --------------------------------------------------------------
const locked = deriveSnapshot(
  [{ type: 'lockout', at: 1000, until: 5000, behaviour: 'loss-streak', reason: 'three in a row' }],
  2000
);
check('   a lockout that has not expired is in force',
  locked.lockout?.until === 5000, `until=${locked.lockout?.until}`);

const expired = deriveSnapshot(
  [{ type: 'lockout', at: 1000, until: 5000, behaviour: 'loss-streak', reason: 'three in a row' }],
  6000
);
check('   an expired lockout is resolved away rather than left for callers',
  expired.lockout === undefined, `lockout=${expired.lockout}`);

const lifted = deriveSnapshot(
  [
    { type: 'lockout', at: 1000, until: 9000, behaviour: 'loss-streak', reason: 'x' },
    { type: 'lockout-lifted', at: 2000, reason: 'deliberate' },
  ],
  3000
);
check('   a lockout that was lifted stays lifted',
  lifted.lockout === undefined, `lockout=${lifted.lockout}`);

const extended = deriveSnapshot(
  [
    { type: 'lockout', at: 1000, until: 4000, behaviour: 'loss-streak', reason: 'x' },
    { type: 'lockout', at: 1500, until: 9000, behaviour: 'daily-loss-limit', reason: 'y' },
  ],
  2000
);
check('   overlapping lockouts resolve to the one that ends last',
  extended.lockout?.until === 9000, `until=${extended.lockout?.until}`);

// --- churn counters --------------------------------------------------------
snapshot = deriveSnapshot(
  [
    { type: 'order-placed', at: 1, market: 'X' },
    { type: 'order-placed', at: 2, market: 'X' },
    { type: 'order-cancelled', at: 3, market: 'X' },
    fill('buy', 1, 100, 4),
  ],
  10
);
check('   places, cancels and fills are counted separately',
  snapshot.ordersPlaced === 2 && snapshot.ordersCancelled === 1 && snapshot.fills === 1,
  `placed=${snapshot.ordersPlaced} cancelled=${snapshot.ordersCancelled} fills=${snapshot.fills}`);

// --- out-of-order arrival --------------------------------------------------
snapshot = deriveSnapshot([fill('sell', 1, 110, 2000), fill('buy', 1, 100, 1000)], 3000);
check('   events arriving out of order are replayed in the order they happened',
  snapshot.trades.length === 1 && near(snapshot.trades[0]?.realizedPnl, 10),
  `trades=${snapshot.trades.length} pnl=${snapshot.trades[0]?.realizedPnl}`);

console.log(`\n${failures === 0 ? 'PASS: all session-journal cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
