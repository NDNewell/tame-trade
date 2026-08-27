// src/guard/marketContext.ts
//
// What the coach is allowed to know about the market.
//
// The journal says what the operator did; this says what price was doing while
// they did it. They are kept apart because they come from different places and
// fail differently: the journal is on disk and always readable, the market is a
// live feed that can be stale, partial, or absent, and a coach that cannot tell
// the two apart will talk about a chart it was never shown.
//
// Assembled explicitly, like the journal's own facts block, so that adding a
// field to the exchange client cannot silently start sending it.

import { OrderView, orderSentence } from '../trading/orderView.js';

/** One candle, open included -- unlike the range measurements, which don't need it. */
export interface MarketCandle {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A run of candles at one size, oldest first. */
export interface MarketSeries {
  timeframe: string;
  candles: MarketCandle[];
}

export interface MarketContext {
  market: string;
  /** When these figures were read, so a stale block can say so. */
  at: number;
  base?: string;
  quote?: string;
  last?: number;
  bid?: number;
  ask?: number;
  mark?: number;
  index?: number;
  spread?: number;
  /** As the panel shows it, rate and annualised together. */
  funding?: string;
  ranges: Array<{ label: string; high?: number; low?: number; atr?: number }>;
  position?: {
    side: string;
    size: number;
    entry?: number;
    mark?: number;
    unrealizedPnl?: number;
    leverage?: number;
    effectiveLeverage?: number;
    liquidation?: number;
    /** What the stops in place actually leave at risk, from the risk model. */
    plannedRisk?: number;
    /** How much of the position protective orders cover, as a percentage. */
    coverage?: number;
    /** The next funding payment on this position, negative when it is paid out. */
    fundingCost?: number;
    /** The same, over a day, which is the figure worth weighing a trade against. */
    fundingDaily?: number;
    /** How often that payment falls, e.g. '8h'. */
    fundingInterval?: string;
    currency?: string;
  };
  /**
   * The working orders, read the same way the panel reads them.
   *
   * The same values, from the same function, as the ORDERS region. A summary
   * was tried and was worse than useless: it kept side, size, price and a
   * trailing flag, which is precisely the set of fields that cannot tell a stop
   * covering the whole position from an empty one, or a delayed trail waiting
   * to arm from a stop that will sit where it was put forever.
   */
  orders: OrderView[];
  /** History, finest first. Empty when nothing has been fetched yet. */
  series: MarketSeries[];
}

/** Trims trailing zeros so a tick-sized price does not gain false precision. */
const num = (value: number | undefined, digits = 4): string | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return String(Number(value.toFixed(digits)));
};

const signed = (value: number | undefined, digits = 2): string | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
};

/**
 * Whether a size is a day or coarser, and so stamped with a date alone.
 *
 * Read off the suffix rather than listed, because the list was wrong: it named
 * '1d' and '1M' and missed '1w', so weekly bars were stamped with a time of day
 * and -- since the fine stamp drops the year -- a two-year span read as
 * '08-19 to 08-10', which looks like it runs backwards.
 *
 * Case matters. Lower-case 'm' is minutes and upper-case 'M' is months, which
 * is the same convention the trail parser refuses to fold together.
 */
const coarse = (timeframe: string): boolean => /[dwM]$/.test(timeframe);

/** UTC, and to the minute unless the candles are daily or larger. */
function stamp(at: number, daily: boolean): string {
  const when = new Date(at);
  const date = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}-${String(
    when.getUTCDate()
  ).padStart(2, '0')}`;
  if (daily) return date;
  return `${date.slice(5)} ${String(when.getUTCHours()).padStart(2, '0')}:${String(
    when.getUTCMinutes()
  ).padStart(2, '0')}`;
}

/**
 * The context as prose and columns rather than JSON.
 *
 * A hundred candles as JSON objects is several thousand tokens of repeated key
 * names for the same numbers. Rows cost a fraction of that and are no harder to
 * read -- and the header says what the columns are, so nothing is guessed.
 */
export function describeMarket(context: MarketContext, includeCandles = true): string {
  const out: string[] = [];

  const top = [
    context.market,
    num(context.last) && `last ${num(context.last)}`,
    num(context.bid) && `bid ${num(context.bid)}`,
    num(context.ask) && `ask ${num(context.ask)}`,
    num(context.mark) && `mark ${num(context.mark)}`,
    num(context.index) && `index ${num(context.index)}`,
    num(context.spread) && `spread ${num(context.spread)}`,
  ].filter(Boolean);

  out.push(`MARKET, read at ${stamp(context.at, false)} UTC`);
  out.push(top.join('  '));
  if (context.funding) out.push(`funding ${context.funding}`);

  if (context.ranges.length > 0) {
    out.push('');
    // Spelled out rather than left as a header row: high and low are extremes
    // over the window, ATR is the typical bar on that timeframe, and reading
    // one as the other is the mistake this table invites.
    out.push(
      'RANGE  window: high / low over the trailing window, then ATR(14) of one ' +
        'bar of that size'
    );
    for (const range of context.ranges) {
      out.push(
        `${range.label.padEnd(4)} ${num(range.high) ?? '-'} / ${num(range.low) ?? '-'} / ${
          num(range.atr) ?? '-'
        }`
      );
    }
  }

  const position = context.position;
  if (position) {
    out.push('');
    out.push('POSITION');
    const parts = [
      `${position.side} ${num(position.size, 8)}`,
      num(position.entry, 8) && `entry ${num(position.entry, 8)}`,
      num(position.mark) && `mark ${num(position.mark)}`,
      signed(position.unrealizedPnl) &&
        `unrealized ${signed(position.unrealizedPnl)} ${position.currency ?? ''}`.trim(),
      position.leverage !== undefined && `leverage ${position.leverage}x`,
      position.effectiveLeverage !== undefined &&
        `effective ${position.effectiveLeverage.toFixed(2)}x`,
      num(position.liquidation) && `liquidation ${num(position.liquidation)}`,
      position.plannedRisk !== undefined &&
        `planned risk ${position.plannedRisk.toFixed(2)} ${position.currency ?? ''}`.trim(),
      position.coverage !== undefined &&
        `stops cover ${Math.round(position.coverage)}% of the size`,
      // Spelled out as paid or earned rather than left as a sign: the rate is
      // already in the block above, and what this adds is the direction the
      // money actually moves for the side being held. Both figures, because the
      // daily one is what a trade is weighed against and the per-payment one is
      // what actually leaves the account.
      position.fundingDaily !== undefined &&
        `funding ${position.fundingDaily < 0 ? 'costs' : 'pays'} ${Math.abs(
          position.fundingDaily
        ).toFixed(2)} ${position.currency ?? ''} per day${
          position.fundingCost !== undefined
            ? ` (${Math.abs(position.fundingCost).toFixed(2)} every ${
                position.fundingInterval ?? 'interval'
              }, at the current rate)`
            : ''
        }`.replace(/\s+/g, ' '),
    ].filter(Boolean);
    out.push(parts.join(', '));
  } else {
    out.push('');
    out.push('POSITION: flat');
  }

  if (context.orders.length > 0) {
    out.push('');
    out.push('WORKING ORDERS  what each one will do, not which fields it carries');
    for (const order of context.orders) out.push(orderSentence(order));
  } else {
    out.push('');
    // Said rather than left out. No orders and no order block look identical to
    // a reader, and they are opposite situations: one is an unprotected
    // position and the other is a gap in what was sent.
    out.push('WORKING ORDERS: none. Nothing is resting on the exchange.');
  }

  if (includeCandles && context.series.length > 0) {
    out.push('');
    out.push('CANDLES  open high low close, oldest first, times UTC');
    out.push(
      'Each size is listed with how many bars it carries and the span they ' +
        'cover, so a level can be judged against how long price has respected it.'
    );

    for (const series of context.series) {
      if (series.candles.length === 0) continue;

      // A daily candle is stamped with its date; anything finer needs the time.
      const daily = coarse(series.timeframe);
      const first = series.candles[0];
      const last = series.candles[series.candles.length - 1];

      out.push('');
      out.push(
        `${series.timeframe}: ${series.candles.length} bars, ` +
          `${stamp(first.at, daily)} to ${stamp(last.at, daily)}`
      );

      // The date is printed when the day turns and not on every row. On the
      // fine sizes that is six characters of the same date repeated a hundred
      // times, which is a tenth of the whole block spent saying nothing new --
      // and the eye finds a day boundary faster when it is the only place a
      // date appears.
      let day = '';
      for (const candle of series.candles) {
        const when = new Date(candle.at);
        const date = stamp(candle.at, true);
        const clock = `${String(when.getUTCHours()).padStart(2, '0')}:${String(
          when.getUTCMinutes()
        ).padStart(2, '0')}`;

        const label = daily
          ? date
          : date === day
            ? `      ${clock}`
            : `${date.slice(5)} ${clock}`;
        day = date;

        out.push(
          `  ${label} ${num(candle.open)} ${num(candle.high)} ${num(candle.low)} ${num(
            candle.close
          )}`
        );
      }
    }
  }

  return out.join('\n');
}
