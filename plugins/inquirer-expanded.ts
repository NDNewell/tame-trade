import { createInterface, ReadLine } from 'readline';
import fs from 'fs';
import { writeFile, readFile } from 'fs/promises';
import InputPrompt from 'inquirer/lib/prompts/input';
import observe from 'inquirer/lib/utils/events.js';
import { takeUntil } from 'rxjs';

interface FileError extends Error {
  code?: string;
}

class InquirerExpanded extends InputPrompt {
  private commandHistory: string[] = [];
  private commandHistoryIndex: number = 0;
  private commandHistoryFile = `${process.env.HOME}/.tame_command_history.log`;

  constructor(
    question: any,
    rl: ReadLine = createInterface(process.stdin, process.stdout),
    answers?: any
  ) {
    super(question, rl, answers);
    this.loadCommandHistory();
  }

  async onEnd(state: any) {
    // Log the command before finishing
    await this.logCommand(state.value);
    // Call the parent class's onEnd method
    super.onEnd(state);
  }

  _run(cb: any) {
    super._run(cb);

    const events = observe(this.rl);

    events.keypress.pipe(takeUntil(events.line)).forEach((event) => {
      const { key } = event;

      if (key.name === 'up') {
        if (this.commandHistoryIndex > 0) {
          this.commandHistoryIndex--;
        }
        this.rl.setPrompt('');
        this.rl.write(null, { ctrl: true, name: 'u' });
        this.rl.write(this.commandHistory[this.commandHistoryIndex] || '');
      } else if (key.name === 'down') {
        // console.log('down pressed');
        if (this.commandHistoryIndex < this.commandHistory.length - 1) {
          this.commandHistoryIndex++;
        } else {
          this.commandHistoryIndex = this.commandHistory.length;
          this.rl.write(null, { ctrl: true, name: 'u' });
          this.rl.write('');
        }
        this.rl.setPrompt('');
        this.rl.write(null, { ctrl: true, name: 'u' });
        this.rl.write(this.commandHistory[this.commandHistoryIndex] || '');
      } else {
        this.commandHistoryIndex = this.commandHistory.length;
      }

      // Call the onKeypress method of the parent class
      super.onKeypress();
    });
  }

  private async loadCommandHistory() {
    try {
      await fs.promises.stat(this.commandHistoryFile);
      const fileContents = await readFile(this.commandHistoryFile, 'utf-8');
      this.commandHistory = fileContents
        .split('\n')
        .filter((cmd) => cmd.trim() !== '');
      this.commandHistoryIndex = this.commandHistory.length;
    } catch (error) {
      if ((error as FileError).code === 'ENOENT') {
        console.error('Command history file does not exist');
      } else {
        console.error('Failed to read command history:', error);
      }
    }
  }

  private async logCommand(command: string): Promise<void> {
    this.commandHistory.push(command);

    if (this.commandHistory.length > 100) {
      this.commandHistory = this.commandHistory.slice(-100);
    }

    try {
      await writeFile(
        `${process.env.HOME}/.tame_command_history.log`,
        `${command}\n`,
        { flag: 'a' }
      );
    } catch (error) {
      console.error('Failed to log command:', error);
    }
  }
}

export default InquirerExpanded;
