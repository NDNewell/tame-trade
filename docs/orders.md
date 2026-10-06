# Placing and managing orders

This guide covers every way to get an order onto the exchange and to change or remove one. It explains the semantics that matter (reduce-only, mark versus last price, who maintains a trail) rather than just the syntax. For a compact syntax table see the [Command reference](reference/commands.md).

**On this page**

- [Before you trade](#before-you-trade)
- [Market and limit orders](#market-and-limit-orders)
- [Stops](#stops)
- [Take profits](#take-profits)
- [Stop-limits](#stop-limits)
- [Trailing stops](#trailing-stops)
- [Chase orders](#chase-orders)
- [Adjusting working orders](#adjusting-working-orders)
- [Cancelling](#cancelling)
- [Closing a position](#closing-a-position)
- [Size and price shorthand](#size-and-price-shorthand)
- [The fatfinger limit](#the-fatfinger-limit)
- [What the guardrails do to an order](#what-the-guardrails-do-to-an-order)

## Before you trade

Every order command needs a followed market:

```
market SOL/USDT:USDT
```

Without one, order commands answer `No market selected. Please select a market first.` Symbols are the exchange's own, exact and case-sensitive. `list markets` opens a picker if you do not know it.

Every command you type is written to the session journal as typed, before anything else happens to it, so the record says what you wanted and not only what the exchange received.

## Market and limit orders

```
buy <size>
sell <size>
limit buy <size> <price>
limit sell <size> <price>
```

`buy` and `sell` with a single argument are market orders. `limit` orders take the size first, then the price. Sizes are in the market's base unit or contract, whatever the exchange counts in.

```
buy 10                 market buy 10
limit sell 10 104.50   rest an offer at 104.50
```

On Hyperliquid a market order is sent as a limit five percent through the touch, which is how that venue expresses one.

Word counts are strict: `buy 10 104.50` is not a limit order, it is an error. Validation messages:

| Message | Cause |
|---|---|
| `Invalid market order` | `buy` or `sell` with anything other than exactly one argument |
| `Invalid limit order` | `limit` with anything other than side, size, price |
| `Invalid quantity. '<x>' is not a usable size` | Size is not a positive number |
| `Invalid price. '<x>' is not a usable price` | Price is not a positive number |

## Stops

```
stop <price> [size]
```

**The price always comes first.** With no size, the stop covers the whole position plus whatever your resting limit orders would add to it.

```
stop 99.90         protect the whole position
stop 99.90 500     a stop for 500 units at 99.90
```

What a stop is:

- **Reduce-only.** It can only close what you hold and can never open a position the other way.
- **Triggered on the last traded price**, matching what the exchange's own interface creates.
- **Sized `ALL`** when no size was given. On Phemex the order is sent with a quantity of zero, which the exchange reads as "whatever the position is when this fires". The orders panel shows `ALL`.

A stop price more than ten times, or less than a tenth of, the market price is rejected rather than placed, because it almost always means the price and size were entered the wrong way round:

```
Stop price 500 is far from the market price of 101.62 for SOL/USDT:USDT. No order was placed. The stop price comes first: 'stop <price> [size]'.
```

A stop is a protective order. The guardrails never hold or refuse one, and the fatfinger limit does not apply to a stop sized from your position.

## Take profits

```
tp <price> [size]
```

A take profit is a stop's mirror image: the same reduce-only trigger order, resting on the winning side of the market. **The price comes first**, as it does for a stop. With no size it closes the whole position.

```
tp 110             close the whole position at 110
tp 110 500         take 500 units off at 110
```

What a take profit is:

- **Reduce-only.** It can only close what you hold. If the stop closes the position first, the take profit cannot open a new one the other way, which a plain `limit sell` at your target could.
- **A market order on trigger**, fired by the last traded price. It fills at the market when price touches the target, not at a guaranteed price. On Phemex it is a `MarketIfTouched` order.
- **Sized `ALL`** when no size was given, exactly as a stop is.
- **Shown as `TP`** in the orders panel, and announced as `TP WORKING`. The coach is told it is a take profit and that it is not protection.
- **Not counted as protection.** Position risk is worked out from your stops alone. A take profit does nothing for the downside.

It has to sit on the winning side: above the market closing a long, below it closing a short. On the other side it would either be a stop or fire the moment it arrived, so it is refused:

```
Take profit 95 is not above the market price of 100. Closing a long, it has to be above. No order was placed. For a trigger below the market use 'stop <price> [size]'.
```

With no position and no resting limit orders there is nothing to take profit on, and nothing is placed. With resting limit orders but no position yet, the take profit is sized to those orders, as a stop would be.

Several take profits can rest at once, so you can scale out: `tp 105 200`, `tp 110 200`, `tp 120`. Remove them with `cancel tp`, which leaves your stop alone. `move stop` and `bump` never touch a take profit; change a target with [`move tp`](#move-a-take-profit).

The guardrails never hold or refuse a take profit, because it can only reduce the position. A size you type is still subject to the fatfinger limit.

## Stop-limits

```
stop limit buy <trigger price> <limit price> <size>
stop limit sell <trigger price> <limit price> <size>
```

A conditional order the exchange holds: when the last traded price reaches the trigger, a limit order at the limit price is placed. Nothing needs to be running for it to work. All three numbers are required, and the side is spelled out because a stop-limit is as often an entry as an exit.

```
stop limit sell 95 94.50 10       exit: if price falls to 95, offer 10 at 94.50
stop limit buy 105 105.50 10      breakout entry: if price rises to 105, bid 10 at 105.50
stop limit buy 95 95.20 10        dip entry: if price falls to 95, bid 10 at 95.20
```

What it is:

- **Reduce-only when it closes what you hold**, and an ordinary order otherwise. A sell with a long open is sent close-on-trigger; the same sell with no position is a plain entry.
- **Reviewed as the limit order it becomes.** An entry can be held or refused by the guardrails; an exit goes straight through. The fatfinger limit applies to the size.
- **Shown as `STOP`** in the panel, at the trigger price. The coach's sentence names it a stop-limit and gives the limit price. A trigger on the near side of the market (the dip entry above) is a limit-if-touched, which the panel shows as `TP`; the coach's sentence says what it is.
- **Cancelled by `cancel stops`**, like every trigger order. `move stop` will pick a stop-limit up if it is the only stop resting, and edits only its trigger.

**A stop-limit can fail to fill.** Once triggered it is a limit order and rests like one. If price runs through the limit, the position stays open with the stop gone. Choose the gap between trigger and limit for the market you are in, and for protection you cannot afford to miss, use a plain `stop`, which goes to market.

A limit on the far side of the trigger is accepted with a warning in the activity log: a sell that triggers at 95 and asks for 96 fills only if price comes back up to it.

| Message | Cause |
|---|---|
| `Usage: stop limit buy|sell <trigger price> <limit price> <size>` | Wrong shape, or no side |
| `Invalid price. '<x>' is not a usable price. ...` | A price that is not a positive number |
| `Invalid quantity. '<x>' is not a usable size. ...` | A size that is not a positive number |
| `Trigger price <p> is far from the market price of <m> for <market>. No order was placed. ...` | Trigger or limit is more than 10x or less than 0.1x the market |

## Trailing stops

A trailing stop follows the best price the position has seen and never moves backwards. Tame offers three kinds, and the difference between them is who maintains the trail.

```
trail <distance>
trail <percent>%
trail <multiple>atr [timeframe]
trail atr [timeframe]
```

| Command | Trail width | Maintained by |
|---|---|---|
| `trail 2` | 2.00 in price behind the best price | The exchange |
| `trail 2%` | Two percent behind it | The exchange |
| `trail 3atr 15m` | Three times ATR(14) measured on 15-minute candles | Tame, every ten seconds |
| `trail atr` | Three times ATR(14) on the default one-hour timeframe | Tame |

All of them cover the whole position and need an open one. The stop starts one trail width from the current price; an ATR trail is anchored to the best price the position has seen so far.

### Fixed trails are exchange-side

A fixed distance or percentage trail is handed to the exchange as a pegged order. The exchange moves it, so it keeps working when Tame is closed. That is deliberate: a trail maintained locally would freeze wherever it was when the process stopped while still looking like it was following the price.

### Trails follow the mark price

Fixed stops trigger on the last traded price. Trails follow the **mark** price. Last price is what a wick moves: a spike on this venue would ratchet the trail up behind it, and when price returned the stop would be left near the market and close the position on a move that never really happened. Mark price comes from the index, so a wick that does not move the wider market barely moves the trail.

### ATR trails adapt to volatility

An ATR trail's width is remeasured as volatility changes, and because the stop only ever ratchets toward profit, a volatility expansion widens the gap without giving back protection already earned. Tame moves this stop itself, once every ten seconds, so an ATR trail stops adjusting when Tame is not running. The resting stop stays on the exchange at its last level.

Only one ATR trail may run per market. To change its terms, cancel it first.

Timeframes: `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w`. Monthly is refused because `M` and `m` are too easy to confuse.

### Delayed trails

```
stop <price> [size] trail <spec>
```

A fixed stop that becomes a trail once price has moved one trail width beyond it. The arming price is fixed at placement: stop plus width for a long, stop minus width for a short.

```
stop 97 trail 10        stop at 97; trails 10 behind once price reaches 107
stop 98.50 trail 3atr   stop at 98.50; trails 3x ATR once price is 3x ATR above it
```

Until it arms, the orders panel shows `ARM`. Arming is the one transition that nothing on the order itself records, so Tame writes it to the journal when it happens.

Typing `trail` alone prints the usage line. Error messages are listed in the [Command reference](reference/commands.md#trail).

## Chase orders

```
chase buy <size> [decay]
chase sell <size> [decay]
cancel chase
```

A chase posts a passive limit order at the touch and re-prices it as the book moves, cancelling and replacing only when the move is at least one tick. It uses the exchange's WebSocket book and order feeds where both exist and polls otherwise.

```
chase buy 10          chase the bid until filled
chase sell 10 90s     chase the ask, give up after 90 seconds
chase buy 10 5m       give up after five minutes
```

The optional decay is `<n>s` or `<n>m`. With one, the orders panel shows an `EXPIRES` countdown, amber in the final seconds, and the chase is cancelled at the deadline. Only one chase runs at a time.

A chase gives up after five consecutive errors. When it ends you see one of:

| Message | Meaning |
|---|---|
| `Chase ended with <n> unfilled.` | Cancelled or decayed with size remaining |
| `Chase ended — the exchange has not reported the outcome yet. Check your position.` | The feed went quiet before confirming |
| `Chase stopped unexpectedly: <reason>. Any resting order is still live.` | Check the orders panel |

## Adjusting working orders

### Move the stop

```
move stop <price>
```

Finds your resting stop by its trigger price and edits it in place, leaving the size alone. Take-profit orders are not touched. If there is no stop: `No stop order found to move`.

### Move a take profit

```
move tp <old price> <new price>
move tp <new price>
```

Names the take profit by the price it rests at, then gives the new one: from, to. The order is edited in place and keeps its size. With only one take profit resting, the old price can be left out.

```
move tp 110 112      the target at 110 goes to 112
move tp 112          the only target goes to 112
```

- The old price matches within half a tick, so it does not matter that the exchange rounded what you typed.
- Two take profits resting at the same price move together.
- The new price has to be on the winning side of the market, the same rule as placing one.
- Stops are never matched, whatever price you give.

When nothing matches, the message lists what is resting: `No take profit at 111. Resting at: 105, 110, 120. Nothing was changed.`

To change a take profit's size, `cancel tp` and place it again.

### Re-size the stop

```
update stop [size]
```

With no size, re-sizes the stop to cover the position plus resting limits. With a size, sets that size. This is a cancel-and-replace. A typed size is subject to the fatfinger limit; a derived one is not.

### Bump every order

```
bump + <value>
bump - <value>
bump <value>
```

Shifts the price of every open order on the market by the value: limit orders by editing the price, stops by moving the trigger. Take profits are left where they are. `bump +10`, `bump + 10`, and `bump 10` are all accepted. With no orders: `No open orders to bump`.

## Cancelling

| Command | Cancels |
|---|---|
| `cancel all` | Every resting order, stops included |
| `cancel limits` | Limit orders only |
| `cancel stops` | Stop-loss, take-profit, and trailing orders |
| `cancel tp` | Take-profit orders only; stops stay where they are |
| `cancel chase` | The running chase |
| `cancel orders` | Every limit order |
| `cancel orders top 3` | The third limit order from the top of the book |
| `cancel orders top 3:5` | The third through fifth from the top |
| `cancel orders bottom 2:4` | The second through fourth from the bottom |

Ranges are 1-based positions in your own resting limit orders sorted by price, `top` descending and `bottom` ascending. Stops are never included in a range cancel. Each command reports what it did: `3 limit orders cancelled.`, `No stop orders to cancel.`, or `2 orders cancelled, 1 could NOT be cancelled — check the exchange.`

A trigger order is recognised by carrying a trigger price, not by its type name, so exchange-specific type strings do not cause a stop to be missed.

## Closing a position

```
close position
```

Market-closes the whole position; the side is derived from what you hold. This is an exit, so the guardrails never hold it and the fatfinger limit does not apply. If it fails: `Position not closed: <reason>. You are still in this position.`

For a large position, `guard exit` builds a worked exit in slices rather than one market order. See [Assisted exits](guardrails.md#assisted-exits).

## Size and price shorthand

These tokens are substituted in a command before it runs:

| Token | Replaced with | Example |
|---|---|---|
| `possize` | Your current position size | `stop 99.90 possize` |
| `50%possize` | That percentage of it (whole percentages only) | `limit sell 50%possize 104.50` |
| `entry` | Your average entry price, rounded to the market's precision | `stop entry` |
| `bid` | The best bid at the moment the command runs | `limit buy 10 bid` |
| `ask` | The best ask at the moment the command runs | `tp ask` |

With no position, a command using `possize` is dropped with `Error: Cannot execute an order with a position size of zero.`

`bid` and `ask` work wherever a price goes in `limit`, `stop`, `tp`, `stop limit`, `move`, `bump`, and `bracket`, and both can appear in one command: `stop limit buy ask bid 10`. The price is read from the ticker feed, or from the book when the feed is older than five seconds, and is fixed at that moment: the order does not follow the book afterwards. For an order that does, use [`chase`](#chase-orders). Nowhere else are the words rewritten, so a coach question that mentions the ask reaches the coach as typed. If no quote is available the command is refused: `No bid price is available for SOL/USDT:USDT right now. No order was placed. Type the price instead.`

The journal records the command as you typed it; the activity log and the exchange see the substituted one.

`print` shows a value without trading: `print possize`, `print entry`, `print precision`, `print bid`, `print ask`.

## The fatfinger limit

The fatfinger limit caps how much a single order may be **worth**, so one number means the same thing on every market.

```
fatfinger           show the limit
fatfinger 5000      cap orders at 5,000 in the quote currency
fatfinger off       remove the limit
```

An order's value is size times price. Limit and stop orders are valued at the price you gave; market orders at the last traded price. On inverse contracts, where each contract is already worth one unit of the quote currency, the size is the value.

The limit is saved to your profile. It is not set by default, and Tame says so at every start until you set one. A rejected order tells you what it was worth:

```
Fatfinger guard: this order is worth 12,450.00 USDT, over your limit of 5000 USDT per order. No order was placed. Raise the limit with 'fatfinger <amount>' if this was intended.
```

**Exempt** because they cannot be a typo and refusing them could strand a position: closing a position, a stop or trail sized from the position, `update stop` with no size, and every slice of an assisted exit.

If no price is available to value an order, it is refused rather than waved through.

## What the guardrails do to an order

Before an entry is sent, the guardrails review it against the session. Intent is derived from your position, not from the word you typed: a `sell` against an open long is an exit; against no position it is an entry. Only entries are reviewed.

| Verdict | What you see |
|---|---|
| Allow | Nothing, or a single WARNING line in the activity log |
| Hold | The confirmation panel. `y` sends; anything else cancels. |
| Refuse | `<reason> No order was placed.` Only a daily loss limit you set, or a lockout, can do this. |

The review fails open: if a position lookup is slow, the order goes through rather than waits. The guard can hold or refuse; it never alters an order. Full detail in [Guardrails](guardrails.md).

## Related

- [Command reference](reference/commands.md)
- [Guardrails](guardrails.md)
- [Exchanges](reference/exchanges.md) for per-venue behaviour of stops and chases
