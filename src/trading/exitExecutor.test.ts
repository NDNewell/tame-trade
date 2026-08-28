// The executor against a fake book. It sends real orders in production, so the
// cases here are mostly about what it must refuse to do.
import { planExit } from './exitPlan.js';
import { ExitExecutionPort, ExitExecutor } from './exitExecutor.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const MARKET = 'BTC/USDT:USDT';

interface Sent {
  side: 'buy' | 'sell';
  size: number;
  price?: number;
  reduceOnly: true;
}

/**
 * A book that fills everything instantly unless told otherwise, plus a record
 * of every order the executor tried to send.
 */
function fakePort(over: Partial<ExitExecutionPort> & { position?: number; fillRatio?: number } = {}) {
  const sent: Sent[] = [];
  let position = over.position ?? 10;
  const fillRatio = over.fillRatio ?? 1;
  const fills = new Map<string, number>();
  let counter = 0;

  const port: ExitExecutionPort = {
    book: async () => ({ bestBid: 99.9, bestAsk: 100.1, tick: 0.1 }),
    positionSize: async () => position,
    placeReduceOnlyLimit: async (_m, side, size, price) => {
      sent.push({ side, size, price, reduceOnly: true });
      const id = `o${counter++}`;
      const filled = size * fillRatio;
      fills.set(id, filled);
      position = Math.max(0, position - filled);
      return id;
    },
    placeReduceOnlyMarket: async (_m, side, size) => {
      sent.push({ side, size, reduceOnly: true });
      position = Math.max(0, position - size);
      return `m${counter++}`;
    },
    cancelOrder: async () => {},
    filledOf: async (_m, id) => fills.get(id) ?? 0,
    say: () => {},
    wait: async () => {},
    ...over,
  };

  return { port, sent, size: () => position };
}

const plan = planExit(
  { side: 'long', size: 10, markPrice: 100, bestBid: 99.9, bestAsk: 100.1, tick: 0.1, touchDepth: 3 },
  'measured'
);

// --- the happy path --------------------------------------------------------
let fake = fakePort();
let result = await new ExitExecutor(fake.port).run(MARKET, 'long', plan, 0, () => 0);
check('   a long is exited by selling',
  fake.sent.every((order) => order.side === 'sell'),
  `sides=[${[...new Set(fake.sent.map((o) => o.side))].join(', ')}]`);
check('   every child is reduce-only',
  fake.sent.every((order) => order.reduceOnly === true), `${fake.sent.length} children`);
check('   the run ends flat and says so',
  result.outcome === 'flat' && result.remaining === 0,
  `outcome=${result.outcome} remaining=${result.remaining}`);
check('   it never sends more than the position',
  fake.sent.reduce((sum, o) => sum + o.size, 0) <= 10 + 1e-9,
  `sent=${fake.sent.reduce((sum, o) => sum + o.size, 0).toFixed(4)} position=10`);

// --- a short is the mirror -------------------------------------------------
fake = fakePort();
await new ExitExecutor(fake.port).run(MARKET, 'short', plan, 0, () => 0);
check('   a short is exited by buying',
  fake.sent.every((order) => order.side === 'buy'),
  `sides=[${[...new Set(fake.sent.map((o) => o.side))].join(', ')}]`);

// --- nothing to do ---------------------------------------------------------
fake = fakePort({ position: 0 });
result = await new ExitExecutor(fake.port).run(MARKET, 'long', plan, 0, () => 0);
check('   a flat position sends nothing at all',
  fake.sent.length === 0 && result.outcome === 'flat',
  `sent=${fake.sent.length}`);

// --- the position closes underneath it -------------------------------------
let calls = 0;
fake = fakePort({
  positionSize: async () => (calls++ === 0 ? 10 : 0),
});
result = await new ExitExecutor(fake.port).run(MARKET, 'long', plan, 0, () => 0);
check('   it stops immediately if the position closes while it is working',
  fake.sent.length === 0 && result.outcome === 'flat',
  `sent=${fake.sent.length} reason="${result.reason}"`);

// --- children that will not fill escalate ----------------------------------
fake = fakePort({ fillRatio: 0 });
await new ExitExecutor(fake.port).run(MARKET, 'long', plan, 0, () => 0);
const prices = fake.sent.filter((o) => o.price !== undefined).map((o) => o.price!);
check('   an unfilled child is repriced more aggressively rather than left resting',
  prices.length > plan.slices.length && Math.min(...prices) < 99.9,
  `prices=[${prices.slice(0, 6).map((p) => p.toFixed(2)).join(', ')}...]`);
check('   a plan that cannot fill still terminates at market',
  fake.sent.some((o) => o.price === undefined),
  'an unpriced child was sent at the deadline');

// --- abort -----------------------------------------------------------------
fake = fakePort({ fillRatio: 0 });
const executor = new ExitExecutor(fake.port);
executor.abort();
result = await executor.run(MARKET, 'long', plan, 0, () => 0);
check('   an aborted run sends nothing',
  fake.sent.length === 0 && result.outcome === 'aborted',
  `sent=${fake.sent.length} outcome=${result.outcome}`);

// --- a rejected placement stops the run ------------------------------------
fake = fakePort({ placeReduceOnlyLimit: async () => undefined });
result = await new ExitExecutor(fake.port).run(MARKET, 'long', plan, 0, () => 0);
check('   a rejected child does not cause the loop to spin',
  result.outcome === 'partial' || result.outcome === 'flat',
  `outcome=${result.outcome} reason="${result.reason}"`);

// --- an error in the port is contained -------------------------------------
fake = fakePort({
  placeReduceOnlyLimit: async () => {
    throw new Error('exchange said no');
  },
});
result = await new ExitExecutor(fake.port).run(MARKET, 'long', plan, 0, () => 0);
check('   an exception ends the run and reports what is still open',
  result.outcome === 'aborted' && result.remaining === 10,
  `outcome=${result.outcome} remaining=${result.remaining}`);

console.log(`\n${failures === 0 ? 'PASS: all exit-executor cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
