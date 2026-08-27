// src/guard/coachLog.ts
//
// The conversation, on disk.
//
// The thread in memory is a panel: sixty entries, oldest dropped, which is the
// right size for something read between trades. It is the wrong size for a
// record. What was said last Tuesday about sizing into a falling market is
// exactly the thing worth having in front of the coach the next time it
// happens, and by then the panel has forgotten it three hundred times over.
//
// So the panel keeps its sixty and this keeps all of them. Same discipline as
// the journal it sits beside: append-only, one JSON object per line, a line
// that will not parse is skipped rather than fatal, and a failed write costs
// persistence rather than the running application. Plain text on purpose --
// this is meant to be read by whoever is refining the coaching, not only by the
// coach.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dayKey } from './sessionJournal.js';

/** Who said it. Matches the panel's own idea of a line. */
export type CoachSpeaker = 'operator' | 'coach' | 'system';

/**
 * Why the coach spoke, which the text alone does not say.
 *
 * A remark that arrived uninvited and an answer to a direct question read the
 * same on the page and mean different things: one was solicited and one was an
 * interruption. Worth knowing later when the question is whether the
 * interruptions were any use.
 */
export type CoachOccasion = 'question' | 'answer' | 'remark' | 'debrief' | 'confirmation' | 'system';

export interface CoachTurn {
  at: number;
  speaker: CoachSpeaker;
  occasion: CoachOccasion;
  text: string;
  market?: string;
  /** The guardrail that prompted it, for anything the coach said unprompted. */
  behaviour?: string;
}

const isTurn = (value: any): value is CoachTurn =>
  value &&
  typeof value.at === 'number' &&
  typeof value.text === 'string' &&
  typeof value.speaker === 'string';

/**
 * The transcript for a day, or for all of them.
 *
 * Reads are by day and lazy: nothing loads the archive on start, because the
 * only caller that wants more than today is the one assembling history, and it
 * asks for the days it wants.
 */
export class CoachLog {
  private file: string | undefined;
  private day: string;

  constructor(private directory = path.join(os.homedir(), '.tame', 'coach')) {
    this.day = dayKey(Date.now());
  }

  /** Ensures the directory exists and points at today's file. */
  private open(at: number): string | undefined {
    const day = dayKey(at);
    if (this.file && day === this.day) return this.file;

    try {
      if (!fs.existsSync(this.directory)) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      }
      this.day = day;
      this.file = path.join(this.directory, `${day}.jsonl`);
      return this.file;
    } catch {
      // No transcript on disk. The panel still works, from memory only.
      this.file = undefined;
      return undefined;
    }
  }

  append(turn: CoachTurn): void {
    const file = this.open(turn.at);
    if (!file) return;

    try {
      fs.appendFileSync(file, `${JSON.stringify(turn)}\n`, { mode: 0o600 });
    } catch {
      // Losing the write costs the record, not the conversation.
    }
  }

  /** One day's turns, oldest first. Empty for a day that was not traded. */
  read(day: string): CoachTurn[] {
    const file = path.join(this.directory, `${day}.jsonl`);
    const turns: CoachTurn[] = [];

    try {
      if (!fs.existsSync(file)) return turns;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const text = line.trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text);
          if (isTurn(parsed)) turns.push(parsed);
        } catch {
          // One unreadable line loses one turn, not the day.
        }
      }
    } catch {
      // Unreadable transcript. Silence is the correct degradation here.
    }

    return turns;
  }

  /** Days with a transcript, newest first. */
  days(): string[] {
    try {
      return fs
        .readdirSync(this.directory)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.replace(/\.jsonl$/, ''))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}
