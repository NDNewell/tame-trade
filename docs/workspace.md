# The workspace

The workspace is the fixed screen you trade from. It is repainted in place rather than scrolled, so there is one current view, and the command line stays at a fixed row no matter how much activity arrives. This page explains every region, how the screen adapts to terminal size, and every key it responds to.

**On this page**

- [Layout](#layout)
- [Regions](#regions)
- [The two prompts](#the-two-prompts)
- [Keys and mouse](#keys-and-mouse)
- [The confirmation panel](#the-confirmation-panel)
- [The activity log](#the-activity-log)
- [Colour](#colour)

## Layout

Tame picks a composition from the terminal's size:

| Width | Composition |
|---|---|
| 120 columns or wider | Trading column on the left, coach sidebar on the right, two prompts side by side. |
| 80 to 119 columns | Trading regions full width; the coach becomes a three-row band under the activity log; one prompt. |
| Below 80 columns | Stacked layout. Reference values are dropped rather than squeezed, and a static command footer appears. |

The minimum is 72 by 24. Resizing the terminal repaints immediately. When the terminal is too short for everything, the RANGE block yields first, then the activity log shrinks.

A wide terminal looks like this:

```
 TRADING TERMINAL                                            LIVE | CONNECTED
 Phemex | Perpetual                  Balance 2,835.68   Equity 5,913.42 USDT
──────────────────────────────────────────────────────────┬───────────────────
 MARKET                                                   │ COACH
 SOL/USDT:USDT   101.62   Bid 101.58   Ask 101.60  24h..  │ GUARD 1 · RISK PER TRADE (HOLD)
 Mark 101.62     Index 101.65  Funding 0.0091% (9.92% APR)│
 RANGE      5m     15m    30m     1h     4h    1d  ...    │ YOU  is the stop too tight?
 High    101.73  101.73  101.73 102.16 104.44 105.8       │ COACH  It sits 0.81x the 4h
 Low     101.30  101.29  101.01 100.61 100.10 100.1       │ ATR below mark, under...
 ATR(14)  0.46    0.65    0.77   1.04   1.88   5.21       │
 POSITION                     │ ACTIVE ORDERS             │
 Side       LONG              │ ID    SIDE QTY  PRICE ..  │
 Size       1,000 SOL         │ 8a1f  SELL ALL  99.90 ..  │
 ...                          │                           │
 ACTIVITY                                                 │
 07:33:02  ORDER   SELL  ALL   99.90  STOP WORKING        │
 ...                                                      │
──────────────────────────────────────────────────────────┴───────────────────
 > stop 99.90_                                            │ > Ask coach...
```

## Regions

### Header

Two rows, full width. The first names the application and the connection state; `CONNECTED` is green and anything else red. The second shows the exchange and instrument type on the left, and balance, equity, and account on the right.

As the terminal narrows the right side drops figures in a fixed order: account first, then balance, leaving equity last, because equity is the figure that moves when a position does. The currency is printed once, on whichever figure remains.

The symbol is not repeated here. It is named once, in MARKET.

### MARKET

| Row | Fields |
|---|---|
| Primary | Symbol, last price, bid, ask, 24-hour change |
| Secondary | Mark, index, funding, spread |

Funding is shown as the per-interval rate and the annualised rate together, for example `0.0091% (9.92% APR)`, because the per-interval figure looks negligible and the yearly one tells you whether holding costs anything. The interval comes from the instrument.

### RANGE

Eight trailing windows across: `5m 15m 30m 1h 4h 1d 1w 1mo`. Three rows: high, low, and ATR(14) of one bar of that size.

The pairing is the point. High and low are where price has been over the window; ATR is what one bar of that size typically covers. A one-hour range far wider than the one-hour ATR says this hour is not an ordinary one. The block shows `--` in every cell from the first frame and fills in as candles arrive, so the panels below it do not jump.

### POSITION

Side, size, entry, mark, unrealized PnL, realized PnL, position risk, funding per day, leverage, effective leverage, liquidation. Empty reads `No open position`.

**Position risk** is what your stops actually leave exposed, in the settlement currency. It is yellow when non-zero because a positive figure here is exposure. Three states are kept distinct:

| Shown | Meaning |
|---|---|
| `--` | No protective order covers the position |
| `0.00 USDT` | Covered, and the stop is at or beyond breakeven |
| `312.40 USDT` | Covered; this is the planned downside to the stop |

Partial coverage appends `+ 400 SOL unprotected`, or `[PARTIAL]` when the panel is narrow. Stops that cannot be resolved to a single reading show `-- [AMBIGUOUS STOPS]`.

**Funding** on this panel is the cost of holding this position at this size, shown per 24 hours, for example `-26.78/24h`. The rate on MARKET is a property of the instrument; this is a property of your position.

### ACTIVE ORDERS

| Column | Meaning |
|---|---|
| ID | Order id, shortened; the first column to give up width |
| SIDE | BUY or SELL, coloured by direction |
| QTY | Size. `ALL` means the order covers the whole position at trigger time |
| PRICE | Limit price, or trigger price for a stop |
| TYPE | LIMIT, STOP, and so on |
| STATUS | WORKING, STOP WORKING |
| MODE | `CHASE` for a running chase, `TRAIL` for an exchange-side trail, `ATR` for a Tame-managed volatility trail, `ARM` for a delayed trail not yet trailing |
| EXPIRES | Countdown for a chase with a decay time; shown by width, not by whether a chase is running, so columns never shift |

Empty reads `No active orders`.

### ACTIVITY

The event log, newest at the bottom. Trade events (orders, fills) render in fixed columns so they scan; everything else keeps its message and wraps to at most two rows. Scroll back with the mouse wheel; the label then reads `scrolled back N` until you return to the bottom. Details in [The activity log](#the-activity-log).

### COACH

The conversation with the coach, oldest first, with `YOU` and `COACH` speaker labels. While an answer is being written the panel shows `thinking...`. Empty reads `Ask below.`

Standing guardrail conditions lead the panel in bold yellow, as `GUARD 2 · RISK PER TRADE (HOLD), GIVE BACK`. That line is not a message from the coach. It is the guard's current state, placed where you will see it, with a wider gap beneath it before the conversation resumes. The ids are the ones `guard explain` takes.

The coach panel is the one place Tame renders structure in text: paragraphs, `- ` bullets, and `**bold**` come through. Tables and code blocks are flattened into prose, because a half-rendered table is worse than a sentence.

## The two prompts

The bottom row holds two prompts when the coach sidebar exists. The left one sends orders. The right one asks questions. They are never merged: a shared prompt would make the difference a matter of remembering which mode you were in.

`Tab` moves focus between them. The focused prompt keeps the cyan caret; the other dims. A long question grows upward into the coach column, up to six rows.

Anything typed at the coach prompt is handled exactly as `coach <question>` typed at the command prompt. When the terminal is too narrow for the sidebar, `Tab` does nothing and the command `coach <question>` is the way to ask.

## Keys and mouse

| Key | Effect |
|---|---|
| `Enter` | Submit the focused prompt |
| `Tab` | Move focus between the command prompt and the coach prompt (wide layout only) |
| `Backspace` | Delete the last character |
| `Ctrl+U` | Clear the focused prompt |
| `Up` / `Down` | Recall command history (command prompt only; the coach prompt has no history) |
| `Shift+Up` / `Shift+Down` | Scroll the coach thread by three rows |
| Mouse wheel | Scroll the activity log, or the coach thread when the pointer is over the coach column |
| `Ctrl+C` | Quit |

There is no cursor movement within the line, no word delete, and no Page Up or Page Down. Editing is append, backspace, and clear.

Command history persists across sessions in `~/.tame_command_history.log`, capped at 500 entries with consecutive duplicates dropped.

## The confirmation panel

When a guardrail decides an order should be looked at before it is sent, the order is **held**. The POSITION and ACTIVE ORDERS block is replaced by a confirmation panel; the header and MARKET stay visible, because the price and the position you already hold are what you want in front of you while deciding:

```
 CONFIRM ORDER
 BUY MARKET
 Size         10
 Est. Value   1,016.20
 Est. Fee     --
 Revenge entry: this entry follows a 312.40 loss by 2 minutes.
 'y' to send anyway, anything else cancels
```

The panel borrows its rows from the activity log, so the command line never moves.

Your **next command** is the answer:

| You type | Result |
|---|---|
| `y` or `yes` | The order is sent. Each finding is recorded as an override in the journal. |
| `n` or `no` | The order is dropped. |
| Anything else | The held order is dropped **and the command runs**. Typing `cancel all` while an order is held cancels everything, and does not send the held order. |

The hold is answered as a command rather than a keystroke so that every other command keeps working while one is pending. The wording on the panel is the guardrail's own; if the coach is configured, a sharper sentence may follow in the activity log a moment later, but the panel never waits for it.

Only entries are ever held. Exits and protective orders are never held, refused, or delayed. See [Guardrails](guardrails.md).

## The activity log

Everything Tame would once have printed to the console lands here, because a stray line of console output in a fixed-frame workspace tears the frame apart.

| Category | Colour | Examples |
|---|---|---|
| ERROR | Red | Rejections, refused orders, held orders |
| FILL | Green | Fills; the side carries the direction colour so a sell fill never reads as a buy |
| WARNING | Yellow | Guardrail findings, coach warnings, abandoned refreshes |
| ORDER | Cyan | Submissions, cancellations, stop updates |
| MARKET | Bright blue | Market selection, connection events |
| SYSTEM | Grey | Status output such as `guard`, diagnostics |

Behaviour worth knowing:

- **Repeats fold.** An identical message within five minutes increments a counter on the existing row, shown as `(x7)`, rather than adding a row.
- **Long failures are condensed.** An exchange error is cut at its payload and tagged with a two-word cause: `request queue full`, `timeout`, `rate limited`, `unsupported`, `network`, `auth rejected`, `insufficient balance`. Cuts fall on word boundaries only, so a price is never severed mid-digit.
- **Ordering is by when it happened,** not when it arrived, because the order feed replays recent history on reconnect.
- **The panel holds 500 events.** The full day, including diagnostics hidden from the panel, is written to `~/.tame/activity/YYYY-MM-DD.jsonl`.

## Colour

Colour is applied as spans over a character grid, never embedded in text, so styling can never shift a column. Every coloured value also has a textual label, so colour is never the only carrier of meaning.

| Colour | Meaning |
|---|---|
| Green | Long, buy, positive PnL, connected |
| Red | Short, sell, negative PnL, error |
| Yellow | Warning, exposure, the confirmation panel, guard conditions |
| Cyan | The focused prompt, order events |

`--` means "no value". It is deliberately two characters so it cannot be mistaken for the minus sign of a negative number.

Box-drawing characters are used when the terminal advertises UTF-8 (through `LANG`, `LC_ALL`, or `LC_CTYPE`) and `TERM` is set and not `dumb`. Otherwise the frame is drawn with `+`, `-`, and `|`.

## Related

- [Placing and managing orders](orders.md)
- [Guardrails](guardrails.md)
- [The coach](coach.md)
