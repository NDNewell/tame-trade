// src/utils/monotonic.ts
//
// A clock for measuring how long something has been going.
//
// `Date.now()` answers a different question -- what time is it -- and the two
// look interchangeable right up until something moves the wall clock. On
// 2026-09-01 the host's time service had been stopped for six days, so its
// clock had drifted nineteen seconds; WSL re-synced the guest from the host
// every five seconds and NTP pulled it straight back, stepping the wall clock
// forwards and backwards all day. Every deadline in this codebase was a
// subtraction of two `Date.now()` readings, so every one of them fired at once:
// half-second-old passes were declared wedged, the panel abandoned a refresh
// every fifteen seconds and never finished one, and the log filled with reports
// of a stall that was not happening. The ruler kept changing length.
//
// `performance.now()` counts from an arbitrary origin and only ever moves
// forwards, at the rate real time passes, whatever anyone does to the clock on
// the wall. It is useless for saying when something happened and it is the only
// right answer for saying how long it has been happening. Stamps -- a fill, a
// journal entry, a market reading the coach will quote a time from -- keep
// `Date.now()`. Durations use this.

/**
 * Milliseconds since an arbitrary origin, unaffected by the wall clock.
 *
 * The origin is somewhere around process start, so readings begin near zero:
 * anything that means 'this has never happened' must be `-Infinity` rather than
 * the 0 that works with a clock counting from 1970.
 */
export function monotonicNow(): number {
  return performance.now();
}
