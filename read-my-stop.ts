// Read-only. Places nothing. Prints no keys.
//
// Set a stop on Phemex the way you want it (the one you like), then run:
//   npx tsx read-my-stop.ts SOL/USDT:USDT
// and paste the output back.

import ccxt from 'ccxt';
import https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const symbol = process.argv[2] ?? 'SOL/USDT:USDT';

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
console.log(`\n=== ${symbol} ===\n`);

// 1. The position, including any TP/SL stored on it.
try {
  const positions = await ex.fetchPositions([symbol]);
  for (const p of positions) {
    if (!p.contracts) continue;
    console.log(`POSITION  ${p.side} ${p.contracts} @ ${p.entryPrice}`);
    const raw: any = p.info ?? {};
    const tpsl = Object.keys(raw)
      .filter((k) => /stopLoss|takeProfit|slTrigger|tpTrigger|posSide/i.test(k))
      .reduce((a: any, k) => ((a[k] = raw[k]), a), {});
    console.log('  TP/SL fields on the position:');
    console.log('  ' + JSON.stringify(tpsl, null, 2).replace(/\n/g, '\n  '));
  }
  if (!positions.some((p) => p.contracts)) console.log('POSITION  (none open)');
} catch (e) {
  console.log('POSITION  could not read:', (e as Error).message);
}

// 2. Any open trigger/conditional orders, as Phemex reports them.
for (const [label, params] of [
  ['open orders', {}],
  ['conditional orders', { untriggered: true }],
] as [string, any][]) {
  try {
    const orders = await ex.fetchOpenOrders(symbol, undefined, undefined, params);
    console.log(`\n${label.toUpperCase()}: ${orders.length}`);
    for (const o of orders) {
      console.log(
        `  ${o.type} ${o.side} ${o.amount} trigger=${o.triggerPrice ?? '-'} reduceOnly=${o.reduceOnly}`
      );
      console.log('  raw: ' + JSON.stringify(o.info));
    }
  } catch (e) {
    console.log(`\n${label.toUpperCase()}: could not read - ${(e as Error).message}`);
  }
}

process.exit(0);
