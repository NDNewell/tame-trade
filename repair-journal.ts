// repair-journal.ts
//
// Removes fills that were recorded more than once.
//
// The order feed replays recent history whenever it reconnects, and every
// reader of it starts out believing nothing has filled yet -- so the same fill
// arrived again looking new, and was journalled again. Five streams over a
// session meant five copies of every fill. Nothing on screen was wrong, because
// the position and the balance come from the exchange; the journal beside them
// quietly recorded five sessions' worth of trading for one session's worth of
// trades, and every figure derived from it -- realised PnL, the daily loss
// limit, the size the detectors compare against -- was wrong by that factor.
//
// Fills now carry an order id and a running total, so the journal recognises a
// repeat and drops it. Files written before that carry no identity, so the
// signal here is an exactly identical line: same millisecond, same side, same
// size, same price, same market. Two genuinely distinct fills matching on all
// of those is not a thing that happens -- and the conservative failure would be
// to leave a duplicate in, not to remove a real fill.
//
//   npx tsx repair-journal.ts          what it would do
//   npx tsx repair-journal.ts --write  do it, keeping a backup beside each file

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { deriveSnapshot, JournalEvent } from './src/guard/sessionJournal.js';

const directory = path.join(os.homedir(), '.tame', 'journal');
const write = process.argv.includes('--write');

const days = fs
  .readdirSync(directory)
  .filter((name) => name.endsWith('.jsonl'))
  .sort();

let removedTotal = 0;

for (const name of days) {
  const file = path.join(directory, name);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());

  const seen = new Set<string>();
  const kept: string[] = [];
  const before: JournalEvent[] = [];
  const after: JournalEvent[] = [];

  for (const line of lines) {
    let event: JournalEvent;
    try {
      event = JSON.parse(line);
    } catch {
      // Unreadable lines are kept exactly as they are. This script's job is
      // duplicate fills, not tidying, and rewriting what it cannot parse is how
      // a repair becomes a loss.
      kept.push(line);
      continue;
    }

    before.push(event);

    if (event.type === 'fill') {
      const key = line.trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }

    kept.push(line);
    after.push(event);
  }

  const removed = lines.length - kept.length;
  removedTotal += removed;

  const now = before.length > 0 ? before[before.length - 1].at : Date.now();
  const was = deriveSnapshot(before, now);
  const is = deriveSnapshot(after, now);

  const position = (events: ReturnType<typeof deriveSnapshot>): string =>
    events.openPositions.map((open) => `${open.side} ${open.size}`).join('; ') || 'flat';

  const day = name.replace(/\.jsonl$/, '');

  if (removed === 0) {
    console.log(`${day}  clean`);
    continue;
  }

  console.log(
    `${day}  removed ${removed} duplicate fill${removed === 1 ? '' : 's'}\n` +
      `            realised  ${was.realizedPnl.toFixed(2)} -> ${is.realizedPnl.toFixed(2)}\n` +
      `            open      ${position(was)} -> ${position(is)}`
  );

  if (write) {
    // The backup is written first and never overwritten, so running this twice
    // cannot destroy the original by backing up an already-repaired file.
    const backup = `${file}.orig`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
  }
}

console.log(
  removedTotal === 0
    ? '\nNothing to repair.'
    : write
      ? `\n${removedTotal} duplicate fills removed. Originals kept as *.jsonl.orig.`
      : `\n${removedTotal} duplicate fills would be removed. Re-run with --write to do it.`
);
