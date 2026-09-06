// Replay today's real coach questions against the current brief.
// Read-only against the exchange. Run with HOME pointed at a copy of ~/.tame so the
// replayed thread is not written into the real coach log:
//
//   cp -r ~/.tame /tmp/tame-copy/.tame && rm /tmp/tame-copy/.tame/tame.lock
//   HOME=/tmp/tame-copy npx tsx replay-coach.ts SOL/USDT:USDT replay.json
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';

import { ExchangeClient } from './src/exchange/exchangeClient.js';
import { Coach, ThreadTurn } from './src/guard/coach.js';
import { SessionHistory } from './src/guard/history.js';
import { describeMarket } from './src/guard/marketContext.js';
import { deriveSnapshot, readJournalDay, dayKey } from './src/guard/sessionJournal.js';

const tame = path.join(os.homedir(), '.tame');
const cfg = JSON.parse(fs.readFileSync(path.join(tame, 'config.json'), 'utf8'));
const exchangeId = String(cfg.exchanges[0].exchange).toLowerCase();
const symbol = process.argv[2] ?? 'SOL/USDT:USDT';
const outFile = process.argv[3] ?? 'replay.json';
const now = Date.now();
const day = dayKey(now);

// Today's thread as it actually happened.
const logged = fs
  .readFileSync(path.join(tame, 'coach', `${day}.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const original: Array<{ at: number; question: string; answer: string }> = [];
for (let i = 0; i < logged.length; i++) {
  if (logged[i].speaker === 'operator' && logged[i].occasion === 'question') {
    const reply = logged[i + 1];
    original.push({
      at: logged[i].at,
      question: logged[i].text,
      answer: reply?.speaker === 'coach' ? reply.text : '(no answer logged)',
    });
  }
}
console.error(`${original.length} questions in today's log`);

// The market, through the same path the app uses.
const ex = ExchangeClient.getInstance();
await ex.init(exchangeId);
ex.followMarket(symbol);
console.error('warming candles...');
await ex.warmCoachCandles(symbol);
for (let i = 0; i < 90; i++) {
  const ranges = await ex.getPriceRanges(symbol);
  if (ranges.length > 0 && ranges.every((r: any) => r.atr !== undefined)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 3000)); // let the ticker stream deliver a tick
const market = await ex.getMarketContext(symbol);
if (!market) throw new Error('no market context');
const marketText = describeMarket(market, true, Date.now());
console.error(`market block: ${marketText.length} chars, ${market.series.length} series`);

const snapshot = deriveSnapshot(readJournalDay(path.join(tame, 'journal'), day), Date.now(), 'USDT');
const history = new SessionHistory();
const coach = new Coach({ apiKey: cfg.anthropicApiKey, history: () => history.build(now) });

// Peek at what each call did: searches, tokens, cache.
let meta: any = {};
const client = (coach as any).client as Anthropic;
const origStream = client.messages.stream.bind(client.messages);
(client.messages as any).stream = (params: any, opts: any) => {
  const s = origStream(params, opts);
  const fm = s.finalMessage.bind(s);
  s.finalMessage = async () => {
    const m = await fm();
    meta = {
      searches: m.content.filter((b: any) => b.type === 'server_tool_use').length,
      queries: m.content.filter((b: any) => b.type === 'server_tool_use').map((b: any) => b.input?.query),
      stop: m.stop_reason,
      usage: m.usage,
    };
    return m;
  };
  return s;
};

const thread: ThreadTurn[] = [];
const results: any[] = [];
for (const turn of original) {
  console.error(`asking: ${turn.question.slice(0, 70)}...`);
  const started = Date.now();
  meta = {};
  const answer = await coach.converse(turn.question, thread, snapshot, [], market);
  const seconds = (Date.now() - started) / 1000;
  results.push({ ...turn, replay: answer ?? '(no answer)', seconds, ...meta });
  thread.push({ role: 'operator', text: turn.question });
  thread.push({ role: 'coach', text: answer ?? '' });
  console.error(`  ${seconds.toFixed(0)}s, ${meta.searches ?? '?'} searches, ${(answer ?? '').split(/\s+/).length} words`);
}

fs.writeFileSync(
  outFile,
  JSON.stringify({ day, symbol, ranAt: now, marketText, snapshot: { equity: snapshot.equity, realizedPnl: snapshot.realizedPnl, trades: snapshot.trades.length }, results }, null, 2)
);
console.error(`wrote ${outFile}`);
process.exit(0);
