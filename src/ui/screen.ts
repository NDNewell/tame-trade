// src/ui/screen.ts
//
// Owns the terminal while trading.
//
// The workspace is repainted in place on the alternate screen buffer rather than
// printed repeatedly into scrollback, so there is one current view rather than a
// history of rendered dashboards. The command line is drawn at a fixed row, so
// incoming activity never moves it under the cursor mid-keystroke.

import {
  renderPainted,
  coachPanelColumn,
  coachInputRows,
  TerminalView,
  MIN_WIDTH,
  MIN_HEIGHT,
} from './frame.js';
import { ActivityLog } from './activityLog.js';
import { CommandHistory } from './commandHistory.js';

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
// The column is captured as well as the button: which panel the pointer is over
// decides what the wheel scrolls.
const MOUSE_EVENT = /\x1b\[<(\d+);(\d+);\d+[Mm]/g;

// Shift with the arrows scrolls the coach wherever it happens to be sitting.
// The wheel can only find it when it has a panel of its own, and below a wide
// terminal it does not.
const COACH_UP = `${ESC}[1;2A`;
const COACH_DOWN = `${ESC}[1;2B`;

const at = (row: number, col: number) => `${ESC}[${row + 1};${col + 1}H`;

/** Where the command text begins, matching the frame's own layout. */
const INPUT_COL = 4;

export type CommandHandler = (command: string) => void | Promise<void>;
/** A question typed at the coach prompt, which never reaches the exchange. */
export type CoachHandler = (question: string) => void | Promise<void>;
export type ConfirmHandler = (accepted: boolean) => void | Promise<void>;

export class Screen {
  private view: TerminalView;
  private running = false;
  private input = '';
  private coachInput = '';
  /**
   * Which prompt a keystroke reaches.
   *
   * The two prompts do categorically different things -- one sends orders, the
   * other asks questions -- so they are never merged, and something has to say
   * which is listening. Tab moves between them, which is what Tab does
   * everywhere else, and the focused prompt keeps the cyan caret so the answer
   * is on screen rather than in the operator's memory.
   */
  private focus: 'command' | 'coach' = 'command';
  private history = new CommandHistory();
  private pendingConfirm: ConfirmHandler | null = null;
  private repaintQueued = false;
  private activityOffset = 0;
  private coachOffset = 0;

  constructor(
    initial: TerminalView,
    private onCommand: CommandHandler,
    private onQuit: () => void,
    private onCoach: CoachHandler = () => {}
  ) {
    this.view = initial;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.history.load();

    const log = ActivityLog.getInstance();
    // Kept on disk from the moment there is a workspace to fill. The panel
    // holds five hundred events and a busy session overruns that inside an
    // hour; what scrolls off the top is the part of the day nobody can go back
    // and look at.
    log.persistTo();
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

  /** The frame's dimensions, which the workspace needs to size the coach column. */
  size() {
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
      coachInput: this.coachInput,
      focus: this.focus,
      activity: ActivityLog.getInstance().visible(),
      activityOffset: this.activityOffset,
      coachOffset: this.coachOffset,
    };

    const lines = renderPainted(view, this.size());

    let out = CURSOR_HIDE + CURSOR_HOME;
    lines.forEach((line, index) => {
      out += line + CLEAR_LINE;
      if (index < lines.length - 1) out += '\r\n';
    });
    out += CLEAR_BELOW; // clear anything below a shorter frame

    // The prompts are second from the bottom now that the command-reference
    // footer is gone: border, the two prompts, bottom border. The real cursor is
    // parked in whichever one has focus rather than a glyph being drawn for it.
    const promptRow = lines.length - 2;

    // The coach prompt wraps upward, so the cursor belongs at the end of its
    // last row rather than at the end of the whole string -- which, once the
    // question had wrapped, was a column well past the frame's right edge.
    // Wrapped by the same function the frame paints with, so the two cannot
    // disagree about where the next character lands.
    const column =
      this.focus === 'coach'
        ? (coachPanelColumn(this.size()) ?? 0) + INPUT_COL
        : INPUT_COL;
    const typed =
      this.focus === 'coach'
        ? (coachInputRows(this.size(), this.coachInput).rows.pop() ?? '')
        : this.input;
    out += at(promptRow, column + typed.length) + CURSOR_SHOW;

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

      case '\t':
        // Only where there is a second prompt to reach. On a terminal too
        // narrow for the sidebar, Tab would move focus somewhere invisible.
        if (coachPanelColumn(this.size()) !== null) {
          this.focus = this.focus === 'command' ? 'coach' : 'command';
          this.scheduleRepaint();
        }
        return;

      case '\r':
      case '\n': {
        if (this.focus === 'coach') {
          const question = this.coachInput.trim();
          this.coachInput = '';
          // Back to the newest exchange: the answer to what was just asked is
          // the thing worth looking at, and it lands at the bottom.
          this.coachOffset = 0;
          if (question.length > 0) void this.onCoach(question);
          this.scheduleRepaint();
          return;
        }

        const command = this.input.trim();
        this.input = '';
        this.activityOffset = 0;
        this.coachOffset = 0;
        if (command.length > 0) {
          this.history.add(command);
          void this.onCommand(command);
        }
        this.history.reset();
        this.scheduleRepaint();
        return;
      }

      case '\x7f':
      case '\b':
        if (this.focus === 'coach') this.coachInput = this.coachInput.slice(0, -1);
        else this.input = this.input.slice(0, -1);
        this.scheduleRepaint();
        return;

      case '\x15': // Ctrl+U
        if (this.focus === 'coach') this.coachInput = '';
        else this.input = '';
        this.scheduleRepaint();
        return;

      case '\x1b[A': // up
        // History belongs to the command line. The coach prompt has none: a
        // recalled question is worth retyping and a recalled order is not.
        if (this.focus === 'command') this.recall(-1);
        return;

      case '\x1b[B': // down
        if (this.focus === 'command') this.recall(1);
        return;

      case COACH_UP:
        this.scrollCoach(SCROLL_STEP);
        return;

      case COACH_DOWN:
        this.scrollCoach(-SCROLL_STEP);
        return;

      default:
        break;
    }

    // Ignore any other escape sequence rather than inserting its bytes.
    if (data.startsWith('\x1b')) return;

    const printable = [...data].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
    if (printable.length > 0) {
      if (this.focus === 'coach') this.coachInput += printable;
      else this.input += printable;
      this.scheduleRepaint();
    }
  };

  /** Returns true when the input was mouse reporting rather than typing. */
  private handleMouse(data: string): boolean {
    if (!data.includes(`${ESC}[<`)) return false;

    // Where the coach panel starts, so a wheel event over it scrolls the thread
    // rather than the log underneath the pointer's other half of the screen.
    const coachColumn = coachPanelColumn(this.size());

    MOUSE_EVENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    let moved = false;

    while ((match = MOUSE_EVENT.exec(data)) !== null) {
      const button = Number(match[1]);
      if (button !== WHEEL_UP && button !== WHEEL_DOWN) continue;

      // Terminals report columns from one; the frame counts them from zero.
      const column = Number(match[2]) - 1;
      const step = button === WHEEL_UP ? SCROLL_STEP : -SCROLL_STEP;

      if (coachColumn !== null && column > coachColumn) {
        this.coachOffset = Math.max(0, this.coachOffset + step);
      } else {
        this.activityOffset = Math.max(0, this.activityOffset + step);
      }
      moved = true;
    }

    if (moved) this.scheduleRepaint();

    // Swallow every mouse report, wheel or not, so button presses never land in
    // the command line as stray characters.
    return true;
  }

  private scrollCoach(step: number): void {
    this.coachOffset = Math.max(0, this.coachOffset + step);
    this.scheduleRepaint();
  }

  private recall(direction: number): void {
    this.input = this.history.recall(direction);
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
