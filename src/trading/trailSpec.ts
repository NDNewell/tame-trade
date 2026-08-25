// src/trading/trailSpec.ts
//
// Parses what the operator typed after `trail` into the distance rule the order
// should use. Pure: no exchange, no prices, no clock.

/** Timeframes an ATR trail may be measured on. */
export const TRAIL_TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
] as const;

export type TrailTimeframe = (typeof TRAIL_TIMEFRAMES)[number];

/**
 * How far the stop stands off from the extreme.
 *
 * 'absolute' and 'percent' are fixed for the life of the order: the exchange
 * trails them and nothing recalculates them. 'atr' is the adaptive one -- the
 * distance is a multiple of measured volatility, and it is re-derived as that
 * volatility changes.
 */
export type TrailSpec =
  | { kind: 'absolute'; distance: number }
  | { kind: 'percent'; percent: number }
  | { kind: 'atr'; multiple: number; timeframe: TrailTimeframe; period: number };

/** Where no timeframe is given. */
export const DEFAULT_TRAIL_TIMEFRAME: TrailTimeframe = '1h';
/** The period ATR is quoted at essentially everywhere. */
export const DEFAULT_ATR_PERIOD = 14;
/** Where no multiple is given, as in a bare `trail atr`. */
export const DEFAULT_ATR_MULTIPLE = 3;

export interface TrailSpecError {
  error: string;
}

const isTimeframe = (value: string): value is TrailTimeframe =>
  (TRAIL_TIMEFRAMES as readonly string[]).includes(value);

/**
 * Reads a trail argument.
 *
 *   trail 2            two price units behind the extreme
 *   trail 2%           two percent behind it
 *   trail 3atr         three times ATR(14) on the default timeframe
 *   trail 3atr 15m     the same, measured on 15m candles
 *   trail atr          three times ATR, the multiple defaulted
 *
 * Anything it cannot read comes back as an error to show the operator, never as
 * a guess: a trail is the distance at which a position gets closed, so a
 * misread argument is not a cosmetic problem.
 */
export function parseTrailSpec(argument: string): TrailSpec | TrailSpecError {
  const text = argument.trim().toLowerCase();
  if (text === '') return { error: 'Give a trail distance.' };

  const words = text.split(/\s+/);
  if (words.length > 2) {
    return { error: `Too many arguments in '${argument.trim()}'.` };
  }

  const [first, second] = words;

  // --- ATR forms ----------------------------------------------------------
  // '3atr', '3 atr' (as two words), 'atr', and any of those with a timeframe.
  const atrMatch = /^([0-9]*\.?[0-9]*)atr$/.exec(first);
  if (atrMatch || first === 'atr') {
    const raw = atrMatch ? atrMatch[1] : '';
    const multiple = raw === '' ? DEFAULT_ATR_MULTIPLE : Number(raw);

    if (!Number.isFinite(multiple) || multiple <= 0) {
      return { error: `'${raw}atr' is not a usable multiple of ATR.` };
    }

    let timeframe: TrailTimeframe = DEFAULT_TRAIL_TIMEFRAME;
    if (second !== undefined) {
      if (!isTimeframe(second)) {
        return {
          error: `'${second}' is not a timeframe. Use one of ${TRAIL_TIMEFRAMES.join(', ')}.`,
        };
      }
      timeframe = second;
    }

    return { kind: 'atr', multiple, timeframe, period: DEFAULT_ATR_PERIOD };
  }

  // A timeframe only makes sense with ATR; anything else with two words is a
  // typo worth naming rather than silently ignoring.
  if (second !== undefined) {
    return { error: `'${second}' only applies to an ATR trail, as in 'trail 3atr ${second}'.` };
  }

  // --- fixed forms --------------------------------------------------------
  if (first.endsWith('%')) {
    const percent = Number(first.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0) {
      return { error: `'${argument.trim()}' is not a usable percentage.` };
    }
    if (percent >= 100) {
      return { error: `A trail of ${percent}% is the whole price or more.` };
    }
    return { kind: 'percent', percent };
  }

  const distance = Number(first);
  if (!Number.isFinite(distance) || distance <= 0) {
    return {
      error: `Invalid trail '${argument.trim()}'. Give a distance, a percentage such as 2%, or a multiple of volatility such as 3atr.`,
    };
  }

  return { kind: 'absolute', distance };
}

export const isTrailSpecError = (
  value: TrailSpec | TrailSpecError
): value is TrailSpecError => 'error' in value;

/** How the trail reads in the order panel and the activity log. */
export function describeTrailSpec(spec: TrailSpec): string {
  switch (spec.kind) {
    case 'absolute':
      return `${spec.distance}`;
    case 'percent':
      return `${spec.percent}%`;
    case 'atr':
      return `${spec.multiple}x ATR(${spec.period}) ${spec.timeframe}`;
  }
}
