// Read-only. Places nothing, cancels nothing. Prints no keys.
//
//   npx tsx read-my-equity.ts
//
// Prints the wallet balance, the unrealized total across every open position,
// and the equity Tame derives from them, so they can be checked against what
// the exchange shows on screen.

import ccxt from 'ccxt';
import https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const currency = process.argv[2] ?? 'USDT';

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.tame', 'config.json'), 'utf8')
);
const phemex = cfg.exchanges.find(
  (e: any) => String(e.exchange).toLowerCase() === 'phemex'
);
if (!phemex) {
  console.error('No Phemex credentials found in ~/.tame/config.json');
  process.exit(1);
}

const ex = new ccxt.phemex({
  apiKey: phemex.key,
  secret: phemex.secret,
  agent: new https.Agent({ family: 4 }),
  options: { defaultType: 'swap' },
});

await ex.loadMarkets();

const balance: any = await ex.fetchBalance({ type: 'swap', code: currency });
const wallet = Number(balance?.total?.[currency]);

console.log(`\n=== ${currency} ===\n`);
console.log(`free   ${balance?.free?.[currency]}`);
console.log(`used   ${balance?.used?.[currency]}`);
console.log(`total  ${wallet}   <- Tame calls this Balance`);

const positions = await ex.fetchPositions(undefined, { type: 'swap', code: currency });
const open = positions.filter((p: any) => Number(p.contracts) > 0);

console.log(`\nOPEN POSITIONS: ${open.length}`);
let unrealized = 0;
for (const p of open) {
  // Mirrors ExchangeClient.unrealizedPnlOf: value the position at the mark the
  // exchange stamped on it, so entry, mark and unrealized share one instant.
  const m: any = ex.markets[p.symbol as string];
  const size = Number(m?.contractSize ?? 1);
  const dir = String(p.side).toLowerCase() === 'long' ? 1 : -1;
  const qty = Math.abs(Number(p.contracts));
  const entry = Number(p.entryPrice);
  const mark = Number((p as any).markPrice);
  const derived = m?.inverse
    ? qty * size * (1 / entry - 1 / mark) * dir
    : qty * size * (mark - entry) * dir;
  unrealized += derived;
  console.log(`  ${p.symbol}  ${p.side} ${qty} @ ${entry}  mark=${mark}`);
  console.log(`     unrealized = (${mark} - ${entry}) * ${qty} = ${derived.toFixed(4)}`);
  console.log(`     ccxt unrealizedPnl = ${(p as any).unrealizedPnl}  <- unusable on Phemex`);
}

console.log(`\nunrealized total  ${unrealized}`);
console.log(`equity            ${wallet + unrealized}   <- Tame calls this Equity`);
console.log(`\nCompare both against Phemex.`);

process.exit(0);
