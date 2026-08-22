// src/ui/commandHistory.ts
//
// Command history that survives restarts.
//
// Uses the same file the previous prompt wrote to, so history from earlier
// sessions is still there rather than starting empty under the new interface.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HISTORY_FILE = path.join(os.homedir(), '.tame_command_history.log');
const MAX_ENTRIES = 500;

export class CommandHistory {
  private entries: string[] = [];
  private cursor = -1;

  load(): void {
    try {
      this.entries = fs
        .readFileSync(HISTORY_FILE, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-MAX_ENTRIES);
    } catch {
      // No history yet is the ordinary first-run case, not a problem to report.
      this.entries = [];
    }
    this.cursor = -1;
  }

  add(command: string): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;

    // Repeating the same command shouldn't fill the history with duplicates.
    if (this.entries[this.entries.length - 1] !== trimmed) {
      this.entries.push(trimmed);
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
      this.persist();
    }

    this.cursor = -1;
  }

  /** -1 walks toward older commands, +1 toward newer. */
  recall(direction: number): string {
    if (this.entries.length === 0) return '';

    if (this.cursor === -1) {
      this.cursor = direction < 0 ? this.entries.length - 1 : -1;
    } else {
      this.cursor = this.cursor + direction;
    }

    if (this.cursor >= this.entries.length || this.cursor < 0) {
      this.cursor = -1;
      return '';
    }

    return this.entries[this.cursor] ?? '';
  }

  reset(): void {
    this.cursor = -1;
  }

  private persist(): void {
    try {
      fs.writeFileSync(HISTORY_FILE, this.entries.join('\n') + '\n', 'utf-8');
    } catch {
      // Losing history is not worth interrupting a trading session over.
    }
  }
}
