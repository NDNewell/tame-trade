// src/ui/screen.ts
//
// Owns the terminal while trading.
//
// The workspace is repainted in place on the alternate screen buffer rather than
// printed repeatedly into scrollback, so there is one current view rather than a
// history of rendered dashboards. The command line is drawn at a fixed row, so
// incoming activity never moves it under the cursor mid-keystroke.

import { renderPainted, TerminalView, MIN_WIDTH, MIN_HEIGHT } from './frame.js';
import { ActivityLog } from './activityLog.js';

const ESC = '\x1b';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_LINE = `${ESC}[K`;
const CLEAR_BELOW = `${ESC}[J`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CURSOR_HIDE = `${ESC}[?25l`;
// Mouse reporting. Without it the terminal turns wheel events into arrow keys on
// the alternate screen, so scrolling walks command history instead of the log.
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const SCROLL_STEP = 3;
const MOUSE_EVENT = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

const at = (row: number, col: number) => `${ESC}[${row + 1};${col + 1}H`;

/** Where the command text begins, matching the frame's own layout. */
const INPUT_COL = 4;

export type CommandHandler = (command: string) => void | Promise<void>;
export type ConfirmHandler = (accepted: boolean) => void | Promise<void>;

export class Screen {
  private view: TerminalView;
  private running = false;
  private input = '';
  private history: string[] = [];
  private historyIndex = -1;
  private pendingConfirm: ConfirmHandler | null = null;
  private repaintQueued = false;
  private activityOffset = 0;

  constructor(
    initial: TerminalView,
    private onCommand: CommandHandler,
    private onQuit: () => void
  ) {
    this.view = initial;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const log = ActivityLog.getInstance();
    log.captureConsole();
    log.onChange(() => this.scheduleRepaint());

    process.stdout.write(ALT_SCREEN_ON + MOUSE_ON);
    process.stdout.on('resize', this.handleResize);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this.handleKey);

    this.repaint();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    process.stdin.off('data', this.handleKey);
    process.stdout.off('resize', this.handleResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();

    process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
    ActivityLog.getInstance().releaseConsole();
  }

  /** Merges a partial view and repaints. */
  update(patch: Partial<TerminalView>): void {
    this.view = { ...this.view, ...patch };
    this.scheduleRepaint();
  }

  /**
   * Holds an order until it is answered. The command line stays where it is; the
   * answer is a keystroke rather than a typed command, so a confirmation can't be
   * dismissed by muscle memory hammering Enter.
   */
  confirm(confirmation: TerminalView['confirmation'], handler: ConfirmHandler): void {
    this.pendingConfirm = handler;
    this.update({ confirmation });
  }

  private handleResize = (): void => this.scheduleRepaint();

  private scheduleRepaint(): void {
    if (!this.running || this.repaintQueued) return;
    this.repaintQueued = true;
    setImmediate(() => {
      this.repaintQueued = false;
      this.repaint();
    });
  }

  private size() {
    // One column short of the terminal: writing into the final column makes most
    // terminals wrap to the next line, which breaks the frame's right edge.
    return {
      width: Math.max(MIN_WIDTH, (process.stdout.columns || 80) - 1),
      height: Math.max(MIN_HEIGHT, process.stdout.rows || 40),
    };
  }

  private repaint(): void {
    if (!this.running) return;

    const view: TerminalView = {
      ...this.view,
      input: this.input,
      activity: ActivityLog.getInstance().visible(),
      activityOffset: this.activityOffset,
    };

    const lines = renderPainted(view, this.size());

    let out = CURSOR_HIDE + CURSOR_HOME;
    lines.forEach((line, index) => {
      out += line + CLEAR_LINE;
      if (index < lines.length - 1) out += '\r\n';
    });
    out += CLEAR_BELOW; // clear anything below a shorter frame

    // The command row is third from the bottom: border, command, border, footer,
    // border. Put the real cursor after the text rather than drawing a glyph.
    const commandRow = lines.length - 4;
    out += at(commandRow, INPUT_COL + this.input.length) + CURSOR_SHOW;

    process.stdout.write(out);
  }

  private handleKey = (data: string): void => {
    // Wheel events scroll the log and never reach the command line.
    if (this.handleMouse(data)) return;

    if (this.pendingConfirm) {
      this.answerConfirm(data);
      return;
    }

    switch (data) {
      case '\x03': // Ctrl+C
        this.onQuit();
        return;

      case '\r':
      case '\n': {
        const command = this.input.trim();
        this.input = '';
        this.historyIndex = -1;
        this.activityOffset = 0;
        if (command.length > 0) {
          this.history.push(command);
          void this.onCommand(command);
        }
        this.scheduleRepaint();
        return;
      }

      case '\x7f':
      case '\b':
        this.input = this.input.slice(0, -1);
        this.scheduleRepaint();
        return;

      case '\x15': // Ctrl+U
        this.input = '';
        this.scheduleRepaint();
        return;

      case '\x1b[A': // up
        this.recall(-1);
        return;

      case '\x1b[B': // down
        this.recall(1);
        return;

      default:
        break;
    }

    // Ignore any other escape sequence rather than inserting its bytes.
    if (data.startsWith('\x1b')) return;

    const printable = [...data].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
    if (printable.length > 0) {
      this.input += printable;
      this.scheduleRepaint();
    }
  };

  /** Returns true when the input was mouse reporting rather than typing. */
  private handleMouse(data: string): boolean {
    if (!data.includes(`${ESC}[<`)) return false;

    MOUSE_EVENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    let moved = false;

    while ((match = MOUSE_EVENT.exec(data)) !== null) {
      const button = Number(match[1]);
      if (button === WHEEL_UP) {
        this.activityOffset += SCROLL_STEP;
        moved = true;
      } else if (button === WHEEL_DOWN) {
        this.activityOffset = Math.max(0, this.activityOffset - SCROLL_STEP);
        moved = true;
      }
    }

    if (moved) this.scheduleRepaint();

    // Swallow every mouse report, wheel or not, so button presses never land in
    // the command line as stray characters.
    return true;
  }

  private recall(direction: number): void {
    if (this.history.length === 0) return;

    if (this.historyIndex === -1 && direction < 0) {
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.min(
        this.history.length - 1,
        Math.max(0, this.historyIndex + direction)
      );
    }

    this.input = this.history[this.historyIndex] ?? '';
    this.scheduleRepaint();
  }

  private answerConfirm(key: string): void {
    // Only an explicit yes proceeds; everything else declines.
    const accepted = key === 'y' || key === 'Y';
    const handler = this.pendingConfirm;
    this.pendingConfirm = null;
    this.update({ confirmation: null });
    void handler?.(accepted);
  }
}
