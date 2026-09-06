// Read-only. Places nothing, changes nothing. Prints no keys.
//
//   npx tsx read-my-leverage.ts SOL/USDT:USDT
//
// Paste the output back so the effective-leverage denominator can be solved
// against what Phemex actually shows.

import ccxt from 'ccxt';
import https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const symbol = process.argv[2] ?? 'SOL/USDT:USDT';
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.tame', 'config.json'), 'utf8'));
const phemex = cfg.exchanges.find((e: any) => String(e.exchange).toLowerCase() === 'phemex');
if (!phemex) { console.error('No Phemex credentials found'); process.exit(1); }

const ex = new ccxt.phemex({
  apiKey: phemex.key,
  secret: phemex.secret,
  agent: new https.Agent({ family: 4 }),
});
const markets = await ex.loadMarkets();
const m = markets[symbol];

console.log(`\n=== ${symbol} ===`);

const positions = await ex.fetchPositions([symbol]);
const p: any = positions.find((x: any) => Number(x.contracts) !== 0);
if (!p) { console.log('No open position.'); process.exit(0); }

console.log('\nPOSITION');
for (const k of ['side','contracts','contractSize','entryPrice','markPrice','notional','unrealizedPnl',
                 'collateral','initialMargin','maintenanceMargin','marginRatio','leverage','marginMode','liquidationPrice'])
  if (p[k] !== undefined && p[k] !== null) console.log(`  ${k.padEnd(22)} ${p[k]}`);

console.log('\nPOSITION raw fields (margin / balance / leverage)');
for (const k of Object.keys(p.info ?? {}))
  if (/margin|balance|leverage|posCost|value|equity|risk/i.test(k)) console.log(`  ${k.padEnd(26)} ${p.info[k]}`);

console.log('\nPOSITION raw fields (PnL / fees / funding) -- every one, unfiltered by scale');
for (const k of Object.keys(p.info ?? {}))
  if (/pnl|fee|funding|closed|realis|realiz/i.test(k)) console.log(`  ${k.padEnd(26)} ${p.info[k]}`);

console.log('\nWHAT TAME CURRENTLY READS');
const rv = p.info?.curTermRealisedPnlRv ?? p.info?.cumClosedPnlRv;
const ev = p.info?.curTermRealisedPnlEv ?? p.info?.cumClosedPnlEv;
console.log(`  curTermRealisedPnlRv       ${p.info?.curTermRealisedPnlRv}`);
console.log(`  cumClosedPnlRv             ${p.info?.cumClosedPnlRv}`);
console.log(`  -> Tame shows              ${rv !== undefined ? Number(rv) : (ev !== undefined ? Number(ev)/1e8 : '--')}`);
console.log('\n  Compare against the Realized PnL Phemex shows for this position.');

const settle = String(m?.settle ?? 'USDT');
const bal: any = await ex.fetchBalance({ type: 'swap', code: settle });
console.log(`\nBALANCE (${settle})`);
console.log(`  free                   ${bal.free?.[settle]}`);
console.log(`  used                   ${bal.used?.[settle]}`);
console.log(`  total                  ${bal.total?.[settle]}`);

const acct = bal?.info?.data?.account ?? bal?.info?.account ?? {};
console.log('\nACCOUNT raw fields');
for (const k of Object.keys(acct))
  if (/balance|equity|margin|bonus|pnl|accountId|userID/i.test(k)) console.log(`  ${k.padEnd(26)} ${acct[k]}`);

const notional = Math.abs(Number(p.notional ?? 0));
const upnl = Number(p.unrealizedPnl ?? 0);
const total = Number(bal.total?.[settle] ?? 0);
const show = (label: string, v: number) => console.log(`  ${label.padEnd(34)} ${Number.isFinite(v) ? v.toFixed(2) : '--'}x`);
const free = Number(bal.free?.[settle] ?? NaN);
const posMargin = Number(p.info?.positionMarginRv ?? p.collateral ?? NaN);
const posCost = Number(p.info?.posCostRv ?? NaN);

console.log(`\nREAD AT ${new Date().toISOString()}`);
console.log('Note the number Phemex shows AT THIS MOMENT and paste it with this output.\n');
console.log('CANDIDATE DENOMINATORS');
show('notional / balance                [live]', notional / total);
show('notional / (balance + upnl)', notional / (total + upnl));
show('notional / free', notional / free);
show('notional / (free + positionMargin)', notional / (free + posMargin));
show('notional / (balance - (posCost - posMargin))', notional / (total - (posCost - posMargin)));
show('notional / positionMargin', notional / posMargin);
show('notional / posCost', notional / posCost);
console.log(`\n  unrealizedPnl at this instant: ${upnl}`);
console.log('  (if this is near zero, formulas that differ only by upnl cannot be told apart)');
process.exit(0);
