# Troubleshooting

Symptoms you may see, what they mean, and what to do. Most diagnostics that are hidden from the ACTIVITY panel are still written to `~/.tame/activity/YYYY-MM-DD.jsonl`; when something has gone wrong, that file is most of the evidence.

**On this page**

- [Starting](#starting)
- [Connection and data](#connection-and-data)
- [Orders](#orders)
- [Guardrails](#guardrails)
- [Coach](#coach)
- [Display](#display)

## Starting

### "Tame is already running (pid ...)"

Another instance holds `~/.tame/tame.lock`. In a terminal, Tame offers to leave it running or stop it and start here. If you know the other process is gone, choose the second option; a stale lock is taken over. Outside a terminal, stop the other instance or remove the lock file by hand.

### "Too many incorrect password attempts. Exiting..."

Three wrong passwords. Start again. If the password is lost, delete `~/.tame/config.json` and create the profile again; you will need to re-enter exchange credentials, the fatfinger limit, guard settings, and the coach key.

### Start Trading returns to the menu after adding the first exchange

A known gap when the profile had no exchanges. Choose Start Trading again.

### Settings vanished after removing an exchange

Removing an exchange currently rewrites the profile without the fatfinger limit, guard policy, and coach key. Re-enter them. See [Known gaps](development.md#known-gaps).

## Connection and data

### "throttle queue is over maxCapacity (1000)" and every read failing

The exchange is answering slowly and requests were queued faster than they drained. Tame's refresh, sweep, and candle passes are each one-at-a-time with a deadline precisely to prevent this, so if you see it the cause is usually outside Tame: a VPN, an exchange incident, or a second process hammering the same key. Wait for the queue to drain; it recovers on its own.

### "refresh abandoned" warnings, or a blank panel that never fills

The two-second refresh has a fifteen-second deadline on the **monotonic** clock. If it is being abandoned repeatedly, either the exchange is very slow or, on WSL, the host clock is being stepped.

Check the clock first. On 2026-09-01 a WSL host clock was being corrected by around nineteen seconds every five seconds, which made every wall-clock duration meaningless and poisoned ccxt's rate limiter. Compare `date` against a reliable source a few times over a minute; if it jumps, fix the clock (on WSL, `sudo hwclock -s` or a restart of the WSL VM) and restart Tame.

### RANGE shows `--` for a long time

Ranges need nine candle series and are fetched in the background after the first frame. On a slow venue this can take tens of seconds. If ATR cells stay empty, the candle endpoint is failing; the activity file will show why.

### Position figures disagree with the exchange

On Phemex, unrealized PnL and effective leverage are derived rather than read, because the exchange's own figures through ccxt are not usable. Run `npx tsx read-my-equity.ts` to see the derivation beside the raw values, and `npx tsx read-my-leverage.ts <symbol>` for the leverage denominator candidates.

### Fills or PnL look inflated

Before 2026-08-26 the order feed's reconnect replay was counted as new fills, inflating journal fills several-fold. Run `npx tsx repair-journal.ts` to see what would be removed, then `--write` to fix it. Backups are kept as `.jsonl.orig`.

## Orders

### "Stop price ... is far from the market price"

The stop was more than ten times, or under a tenth of, the market price. Almost always the price and size were swapped. The price comes first: `stop 99.90 500`.

### "Fatfinger guard: this order is worth ..."

The order exceeded your per-order value cap. Raise it with `fatfinger <amount>` if the size was intended.

### "Cannot check the fatfinger limit ... no price available"

Tame refuses rather than guesses when it cannot value an order. Wait for the price feed, or check the connection.

### A stop I placed shows quantity `ALL`

That is correct. A stop with no size covers whatever the position is when it fires. On Phemex it is sent with quantity zero, which is how the exchange expresses this.

### My trail stopped moving after I closed Tame

Fixed and percentage trails are maintained by the exchange and keep moving. ATR trails (`trail 3atr`) are moved by Tame and pause when it is not running; the stop stays at its last level. Delayed trails arm only while Tame is running.

### "An adaptive trail is already running"

One ATR trail per market. `cancel stops`, then place the new one.

### `buy 10 101.20` is rejected

That is not a limit order. `buy` and `sell` take a single argument and are market orders. Use `limit buy 10 101.20`.

### The chase ended but I am not sure it filled

`Chase ended — the exchange has not reported the outcome yet. Check your position.` means the order feed went quiet. The position panel refreshes every two seconds and will show the truth.

## Guardrails

### An order was held and I did not expect it

Read the finding on the panel. `guard explain <id>` gives the full reasoning. If the behaviour is wrong for how you trade, `guard mute <id>` or `guard severity <id> notice`. To send this one anyway, type `y`; it is recorded as an override.

### "Entries are stopped for another N minutes"

A lockout. Exits and stops still work. It survives a restart. `guard unlock` lifts it, on the record.

### A finding keeps reappearing

The tracker suppresses re-announcement within fifteen minutes unless the condition gets worse, so if you are seeing it again it either escalated or has been more than fifteen minutes. The condition itself is visible on the coach panel's GUARD line the whole time.

### "A worked exit is ready"

The finding is about the open position, and Tame has built an exit plan. Nothing happens unless you run `guard exit` or have authorised that behaviour with `guard autoexit`.

## Coach

### "No coach configured"

Add a key under **AI Coach Key** on the home menu. `guard` still works without one.

### "The coach could not answer that one"

The call failed. The activity log has a WARNING with the reason:

| Warning | Meaning |
|---|---|
| `[Coach] Anthropic credentials were rejected; coaching is off.` | Bad key. Enter another from the home menu. `guard` shows `Coach: off — the key was rejected.` |
| `[Coach] 429: ...` | Rate limited or out of credit. |
| `[Coach] 529: ...` | The API is overloaded. Try again. |
| `[Coach] coaching unavailable this time.` | Network or an unexpected error. |

### "The coach's market read has been running for Ns and has been abandoned"

The market read behind a question took more than fifteen seconds. The coach answered against the last reading it had, and said so if the block was stale. Usually the exchange is slow; see [Connection and data](#connection-and-data).

### The coach says the market block is stale

The reading it was handed was more than a minute old. It quotes prices as of that time rather than guessing. A repeated stale block means the refresh is failing; check the activity file.

### The coach ignored something obvious, or over-answered

The brief is in `src/guard/coach.ts`. The transcript in `~/.tame/coach/` shows exactly what it was asked and what it said. See [Tuning the brief](coach.md#tuning-the-brief) for how to replay real questions against a change.

## Display

### The frame is drawn with `+`, `-`, and `|`

The terminal did not advertise UTF-8. Set `LANG` (for example `en_US.UTF-8`) and make sure `TERM` is set and not `dumb`.

### Tab does nothing

The terminal is narrower than 120 columns, so there is no coach sidebar to focus. Widen it, or ask with `coach <question>`.

### Scrolling the wheel walks command history instead of the log

Mouse reporting failed to enable, usually because the terminal does not support it. The keyboard alternative for the coach thread is `Shift+Up` and `Shift+Down`; the activity log has no keyboard scroll.

### The terminal is left in a strange state after a crash

Tame uses the alternate screen and raw mode. Run `reset` in the terminal.

## Related

- [Development](development.md#known-gaps)
- [Records on disk](reference/records.md)
