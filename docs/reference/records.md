# Records on disk

Tame keeps three append-only records under `~/.tame/`, one file per local calendar day, one JSON object per line. They share one discipline: a line that will not parse is skipped rather than fatal, and a failed write costs persistence rather than the running application. This page documents each format.

All three are plain text on purpose. They are meant to be read back, by Tame on restart, by the coach as history, and by you.

**On this page**

- [Session journal](#session-journal)
- [Coach transcript](#coach-transcript)
- [Activity log](#activity-log)
- [Repair and backfill](#repair-and-backfill)

## Session journal

`~/.tame/journal/YYYY-MM-DD.jsonl`

The journal is a list of facts, not a set of counters, so it can be asked new questions later. Everything the guardrails know is derived from it, from scratch, every time it is asked: round trips, realized PnL, losing streak, peak equity, open positions, the daily loss limit, and any lockout. Because it is on disk, none of that resets when Tame restarts.

Every event has `type` and `at` (Unix milliseconds). A day boundary mid-session opens a new file without forgetting the open position.

### Event types

| `type` | Fields | Recorded when |
|---|---|---|
| `fill` | `market, side, size, price, contractSize?, inverse?, fee?, orderId?, filledTotal?` | An order fills. `filledTotal` de-duplicates a fill replayed by the order feed on reconnect. |
| `order-placed` | `market, orderId?, description?, reconstructed?` | An order is placed. `description` is the panel's own sentence for it. `reconstructed: true` means it was observed on the exchange rather than seen being placed. |
| `order-cancelled` | `market, orderId?` | An order is cancelled. |
| `order-amended` | `market, orderId?, field, from?, to?, by` | A price, trigger, or quantity changes. `field` is `price`, `trigger`, or `quantity`; `by` is `chase`, `trail`, or `operator`. |
| `stop-moved` | `market, side, from, to, entryPrice?` | A protective stop's trigger moves. |
| `stop-cancelled` | `market, trigger, underwater` | A protective stop is cancelled; `underwater` says whether the position was losing at the time. |
| `trail-armed` | `market, orderId?, armPrice, trigger` | A delayed trail begins trailing. The one transition nothing on the order itself records. |
| `exit-planned` | `market, urgency, slices, quantity, description?` | A worked exit is built, whether or not it runs. |
| `equity` | `equity, currency` | On a new high or low, a 0.1% move, or every 60 seconds. |
| `override` | `market, behaviour` | You sent a held order with `y`. One per finding. |
| `flag` | `market, behaviour, severity` | A guardrail fired on an order you proposed. |
| `lockout` | `until, behaviour, reason` | A lockout begins. A later one replaces it. |
| `lockout-lifted` | `reason` | `guard unlock`. |
| `command` | `text, market?, accepted, error?` | Every line typed, exactly as typed, before substitution. |
| `reconciliation` | `market, observed?, derived?` | The exchange's view of a position is recorded beside the journal's, when they are compared. Never reconciled: a record that admits a gap is better than one that lies plausibly. |

Example lines:

```json
{"type":"command","at":1788527827793,"text":"stop 99.90","market":"SOL/USDT:USDT","accepted":true}
{"type":"order-placed","at":1788527828102,"market":"SOL/USDT:USDT","orderId":"8a1f...","description":"SELL the whole position, stop, triggers at 99.90"}
{"type":"equity","at":1788527830000,"equity":5913.42,"currency":"USDT"}
{"type":"override","at":1788528005652,"market":"SOL/USDT:USDT","behaviour":"revenge-entry"}
```

### What is derived from it

| Figure | Derivation |
|---|---|
| Round trips | Fills applied in order; a reversal through flat both closes and opens |
| Realized PnL | Sum over closed round trips; inverse contracts as a difference of reciprocals |
| Consecutive losses | Losing round trips since the last winner |
| Opening, peak, current equity | First, highest, and latest `equity` sample |
| Lockout | The latest `lockout` whose `until` is in the future and which no later `lockout-lifted` cancels |
| Session start | The first event's timestamp |

## Coach transcript

`~/.tame/coach/YYYY-MM-DD.jsonl`

Every turn shown in the coach panel, in the order it was shown. The panel keeps the last sixty; the file keeps all of them. On restart, today's tail is replayed into the panel.

| Field | Values | Meaning |
|---|---|---|
| `at` | ms | When the turn was shown |
| `speaker` | `operator`, `coach`, `system` | Who said it. `system` is the panel's own voice (`thinking...`, error notes). |
| `occasion` | `question`, `answer`, `remark`, `debrief`, `confirmation`, `system` | Why it was said. `remark` arrived uninvited; `confirmation` is a hold sentence. |
| `text` | string | The turn |
| `market` | string, optional | The followed market at the time |
| `behaviour` | id, optional | For anything unprompted, the behaviour that caused it |

```json
{"at":1788527862316,"speaker":"operator","occasion":"question","text":"BETS ON SEPTEMBER RATE HIKE JUMP TO 64% FROM 50%","market":"SOL/USDT:USDT"}
{"at":1788527893317,"speaker":"coach","occasion":"answer","text":"The 50% starting point checks out. ...","market":"SOL/USDT:USDT"}
```

`system` turns are shown to you but never sent to the model.

## Activity log

`~/.tame/activity/YYYY-MM-DD.jsonl`

Everything the ACTIVITY panel shows, plus diagnostics the panel hides. The panel holds five hundred events and a busy session overruns that inside an hour; the file is the part of the day you can go back and look at.

| Field | Meaning |
|---|---|
| `time` | `MM-DD HH:MM:SS`, local |
| `at` | ms |
| `category` | `SYSTEM`, `MARKET`, `ORDER`, `FILL`, `WARNING`, `ERROR` |
| `message` | The condensed line the panel showed |
| `detail` | Optional extra text |
| `full` | The uncondensed message when it was shortened |
| `debug` | `true` for diagnostics hidden from the panel |
| `repeats` | Count when identical messages were folded |

Warnings and errors are never marked diagnostic, however they are prefixed. Hiding a failure behind a noise filter is how a rejected order goes unnoticed.

## Repair and backfill

Two scripts in the repository root operate on the journal. Both are read-only against the exchange, both default to a dry run, and both keep the original.

| Script | Purpose |
|---|---|
| `npx tsx repair-journal.ts [--write]` | Removes duplicate fills from every journal file. Older files are de-duplicated by exact line identity. Writes a `.jsonl.orig` backup that is never overwritten. |
| `npx tsx backfill-state.ts [--write]` | Records working orders and the position the exchange reports into today's journal, as `order-placed` events marked `reconstructed` and a `reconciliation`. Never invents a fill. Appends only, so it is safe while Tame is running. |

See [Development](../development.md#scripts) for the full list of scripts.

## Related

- [Guardrails](../guardrails.md)
- [The coach](../coach.md)
- [Configuration](configuration.md)
