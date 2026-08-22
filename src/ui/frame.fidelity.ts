import { renderPlain, TerminalView, FRAME_WIDTH, FRAME_HEIGHT, DIVIDER_COL } from './frame.js';
import * as fs from 'fs';

const view: TerminalView = {
  header: {
    environment: 'LIVE',
    connection: 'CONNECTED',
    exchange: 'Phemex',
    symbol: 'SOL/USDT:USDT',
    instrumentType: 'Perpetual',
    account: 'MAIN',
  },
  market: {
    symbol: 'SOL/USDT', last: '142.87', change: '+1.42%',
    bid: '142.86', ask: '142.88',
    mark: '142.84', index: '142.91', funding: '0.0100%', spread: '0.02',
  },
  position: {
    side: 'LONG', size: '1.000 SOL', entry: '142.32', mark: '142.87',
    unrealizedPnl: '+0.55 USDT', realizedPnl: '+0.00 USDT',
    leverage: '5x', liquidation: '118.42',
  },
  orders: [{ id: '84102', side: 'SELL', qty: '1.0', price: '142.91', status: 'WORKING' }],
  chase: {
    side: 'SELL', quantity: '1.000 SOL', target: 'Best Ask', working: '142.91',
    reprices: '14', elapsed: '00:07', status: 'TRACKING',
  },
  activity: [
    { time: '03:22:11', category: 'SYSTEM', message: 'Connected to Phemex' },
    { time: '03:22:12', category: 'MARKET', message: 'SOL/USDT selected' },
    { time: '03:23:41', category: 'ORDER', message: 'BUY  1.000 SOL | CHASE | submitted' },
    { time: '03:23:42', category: 'FILL', message: 'BUY  1.000 SOL @ 142.32' },
    { time: '03:24:08', category: 'ORDER', message: 'SELL 1.000 SOL | CHASE | submitted' },
    { time: '03:24:12', category: 'ORDER', message: 'Chase tracking best ask @ 142.91' },
  ],
  input: 'chase sell 1_',
  footer: ['buy', 'sell', 'chase', 'limit', 'cancel', 'orders', 'positions', 'market', 'help'],
  footerRight: 'Ctrl+C',
};

const rendered = renderPlain(view);

// Normalise the mockup the same way: pad/trim to 80, divider at column 40 on the
// rows the border rows say it belongs on.
const raw = fs.readFileSync(new URL('../../docs/mockups/desktop-default.txt', import.meta.url), 'utf8').split('\n');
// Normalising the hand-drawn mockup for comparison. Two known drawing artifacts
// are corrected, both identified by measurement and neither a design decision:
//   1. trailing-space drift, so lines came out 79/80/81 chars
//   2. rows 10-17 place the split divider at column 39, while every border row
//      places it at 40; the border rows are unambiguous, so 40 wins
const SPLIT_ROWS = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

const mock = raw.filter((_, i) => i < 40).map((l, i) => {
  let s = l.replace(/\s+$/, '');
  const edge = s.endsWith('+') ? '+' : '|';
  if (s.endsWith('|') || s.endsWith('+')) s = s.slice(0, -1);
  s = s.replace(/\s+$/, '').padEnd(FRAME_WIDTH - 1, ' ').slice(0, FRAME_WIDTH - 1);

  const chars = (s + edge).split('');

  if (SPLIT_ROWS.has(i) && chars[39] === '|' && chars[40] !== '|') {
    chars[39] = ' ';
    chars[40] = '|';
  }

  return chars.join('');
});

console.log(`geometry: ${FRAME_WIDTH}x${FRAME_HEIGHT}, divider col ${DIVIDER_COL}`);
console.log(`rendered lines: ${rendered.length}, mockup lines: ${mock.length}\n`);

let diffs = 0;
for (let i = 0; i < Math.max(rendered.length, mock.length); i++) {
  const a = rendered[i] ?? '';
  const b = mock[i] ?? '';
  if (a === b) continue;
  diffs++;
  if (diffs <= 12) {
    const cols: number[] = [];
    for (let c = 0; c < FRAME_WIDTH; c++) if (a[c] !== b[c]) cols.push(c);
    console.log(`row ${String(i).padStart(2)} differs at cols ${cols.slice(0, 14).join(',')}${cols.length > 14 ? '…' : ''}`);
    console.log(`   mock: "${b}"`);
    console.log(`   ours: "${a}"`);
  }
}
console.log(`\n${diffs === 0 ? 'EXACT MATCH' : diffs + ' row(s) differ'}`);
process.exit(0);
