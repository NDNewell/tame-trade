// One case per detector for firing, and one for the boundary it must not cross.
import {
  averagingDown,
  chasing,
  dailyLossLimit,
  directionFlipping,
  GuardContext,
  leverageCreep,
  lossStreak,
  noStop,
  orderChurn,
  overtrading,
  PositionContext,
  profitGiveback,
  rapidFire,
  revengeEntry,
  riskPerTrade,
  sessionLength,
  sizeEscalation,
  stopRemoved,
  stopWidened,
  OrderProposal,
} from './detectors.js';
import { DEFAULT_POLICY, GuardPolicy } from './guardPolicy.js';
import { ClosedTrade, EntryRecord, SessionSnapshot } from './sessionJournal.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const NOW = 1_000_000;
const MARKET = 'BTC/USDT:USDT';

const emptySnapshot = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  startedAt: NOW - 60_000,
  now: NOW,
  currency: 'USDT',
  trades: [],
  entries: [],
  openPositions: [],
  realizedPnl: 0,
  consecutiveLosses: 0,
  lastLoss: undefined,
  equity: undefined,
  peakEquity: undefined,
  openingEquity: undefined,
  ordersPlaced: 0,
  ordersCancelled: 0,
  fills: 0,
  stopMoves: [],
  stopCancellations: [],
  overrides: [],
  flags: [],
  lockout: undefined,
  ...over,
});

const entryProposal = (over: Partial<OrderProposal> = {}): OrderProposal => ({
  market: MARKET,
  side: 'buy',
  intent: 'entry',
  size: 1,
  ...over,
});

const context = (over: Partial<GuardContext> = {}): GuardContext => ({
  now: NOW,
  policy: DEFAULT_POLICY,
  snapshot: emptySnapshot(),
  proposal: entryProposal(),
  ...over,
});

const trade = (pnl: number, closedAt: number, market = MARKET): ClosedTrade => ({
  market,
  side: 'long',
  size: 1,
  entryPrice: 100,
  exitPrice: 100 + pnl,
  realizedPnl: pnl,
  openedAt: closedAt - 60_000,
  closedAt,
});

const entry = (at: number, size = 1, side: 'long' | 'short' = 'long'): EntryRecord => ({
  at,
  market: MARKET,
  side,
  size,
  price: 100,
  added: false,
});

const position = (over: Partial<PositionContext> = {}): PositionContext => ({
  market: MARKET,
  side: 'long',
  size: 1,
  entryPrice: 100,
  hasProtectiveStop: true,
  ...over,
});

// --- revenge ---------------------------------------------------------------
const loss = trade(-420, NOW - 2 * 60_000);
check('   revenge-entry fires on an entry soon after a loss',
  revengeEntry(context({ snapshot: emptySnapshot({ trades: [loss], lastLoss: loss }) })) !==
    undefined,
  'loss closed two minutes ago');

const oldLoss = trade(-420, NOW - 30 * 60_000);
check('   revenge-entry stays quiet once the window has passed',
  revengeEntry(context({ snapshot: emptySnapshot({ trades: [oldLoss], lastLoss: oldLoss }) })) ===
    undefined,
  'loss closed thirty minutes ago');

check('   revenge-entry never fires on an exit',
  revengeEntry(
    context({
      proposal: entryProposal({ intent: 'exit' }),
      snapshot: emptySnapshot({ trades: [loss], lastLoss: loss }),
    })
  ) === undefined,
  'the order reduces a position');

// --- rapid fire ------------------------------------------------------------
const threeRecent = [entry(NOW - 300_000), entry(NOW - 200_000), entry(NOW - 100_000)];
check('   rapid-fire counts the order being proposed, not just the fills',
  rapidFire(context({ snapshot: emptySnapshot({ entries: threeRecent }) })) !== undefined,
  'three entries plus this one, against a threshold of four');

check('   rapid-fire ignores entries outside the window',
  rapidFire(
    context({ snapshot: emptySnapshot({ entries: threeRecent.map((e) => ({ ...e, at: 1 })) }) })
  ) === undefined,
  'the same three entries, hours ago');

check('   rapid-fire is scoped to one market',
  rapidFire(
    context({
      snapshot: emptySnapshot({
        entries: threeRecent.map((e) => ({ ...e, market: 'ETH/USDT:USDT' })),
      }),
    })
  ) === undefined,
  'three entries elsewhere do not make this one rapid');

// --- size escalation -------------------------------------------------------
const smallEntries = [entry(NOW - 400_000, 1), entry(NOW - 300_000, 1), entry(NOW - 200_000, 1)];
check('   size-escalation fires on a big order into a losing session',
  sizeEscalation(
    context({
      proposal: entryProposal({ size: 3 }),
      snapshot: emptySnapshot({ entries: smallEntries, realizedPnl: -500 }),
    })
  ) !== undefined,
  '3x the median of 1, session down 500');

check('   size-escalation stays quiet when the session is green',
  sizeEscalation(
    context({
      proposal: entryProposal({ size: 3 }),
      snapshot: emptySnapshot({ entries: smallEntries, realizedPnl: 500 }),
    })
  ) === undefined,
  'pressing a winning day is not this behaviour');

check('   size-escalation needs a baseline before it will judge one',
  sizeEscalation(
    context({
      proposal: entryProposal({ size: 3 }),
      snapshot: emptySnapshot({ entries: smallEntries.slice(0, 2), realizedPnl: -500 }),
    })
  ) === undefined,
  'two entries are two numbers, not a baseline');

check('   size-escalation uses the median, so one early outlier cannot raise the bar',
  sizeEscalation(
    context({
      proposal: entryProposal({ size: 3 }),
      snapshot: emptySnapshot({
        entries: [entry(NOW - 400_000, 10), entry(NOW - 300_000, 1), entry(NOW - 200_000, 1)],
        realizedPnl: -500,
      }),
    })
  ) !== undefined,
  'median stays 1 despite a size-10 entry earlier');

// --- averaging down --------------------------------------------------------
check('   averaging-down fires when adding to an underwater position',
  averagingDown(
    context({ position: position({ unrealizedPnl: -200 }) })
  ) !== undefined,
  'long is down 200 and this buys more');

check('   averaging-down ignores an order in the other direction',
  averagingDown(
    context({
      proposal: entryProposal({ side: 'sell' }),
      position: position({ unrealizedPnl: -200 }),
    })
  ) === undefined,
  'selling into a long reduces it, whatever it was typed as');

check('   averaging-down stays quiet on a winning position',
  averagingDown(context({ position: position({ unrealizedPnl: 200 }) })) === undefined,
  'adding to a winner is a different decision');

// --- chasing ---------------------------------------------------------------
check('   chasing fires on an entry into a move that already happened',
  chasing(context({ priceMove: { percent: 2.5, overMs: 120_000 } })) !== undefined,
  'up 2.5% and buying');

check('   chasing does not fire on an entry against the move',
  chasing(context({ priceMove: { percent: -2.5, overMs: 120_000 } })) === undefined,
  'down 2.5% and buying is a different trade, right or wrong');

// --- flipping --------------------------------------------------------------
check('   direction-flipping counts reversals including the proposed one',
  directionFlipping(
    context({
      snapshot: emptySnapshot({
        entries: [
          entry(NOW - 300_000, 1, 'long'),
          entry(NOW - 200_000, 1, 'short'),
          entry(NOW - 100_000, 1, 'long'),
        ],
      }),
      proposal: entryProposal({ side: 'sell' }),
    })
  ) !== undefined,
  'long, short, long, and now short again');

check('   direction-flipping stays quiet on a consistent direction',
  directionFlipping(
    context({
      snapshot: emptySnapshot({
        entries: [entry(NOW - 300_000), entry(NOW - 200_000), entry(NOW - 100_000)],
      }),
    })
  ) === undefined,
  'four longs in a row is not flipping');

// --- churn -----------------------------------------------------------------
check('   order-churn fires on many cancels against few fills',
  orderChurn(
    context({ snapshot: emptySnapshot({ ordersPlaced: 12, ordersCancelled: 10, fills: 1 }) })
  ) !== undefined,
  '10 cancels, 1 fill');

check('   order-churn needs enough orders to be a ratio rather than noise',
  orderChurn(
    context({ snapshot: emptySnapshot({ ordersPlaced: 3, ordersCancelled: 3, fills: 0 }) })
  ) === undefined,
  'three orders is not a pattern');

// --- no stop ---------------------------------------------------------------
check('   no-stop fires once the grace period has passed',
  noStop(
    context({
      position: position({ hasProtectiveStop: false, openedAt: NOW - 10 * 60_000 }),
    })
  ) !== undefined,
  'ten minutes unprotected');

check('   no-stop allows the grace period for a stop to be placed',
  noStop(
    context({ position: position({ hasProtectiveStop: false, openedAt: NOW - 30_000 }) })
  ) === undefined,
  'thirty seconds old');

check('   no-stop says nothing about a position whose age is unknown',
  noStop(context({ position: position({ hasProtectiveStop: false }) })) === undefined,
  'a position found on startup must not be flagged the instant we connect');

// --- stop discipline -------------------------------------------------------
check('   stop-widened fires when a long stop is moved down',
  stopWidened(
    context({
      snapshot: emptySnapshot({
        stopMoves: [
          { type: 'stop-moved', at: NOW - 60_000, market: MARKET, side: 'long', from: 95, to: 90 },
        ],
      }),
    })
  ) !== undefined,
  '95 -> 90 on a long');

check('   stop-widened never fires on a stop moving up on a long',
  stopWidened(
    context({
      snapshot: emptySnapshot({
        stopMoves: [
          { type: 'stop-moved', at: NOW - 60_000, market: MARKET, side: 'long', from: 90, to: 95 },
        ],
      }),
    })
  ) === undefined,
  'that is the trail doing its job');

check('   stop-widened fires when a short stop is moved up',
  stopWidened(
    context({
      snapshot: emptySnapshot({
        stopMoves: [
          { type: 'stop-moved', at: NOW - 60_000, market: MARKET, side: 'short', from: 105, to: 110 },
        ],
      }),
    })
  ) !== undefined,
  '105 -> 110 on a short');

check('   stop-removed only fires when the position was losing',
  stopRemoved(
    context({
      snapshot: emptySnapshot({
        stopCancellations: [
          { type: 'stop-cancelled', at: NOW - 60_000, market: MARKET, trigger: 95, underwater: true },
        ],
      }),
    })
  ) !== undefined &&
    stopRemoved(
      context({
        snapshot: emptySnapshot({
          stopCancellations: [
            {
              type: 'stop-cancelled',
              at: NOW - 60_000,
              market: MARKET,
              trigger: 95,
              underwater: false,
            },
          ],
        }),
      })
    ) === undefined,
  'pulling a stop on a winner is routine; on a loser it is not');

// --- sizing risk -----------------------------------------------------------
check('   risk-per-trade fires above the configured percentage of equity',
  riskPerTrade(
    context({ position: position({ plannedRisk: 300 }), equity: 10_000 })
  ) !== undefined,
  '300 of 10,000 is 3% against a 1% limit');

check('   risk-per-trade says nothing when downside cannot be stated',
  riskPerTrade(context({ position: position(), equity: 10_000 })) === undefined,
  'no planned risk means no claim');

check('   leverage-creep fires above the configured multiple',
  leverageCreep(
    context({ position: position({ notional: 150_000 }), equity: 10_000 })
  ) !== undefined,
  '15x against a 10x mark');

// --- discipline ------------------------------------------------------------
const withLimit: GuardPolicy = { ...DEFAULT_POLICY, dailyLossLimit: 500 };
check('   daily-loss-limit fires once realized losses reach it',
  dailyLossLimit(
    context({ policy: withLimit, snapshot: emptySnapshot({ realizedPnl: -600 }) })
  ) !== undefined,
  'down 600 against a 500 limit');

check('   daily-loss-limit does nothing when no limit was set',
  dailyLossLimit(context({ snapshot: emptySnapshot({ realizedPnl: -100_000 }) })) === undefined,
  'the one rule that blocks only exists because it was typed');

check('   loss-streak fires at the configured run',
  lossStreak(
    context({
      snapshot: emptySnapshot({
        consecutiveLosses: 3,
        trades: [trade(-10, 1), trade(-20, 2), trade(-30, 3)],
      }),
    })
  ) !== undefined,
  'three in a row');

check('   overtrading fires on the round-trip count',
  overtrading(
    context({ snapshot: emptySnapshot({ trades: Array.from({ length: 20 }, (_, i) => trade(1, i)) }) })
  ) !== undefined,
  '20 round trips against a limit of 20');

check('   profit-giveback measures against the profit at the peak, not the peak',
  profitGiveback(
    context({
      snapshot: emptySnapshot({ openingEquity: 10_000, peakEquity: 11_000, equity: 10_500 }),
    })
  ) !== undefined,
  'up 1,000, handed back 500 of it — 50% against a 40% threshold');

check('   profit-giveback stays quiet on a day that never went green',
  profitGiveback(
    context({ snapshot: emptySnapshot({ openingEquity: 10_000, peakEquity: 10_000, equity: 9_000 }) })
  ) === undefined,
  'a red day is a different problem, and the loss limit is the rule for it');

check('   session-length fires past the configured stretch',
  sessionLength(
    context({ snapshot: emptySnapshot({ startedAt: NOW - 5 * 3_600_000 }) })
  ) !== undefined,
  'five hours against four');

console.log(`\n${failures === 0 ? 'PASS: all detector cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
