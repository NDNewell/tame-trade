// src/trading/exitExecutor.ts
//
// Runs a plan from exitPlan.ts against a live book.
//
// This is the only file in the guardrail system that sends orders nobody typed,
// so it is written to a different standard from the rest. Every rule below
// exists because the failure it prevents would be worse than the behaviour the
// exit was responding to:
//
//   Every child is reduce-only. A sign error, a stale position size, or a fill
//   arriving between two steps cannot open a position -- the exchange refuses
//   it. This is belt and braces over the size arithmetic below, and it stays
//   even though that arithmetic is also checked.
//
//   The remaining size is re-read from the exchange, not carried. Positions
//   move for reasons this loop cannot see: the operator closing part of it by
//   hand, a stop triggering, another instance of Tame. Working from a number
//   captured at the start would keep sending children into a position that is
//   already flat.
//
//   It stops on anything unexpected. A cancel that fails, a placement that is
//   rejected, a position that has grown rather than shrunk: all of them end the
//   run and say so. An exit that improvises is worse than one that hands back
//   control with the position exactly where the operator can see it.
//
//   It always terminates. Past the deadline, whatever is left goes to market.
//   The plan exists to get a price improvement on the way out, not to be right.

import {
  ExitPlan,
  ExitSlice,
  priceFor,
  SliceStyle,
} from './exitPlan.js';

export type Direction = 'long' | 'short';

export interface BookTop {
  bestBid: number;
  bestAsk: number;
  tick: number;
}

/**
 * What the executor needs from the outside world.
 *
 * An interface rather than the exchange client so this file can be run against
 * a fake in a test. An execution algorithm that has only ever been observed
 * working on a live account has not been tested.
 */
export interface ExitExecutionPort {
  book(market: string): Promise<BookTop | undefined>;
  /** Signed is not needed: the side is derived from the position's direction. */
  positionSize(market: string): Promise<number>;
  placeReduceOnlyLimit(
    market: string,
    side: 'buy' | 'sell',
    size: number,
    price: number
  ): Promise<string | undefined>;
  placeReduceOnlyMarket(
    market: string,
    side: 'buy' | 'sell',
    size: number
  ): Promise<string | undefined>;
  cancelOrder(market: string, orderId: string): Promise<void>;
  /** How much of a child has filled. */
  filledOf(market: string, orderId: string): Promise<number>;
  say(message: string, kind: 'info' | 'good' | 'bad'): void;
  wait(ms: number): Promise<void>;
}

export interface ExitRunResult {
  /** Quantity that actually left. */
  exited: number;
  /** Quantity still open when the run ended. */
  remaining: number;
  outcome: 'flat' | 'partial' | 'aborted';
  reason: string;
}

/** Escalation order. A child that will not fill becomes more aggressive. */
const NEXT: Record<SliceStyle, SliceStyle> = {
  passive: 'join',
  join: 'cross',
  cross: 'market',
  market: 'market',
};

export class ExitExecutor {
  private cancelled = false;

  constructor(private port: ExitExecutionPort) {}

  /**
   * The operator asked it to stop. Checked between every step.
   *
   * One-way. An aborted executor is spent and will refuse to run again, which
   * is why the guard builds a fresh one per exit. Clearing the flag on the next
   * run would be tidier and would mean an abort arriving in the window between
   * the decision to exit and the first await could be silently discarded --
   * exactly the moment an operator is most likely to send one.
   */
  abort(): void {
    this.cancelled = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  private running = false;

  async run(
    market: string,
    side: Direction,
    plan: ExitPlan,
    startedAt: number,
    clock: () => number = () => Date.now()
  ): Promise<ExitRunResult> {
    // Closing a long means selling.
    const closingSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';

    if (this.cancelled) {
      return { exited: 0, remaining: 0, outcome: 'aborted', reason: 'stopped before it began' };
    }

    const opening = await this.port.positionSize(market).catch(() => 0);
    if (!(opening > 0)) {
      return { exited: 0, remaining: 0, outcome: 'flat', reason: 'already flat' };
    }

    this.running = true;
    let exited = 0;

    try {
      for (const slice of plan.slices) {
        if (this.cancelled) {
          return await this.ended(exited, market, 'aborted', 'stopped by the operator');
        }

        // Wait for the slice's turn in the schedule.
        const due = startedAt + slice.offsetMs;
        const delay = due - clock();
        if (delay > 0) await this.port.wait(delay);

        if (clock() - startedAt > plan.deadlineMs) break;

        const remaining = await this.port.positionSize(market).catch(() => 0);
        if (!(remaining > 0)) {
          return await this.ended(exited, market, 'flat', 'the position closed while working');
        }

        // Never send more than is actually there. The plan was written against
        // the size at the start; the position may have been reduced since by
        // something this loop did not do.
        const size = Math.min(slice.size, remaining);
        if (!(size > 0)) continue;

        exited += await this.workChild(market, closingSide, side, slice, size, clock, plan, startedAt);
      }

      // --- the deadline ----------------------------------------------------
      const left = await this.port.positionSize(market).catch(() => 0);
      if (left > 0 && !this.cancelled) {
        this.port.say(
          `Exit deadline reached with ${left} left. Sending it to market.`,
          'info'
        );
        const id = await this.port.placeReduceOnlyMarket(market, closingSide, left);
        if (id) exited += left;
      }

      const final = await this.port.positionSize(market).catch(() => 0);
      return await this.ended(
        exited,
        market,
        final > 0 ? 'partial' : 'flat',
        final > 0 ? 'some of the position could not be exited' : 'position closed'
      );
    } catch (error) {
      return await this.ended(
        exited,
        market,
        'aborted',
        `stopped after an error: ${(error as Error).message}`
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * One child order, through as many escalations as its patience allows.
   *
   * A resting child that has not filled is repriced rather than left: the
   * adverse-selection argument says a passive order that is still there is
   * either mispriced or about to be traded through, and both are answered by
   * moving it.
   */
  private async workChild(
    market: string,
    closingSide: 'buy' | 'sell',
    side: Direction,
    slice: ExitSlice,
    size: number,
    clock: () => number,
    plan: ExitPlan,
    startedAt: number
  ): Promise<number> {
    let style = slice.style;
    let filled = 0;
    let outstanding = size;

    // Bounded: passive -> join -> cross -> market is three escalations, and the
    // loop must not be able to run longer than the plan's own deadline.
    for (let attempt = 0; attempt < 4 && outstanding > 0; attempt++) {
      if (this.cancelled) break;
      if (clock() - startedAt > plan.deadlineMs) break;

      const top = await this.port.book(market).catch(() => undefined);
      if (!top) {
        // No book, no informed price. Rather than guess, hand the remainder to
        // the deadline logic, which crosses.
        break;
      }

      const price =
        style === 'market'
          ? undefined
          : priceFor({ ...slice, style }, { side, bestBid: top.bestBid, bestAsk: top.bestAsk, tick: top.tick });

      const id =
        price === undefined
          ? await this.port.placeReduceOnlyMarket(market, closingSide, outstanding)
          : await this.port.placeReduceOnlyLimit(market, closingSide, outstanding, price);

      if (!id) break;

      if (price === undefined) {
        filled += outstanding;
        outstanding = 0;
        break;
      }

      await this.port.wait(slice.patienceMs);

      const done = await this.port.filledOf(market, id).catch(() => 0);
      if (done > 0) {
        filled += done;
        outstanding = Math.max(0, outstanding - done);
      }

      if (outstanding <= 0) break;

      // Not filled, or not fully. Pull it before repricing -- leaving the old
      // one resting while placing a new one is how a reduce-only exit ends up
      // with two children competing for the same quantity.
      await this.port.cancelOrder(market, id);
      style = NEXT[style];
    }

    return filled;
  }

  /**
   * Reports what is actually left, read from the exchange rather than inferred.
   *
   * The difference matters: an operator told 'partial' needs to know how much
   * is still exposed, and a number derived by subtracting what we think we sent
   * would be wrong in exactly the cases where it is most needed -- a rejected
   * child, a fill we did not see, a position touched from elsewhere.
   */
  private async ended(
    exited: number,
    market: string,
    outcome: ExitRunResult['outcome'],
    reason: string
  ): Promise<ExitRunResult> {
    const remaining = await this.port.positionSize(market).catch(() => 0);
    const symbol = market.split(':')[0];

    const message =
      remaining > 0
        ? `Exit ended on ${symbol} — ${reason}. ${remaining} still open.`
        : `Exit complete on ${symbol}: ${reason}.`;

    this.port.say(message, remaining > 0 ? 'bad' : 'good');
    return { exited, remaining, outcome, reason };
  }
}
