# Guardrails

Guardrails watch your own session for the patterns that end accounts and put an order in front of you when they see one. This page explains what is measured, what happens when something fires, and how to tune it. The mechanism is deterministic: every finding is a fixed measurement you can look up and argue with, never a model's opinion.

**On this page**

- [How it works](#how-it-works)
- [Three rules that never bend](#three-rules-that-never-bend)
- [Severities](#severities)
- [The behaviours](#the-behaviours)
- [Holds and overrides](#holds-and-overrides)
- [The daily loss limit](#the-daily-loss-limit)
- [Lockouts](#lockouts)
- [Assisted exits](#assisted-exits)
- [The sweep](#the-sweep)
- [The guard command](#the-guard-command)
- [Tuning](#tuning)

## How it works

Tame keeps a session journal: every fill, order, stop move, equity sample, and typed command, written to disk per day. From that journal it derives the session at any moment: round trips, realized PnL, losing streak, peak equity, orders placed and cancelled, and the open positions.

Seventeen **detectors** each measure one thing against that session and the current market. A detector produces an observation with one plain sentence and the raw numbers behind it. Detectors never decide anything.

The **guardrails** turn observations into a verdict on the order you just typed: allow, hold, or refuse. Separately, a **sweep** every thirty seconds re-measures the standing conditions (a position without a stop, profit given back) and reports changes.

Everything about this is offline and instant. The [coach](coach.md) may later write a better sentence about a finding, but the finding was fixed before it saw it, and no order ever waits on the network.

## Three rules that never bend

1. **Nothing obstructs an exit or a protective order.** A `sell` against a long, `close position`, a `stop`, a `trail`: none of these is ever held, refused, or delayed, whatever the session looks like. A guard that can trap you in a position is more dangerous than what it guards against.
2. **Only limits you set can refuse.** The shipped defaults warn or hold. The one behaviour that blocks, the daily loss limit, has no default value. It exists only because you typed it.
3. **Nothing closes a position unless you authorised it.** When a finding is about the open position, Tame shows you a worked exit and offers to run it. It runs one on its own only for behaviours you named with `guard autoexit`.

## Severities

| Severity | Effect on an entry |
|---|---|
| `notice` | Say it and change nothing. A WARNING line in the activity log; the condition also shows on the coach panel's GUARD line. |
| `hold` | Put the order in the confirmation panel before sending it. |
| `block` | Refuse to send it. |

Defaults are deliberately conservative. A guard that holds too often trains the reflex of confirming without reading, which is worse than not holding at all.

## The behaviours

Every behaviour has a short id, which is what `guard explain`, `guard mute`, and `guard severity` take. The claim is written as an observation, not an accusation: "this entry follows a loss too closely" is something a journal can show; "you were tilted" is not.

### Tilt

The account is being traded by the last loss rather than by a plan.

| Id | Claim | Measured as | Default |
|---|---|---|---|
| `revenge-entry` | This entry follows a loss too closely to be a considered one | An entry within 5 minutes of a losing exit, on any market | hold |
| `rapid-fire` | Entries are arriving far faster than they have all session | 4 or more entries on this market within 10 minutes | hold |
| `size-escalation` | Size is climbing while the session is losing | An entry 1.75 times the session's median entry size while realized PnL is negative; needs three prior entries | hold |
| `averaging-down` | This adds to a position that is currently underwater | A same-side entry while unrealized PnL is negative | hold |
| `chasing` | Price has already run in this direction; this entry is late into it | Price moved 1.5% or more in the entry's direction over the last 5 minutes | notice |
| `direction-flipping` | Direction has reversed repeatedly in a short window | 3 or more reversals within 15 minutes | hold |
| `order-churn` | Many orders placed and pulled without much being filled | 4 or more cancels per fill, once at least 8 orders have been placed | notice |

Size escalation uses the median rather than the mean on purpose: one large entry raises the average enough that the next large entry looks normal, so escalation hides itself after its first step.

### Risk

The position could hurt more than intended, whatever the reason.

| Id | Claim | Measured as | Default |
|---|---|---|---|
| `no-stop` | An open position has had no protective stop for some time | Unprotected for more than 3 minutes since it opened | hold |
| `stop-widened` | A protective stop was moved further from entry, not closer | A stop move away from entry within the last 10 minutes | hold |
| `stop-removed` | A protective stop was cancelled while the position is still open | A stop cancelled while the position was underwater, within the last 10 minutes | hold |
| `risk-per-trade` | Planned downside on this position is above your per-trade limit | Distance to the stop, in currency, above 1% of equity | hold |
| `leverage-creep` | Position notional is large relative to account equity | Notional more than 10 times equity | notice |

A stop moved *toward* entry is a trail doing its job and is never flagged.

### Discipline

The session as a whole has gone past what was agreed with yourself.

| Id | Claim | Measured as | Default |
|---|---|---|---|
| `daily-loss-limit` | Realized losses this session have reached the limit you set | Realized loss at or beyond `guard limit` | **block** (no limit set by default) |
| `loss-streak` | Several trades in a row have lost | 3 consecutive losing round trips | hold |
| `overtrading` | This session has more trades in it than you allow for | More than 20 round trips | notice |
| `profit-giveback` | Equity has fallen a long way from where it peaked this session | Equity down 40% or more of the session's peak *profit* | hold |
| `session-length` | You have been trading for a long stretch without a break | More than 4 hours since the first event | notice |

Give-back is measured against the profit made this session (peak minus opening equity), not against the peak itself.

To read the full reasoning behind any of these:

```
guard explain size-escalation
```

Thresholds are listed with their config keys in [Configuration](reference/configuration.md#guard-policy).

## Holds and overrides

When an entry is held, the confirmation panel replaces the position block, showing the order, its estimated value, and the finding:

```
 CONFIRM ORDER
 BUY MARKET
 Size         10
 Est. Value   1,016.20
 Revenge entry: this entry follows a 312.40 loss by 2 minutes. (+1 more)
 'y' to send anyway, anything else cancels
```

Your next command answers it. `y` sends the order and records one **override** per finding in the journal. `n` drops it. Any other command drops it and runs.

Overrides are counted on purpose. A guard that is overridden every single time is either wrong or being used as a formality, and the debrief can only say so if the overrides were recorded. They appear in `guard` status, in the coach's facts, and in the one-line summaries of previous days.

## The daily loss limit

```
guard limit 500       stop new entries after 500 realized loss
guard limit           show it
guard limit off       remove it
```

The daily loss limit is the one rule that refuses. Its whole value is that it is not renegotiated by the person who has just hit it. It is derived from the journal on disk, so restarting Tame does not reset it, and it is only ever a number you typed.

When it fires, entries are refused with the reason, and a lockout begins.

## Lockouts

A lockout stops new entries for a period, 30 minutes by default. It is triggered only by a discipline behaviour you have raised to `block`, which out of the box means only the daily loss limit. While it is in force:

```
Entries are stopped for another 24 minutes: realized loss 512.40 has reached your limit of 500. Closing and protective orders still work. No order was placed.
```

Exits and stops work as always. The lockout is written to the journal, not held in memory, so quitting and restarting does not clear it.

You can lift it deliberately:

```
guard unlock
```

This writes a `lockout-lifted` event and replies `Lockout lifted. It is on the record.` There is no argument for making this impossible, since a real emergency does not care what the guard decided twenty minutes ago, but there is every argument for making it deliberate and visible afterwards.

A lockout does not extend itself: while one is running, the sweep will not start another.

## Assisted exits

Some findings are about the open position itself: the daily loss limit, profit give-back, a position without a stop, risk per trade above the limit, leverage. For those, Tame builds a **worked exit**: a schedule of reduce-only slices sized to get out at a sensible cost rather than one market order into the book. The plan follows the execution literature (an Almgren-Chriss style trajectory) and re-reads the position from the exchange before every slice.

When such a finding appears, you see the plan:

```
Position without a stop: unprotected for 7 minutes. A worked exit is ready: Measured: 3 children over 60s, resting inside the 2-tick spread first and escalating if they do not fill. expected to beat crossing everything by about 0.012000 USDT per unit. Run it with 'guard exit', or authorise it in future with 'guard autoexit no-stop'.
```

To run it yourself:

```
guard exit           measured pace
guard exit firm      faster
guard exit now       immediate
guard exit stop      stop a running exit; anything already resting stays
```

To let Tame run it without asking, for one behaviour:

```
guard autoexit no-stop
guard autoexit off
```

Turning this on prints a loud warning because it is the only setting that lets the software send an order nobody typed. The exit executor is written to a stricter standard than the rest of Tame: every child order is reduce-only, size is re-read before each slice, and it halts on anything unexpected.

## The sweep

Every thirty seconds Tame re-measures the standing conditions. Findings are treated as state, not news: a condition that is still true is not reported again. You are told when one **appears**, when it **escalates** in severity, and when it **clears**:

```
Position without a stop: unprotected for 4 minutes.
Position without a stop: cleared.
```

Notices are silent in both directions; they are visible on the GUARD line of the coach panel instead. A condition that clears and reappears within fifteen minutes is not re-announced unless it comes back worse.

The sweep is advisory and never the reason a session ends. If a pass hangs it is abandoned after sixty seconds with a warning, and the next one starts fresh.

## The guard command

```
guard                                    where the session stands
guard on | off                           the whole system
guard explain <id>                       what a behaviour means and why it is checked
guard limit <amount> | guard limit off   daily loss limit
guard mute <id> | guard unmute <id>      stop checking one behaviour
guard severity <id> <notice|hold|block>  change what a behaviour does
guard autoexit <id> | guard autoexit off let the guard close a position on this behaviour
guard unlock                             lift a lockout, on the record
guard exit [now|firm] | guard exit stop  run or stop a worked exit
guard debrief                            write the coach's debrief (same as 'coach')
```

`guard` on its own prints:

```
Guardrails: on
Session: 142m, 3 round trips, -312.40 USDT realized
Losing streak: 2
Daily loss limit: 500 (187.60 left)
Muted: chasing
Coach: available (key from your profile)
```

This answer never involves the network, so it is instant and identical every time. Every setting change replies `Guardrails updated.` and is saved to your profile.

## Tuning

- **Turn a behaviour off** with `guard mute <id>` when it is wrong for how you trade. A muted behaviour is dropped before it can become a finding.
- **Change what it does** with `guard severity <id> notice|hold|block`. Raising a discipline behaviour to `block` makes it able to lock you out.
- **Change a threshold** by editing the guard section of `~/.tame/config.json`. Every threshold is documented in [Configuration](reference/configuration.md#guard-policy). There is no command for thresholds yet.
- **Reset to defaults** by removing the `guard` key from `config.json` while Tame is not running.

## Related

- [The coach](coach.md), which writes about what the guard measured
- [Configuration](reference/configuration.md#guard-policy)
- [Records on disk](reference/records.md) for the journal events behind every measurement
