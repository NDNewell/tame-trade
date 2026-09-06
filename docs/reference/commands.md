# Command reference

Every command you can type at the command prompt, grouped by what it does. Each entry gives the exact syntax, examples, and the messages you may see. For the reasoning behind order types see [Placing and managing orders](../orders.md); for guardrail behaviour see [Guardrails](../guardrails.md).

Conventions: `<required>`, `[optional]`, `a | b` for alternatives. Commands are matched in the order listed under [How commands are matched](#how-commands-are-matched).

**On this page**

- [Markets](#markets)
- [Orders](#orders)
- [Stops and trails](#stops-and-trails)
- [Chase](#chase)
- [Adjusting orders](#adjusting-orders)
- [Cancelling](#cancelling)
- [Position](#position)
- [Shorthand tokens](#shorthand-tokens)
- [Limits and guardrails](#limits-and-guardrails)
- [Coach](#coach)
- [Inspection](#inspection)
- [Session](#session)
- [How commands are matched](#how-commands-are-matched)

## Markets

### market

```
market <symbol>
```

Follow a market. The symbol must match the exchange's own spelling exactly and is case-sensitive.

```
market SOL/USDT:USDT
market BTC/USD:BTC
```

| Message | Cause |
|---|---|
| `Invalid market: <symbol>` | Not in the exchange's market list |

### list markets

```
list markets
```

Opens a two-step picker: market type (`swap`, `future`, `spot`, and so on), then an autocomplete over that type's symbols. `Back` at either step returns to the workspace.

## Orders

### buy, sell

```
buy <size>
sell <size>
```

A market order. Exactly one argument.

```
buy 10
sell 50%possize
```

| Message | Cause |
|---|---|
| `Invalid market order` | Wrong number of arguments |
| `Invalid quantity. '<x>' is not a usable size` | Size is not a positive number |
| `No market selected. Please select a market first.` | No followed market |

### limit buy, limit sell

```
limit buy <size> <price>
limit sell <size> <price>
```

A limit order. Size first, then price. Exactly four words.

```
limit buy 10 101.20
limit sell possize 104.50
```

| Message | Cause |
|---|---|
| `Invalid limit order` | Wrong number of arguments |
| `Invalid price. '<x>' is not a usable price` | Price is not a positive number |

### bracket buy, bracket sell

```
bracket buy <entry> <stop>
bracket sell <entry> <stop>
```

An entry with a stop, sized from risk. The entry and stop prices come from the command; you are then prompted for capital to risk and risk percentage. The prompt takes over the terminal until answered.

### range buy, range sell

```
range buy
range sell
```

A ladder of orders between two prices. Every parameter is prompted for: start price, end price, number of orders, risk percentage, stop price, take-profit price, capital to risk, and a minimum risk-reward ratio. The prompt takes over the terminal until answered.

## Stops and trails

### stop

```
stop <price> [size]
```

A reduce-only stop-loss, triggered on the last traded price. **The price always comes first.** With no size, covers the whole position plus resting limit orders; the panel shows `ALL`.

```
stop 99.90
stop 99.90 500
stop entry
```

| Message | Cause |
|---|---|
| `Invalid stop order` | Wrong number of arguments |
| `Invalid quantity. Usage: stop <price> [size]` | Size is not a number |
| `Stop price <p> is far from the market price of <m> for <market>. No order was placed. The stop price comes first: 'stop <price> [size]'.` | Price is more than 10x or less than 0.1x the market |

### trail

```
trail <distance>
trail <percent>%
trail <multiple>atr [timeframe]
trail atr [timeframe]
trail
```

A trailing stop covering the whole position. Fixed distance and percent trails are maintained by the exchange; ATR trails are moved by Tame every ten seconds. Trails follow the mark price. Default timeframe `1h`, default multiple `3`, ATR period `14`.

```
trail 2
trail 2%
trail 3atr
trail 3atr 15m
trail atr 4h
```

Timeframes: `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w`.

`trail` alone prints the usage line.

| Message | Cause |
|---|---|
| `Give a trail distance.` | Nothing after `trail` that parses |
| `Too many arguments in '<arg>'.` | More than two words |
| `'<n>atr' is not a usable multiple of ATR.` | Bad multiple |
| `'<tf>' is not a timeframe. Use one of 1m, 3m, ...` | Unknown timeframe |
| `'<tf>' is ambiguous: 'm' is minutes and 'M' is months. ...` | Capital `M` |
| `Write the multiple and 'atr' as one word: 'trail <n>atr'.` | `trail 3 atr` |
| `'<x>' only applies to an ATR trail, as in 'trail 3atr <x>'.` | Timeframe given with a fixed trail |
| `A trail of N% is the whole price or more.` | Percent of 100 or more |
| `No open position to trail.` | Flat |
| `Could not measure ATR(14) on <tf> for <market>, so the trail has no width. No order was placed.` | Candles unavailable |
| `An adaptive trail is already running on <market> (<id>, stop <price>). Cancel it first if you want different terms. No order was placed.` | Second ATR trail |

Success: `Trailing 2.00 behind 101.62 (2, fixed once placed)` or `Trailing 1.94 behind the high (3atr 15m, adjusts as volatility changes)`.

### stop ... trail (delayed trail)

```
stop <price> [size] trail <spec>
```

A fixed stop that starts trailing once price has moved one trail width beyond it. `<spec>` is any `trail` argument.

```
stop 97 trail 10
stop 98.50 500 trail 3atr 15m
```

Success: `Stop at 97; trails 10 once price reaches 107 (the stop plus 10)`. If price is already past the arming level: `... Price is already there, so it arms on the next check.`

| Message | Cause |
|---|---|
| `Give a stop price before 'trail', as in 'stop 97 trail 10'.` | Missing price |
| `'<x>' is not a usable stop price.` / `'<x>' is not a usable size.` | Bad number |
| `Give a trail after 'trail', as in 'stop 97 trail 10'.` | Missing spec |
| `A managed trail is already running on <market> (<id>). Cancel it first. No order was placed.` | Second managed trail |

## Chase

### chase buy, chase sell

```
chase buy <size> [decay]
chase sell <size> [decay]
```

A passive limit at the touch, re-priced as the book moves. Decay is `<n>s` or `<n>m`; the chase is cancelled at the deadline. One chase at a time.

```
chase buy 10
chase sell 10 90s
chase buy 10 5m
```

| Message | Cause |
|---|---|
| `Invalid chase command format. Usage: chase [buy/sell] [amount]` | Missing size or market |
| `Chase order already active.` | One is running |
| `Invalid decay time` | Unit other than `s` or `m` |

### cancel chase

```
cancel chase
```

Cancels the running chase. `No chase orders active.` if there is none.

## Adjusting orders

### move stop

```
move stop <price>
```

Edits the resting stop's trigger price in place, keeping its size. Take-profit orders are not touched.

```
move stop 100.40
```

| Message | Cause |
|---|---|
| `Usage: move stop <new stop price>` | Wrong argument count |
| `Invalid price format.` | Not a number |
| `No stop order found to move` | No resting stop |

### update stop

```
update stop [size]
```

Cancels and re-creates the stop. With no size, sizes it to the position plus resting limits. A typed size is subject to the fatfinger limit.

```
update stop
update stop 500
```

| Message | Cause |
|---|---|
| `Usage: update stop <amount>` | Wrong argument count |
| `Invalid amount. Amount should be a number.` | Bad size |
| `Stop NOT updated: <reason>` | Exchange rejected the replacement |

### bump

```
bump + <value>
bump - <value>
bump <value>
```

Shifts every open order's price (or trigger) on the market by the value.

```
bump +10
bump - 0.5
bump 10
```

| Message | Cause |
|---|---|
| `Invalid bump command format. Use "bump + [value]" or "bump - [value]".` | Unparseable |
| `No open orders to bump` | Nothing resting |

Success: `All orders have been bumped by 10.`

## Cancelling

```
cancel all            every resting order, stops included
cancel limits         limit orders only
cancel stops          stop-loss, take-profit, and trailing orders
cancel orders         every limit order
cancel orders [top | bottom] <n>
cancel orders [top | bottom] <n>:<m>
```

Ranges are 1-based positions in your resting limit orders sorted by price, `top` descending (default) and `bottom` ascending. A single index cancels only that order. Stops are never part of a range cancel.

```
cancel orders top 3       the third from the top
cancel orders top 3:5     third through fifth from the top
cancel orders bottom 1    the lowest-priced
```

| Message | Meaning |
|---|---|
| `3 limit orders cancelled.` | Done |
| `No stop orders to cancel.` | Nothing matched |
| `2 orders cancelled, 1 could NOT be cancelled — check the exchange.` | Partial |
| `No matching limit orders found to cancel.` | Range matched nothing |
| `Invalid command format. Usage: cancel orders [top | bottom] [start:end | specific order]` | Malformed range |

## Position

### close position

```
close position
```

Market-closes the whole position. Never held by the guardrails and exempt from the fatfinger limit.

| Message | Cause |
|---|---|
| `Position closed` | Done |
| `Position not closed: <reason>. You are still in this position.` | Exchange rejected it |

## Shorthand tokens

Substituted in any command before it runs.

| Token | Value |
|---|---|
| `possize` | Current position size |
| `<n>%possize` | That whole-number percentage of it |
| `entry` | Average entry price, rounded to market precision |

```
limit sell 50%possize 104.50
stop entry
print possize
```

| Message | Cause |
|---|---|
| `Error: Cannot execute an order with a position size of zero.` | `possize` with no position |
| `Error: Cannot execute an order with an entry price of zero.` | `entry` with no position |

### print

```
print possize
print entry
print precision
```

Shows the value without trading. `print precision` shows the market's price precision.

## Limits and guardrails

### fatfinger

```
fatfinger
fatfinger <amount>
fatfinger off
```

Caps the value of a single order, as size times price in the quote currency. Saved to the profile.

```
fatfinger 5000
```

| Message | Meaning |
|---|---|
| `Fatfinger limit: 5000 per order.` | Current limit |
| `No fatfinger limit set. Orders of any value will be accepted. Set one with "fatfinger <amount>".` | None set |
| `Fatfinger limit set to 5000 per order, measured as size x price in the market's quote currency. Orders worth more than this are rejected before being sent.` | Set |
| `Fatfinger limit removed. Orders of any value will now be accepted.` | Removed |
| `Invalid fatfinger amount '<x>'. Give a number greater than 0, or "off" to remove the limit.` | Bad argument |
| `Fatfinger guard: this order is worth <v> <ccy>, over your limit of <n> <ccy> per order. No order was placed. Raise the limit with 'fatfinger <amount>' if this was intended.` | Order rejected |
| `Cannot check the fatfinger limit for <market>: no price available. No order was placed.` | No price to value the order |

### guard

```
guard
guard on | off
guard explain <id>
guard limit <amount> | guard limit | guard limit off
guard mute <id> | guard unmute <id>
guard severity <id> <notice | hold | block>
guard autoexit <id> | guard autoexit | guard autoexit off
guard unlock
guard exit [now | firm] | guard exit stop
guard debrief
```

Behaviour ids: `revenge-entry rapid-fire size-escalation averaging-down chasing direction-flipping order-churn no-stop stop-widened stop-removed risk-per-trade leverage-creep daily-loss-limit loss-streak overtrading profit-giveback session-length`.

```
guard
guard explain profit-giveback
guard limit 500
guard mute chasing
guard severity loss-streak block
guard autoexit no-stop
guard exit firm
```

| Message | Meaning |
|---|---|
| `Guardrails updated.` | A setting changed and was saved |
| `Name a behaviour: <ids>` | Unknown or missing id |
| `Give a severity: notice, hold, or block.` | Bad severity |
| `'<x>' is not a usable loss limit.` | Bad amount |
| `Nothing is locked out.` / `Lockout lifted. It is on the record.` | `guard unlock` |
| `Nothing may close a position automatically.` / `Will close positions on: <ids>` | `guard autoexit` |
| `Tame will now close the position by itself when '<id>' fires. Turn it off with 'guard autoexit off'.` | Autoexit enabled |
| `No position to exit.` / `No exit is running.` | `guard exit` |
| `An assisted exit is already running. Stop it with 'guard exit stop' first.` | Second exit |
| `Stopping the exit. Anything already resting stays where it is.` | `guard exit stop` |

An unknown verb prints the usage line. Full semantics in [Guardrails](../guardrails.md).

## Coach

### coach

```
coach <question>
coach
coach clear
```

Ask a question in the coach panel, write the debrief, or empty the thread. Anything typed at the coach prompt (`Tab`) is handled as `coach <question>`.

```
coach is the 4h ATR telling me the stop is too tight?
coach
```

| Message | Meaning |
|---|---|
| `No coach configured. Add a key under 'AI Coach Key' on the home menu; 'guard' on its own always works without one.` | No key |
| `Writing the debrief...` then the text, or `Nothing to say about this session yet.` | Debrief |
| `The coach could not answer that one. The numbers above are unchanged.` | Call failed; the activity log has the reason |

## Inspection

```
watch <symbol> orderbook     stream the order book for a symbol
get market structure         dump the exchange's market definition for the followed market
list methods                 list the capabilities the exchange reports
```

## Session

```
quit
q
```

Quits. Releases the instance lock and, in development mode, clears the saved state. `Ctrl+C` does the same.

> **Note**
> With a market followed, `q` first falls through the order parser and logs one `Invalid command` line before quitting. This is harmless.

## How commands are matched

Commands are matched first-to-last in this order, and the first match wins:

`print` → shorthand substitution → `list methods` → `stop ... trail` → `trail` → `fatfinger` → `coach` → `guard` → `market` → `watch` → `list markets` → `get market structure` → `cancel all` → `cancel limits` → `close position` → `cancel stops` → `bump` → `cancel orders` → `range` → `chase` → `cancel chase` → `bracket` → `move stop` → `update stop` → order parser (`buy`, `sell`, `limit`, `stop`) → `quit`.

Two things happen before matching:

1. The line is written to the session journal exactly as typed.
2. If an order is held awaiting confirmation, the line answers it: `y` sends, `n` drops, anything else drops the held order and then runs.

## Related

- [Placing and managing orders](../orders.md)
- [Guardrails](../guardrails.md)
- [The coach](../coach.md)
