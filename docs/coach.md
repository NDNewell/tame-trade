# The coach

The coach is a trading coach built into the workspace. It reads your session journal, the market, and your previous week of sessions, and answers what you ask in the coach panel. It can also write a debrief of the day, and put a sharper sentence on a guardrail hold. This page covers setup, what it can see, how it answers, and how to tune it.

**On this page**

- [What the coach is and is not](#what-the-coach-is-and-is-not)
- [Setup](#setup)
- [Asking a question](#asking-a-question)
- [What the coach can see](#what-the-coach-can-see)
- [Web search](#web-search)
- [The debrief](#the-debrief)
- [Guardrail sentences and remarks](#guardrail-sentences-and-remarks)
- [Cost and latency](#cost-and-latency)
- [The transcript on disk](#the-transcript-on-disk)
- [Tuning the brief](#tuning-the-brief)

## What the coach is and is not

Everything else in the guard is deterministic: detectors measure, guardrails decide. The coach is on the other side of that line. It is asked to **write about what was measured**, never to decide whether something was measured, and never to decide what happens about it.

That division exists for latency and trust in equal parts. An order cannot wait on a network call, so the coach is never in the path of one. And a guard whose findings varied run to run could not be argued with, so the findings are fixed before the coach sees them.

The coach is optional. Without a key, every guardrail works and uses its own wording. It is just blunter.

The coach's voice is an experienced colleague, not a compliance function and not a therapist. It cites your own figures, refers to what it said on previous days rather than rebuilding it, and says what the evidence supports and how it would be wrong. It never asserts your state of mind.

## Setup

1. From the home menu choose **AI Coach Key**.
2. Paste an Anthropic API key. Input is masked. A key that does not start with `sk-ant-` is stored with a warning.
3. Choose **Start Trading**. The key is live without a restart.

The key is stored in `~/.tame/config.json` beside your exchange credentials, and never leaves the machine except in calls to Anthropic. To remove it, open the same menu item and clear it.

Alternatively export `ANTHROPIC_API_KEY` in your shell. A key stored in the profile always beats an exported one: someone who has just typed a key into Tame is entitled to expect it to be used, and a stale export fails by quietly working with the wrong account.

Check which key is in use with `guard`, whose last line is one of:

| Line | Meaning |
|---|---|
| `Coach: available (key from your profile)` | Stored key in use |
| `Coach: available (key from ANTHROPIC_API_KEY)` | Exported key in use |
| `Coach: off — the key was rejected. Enter another from the home menu.` | Anthropic refused the key |
| `Coach: off — add a key under 'AI Coach Key' on the home menu.` | No key |

The model is `claude-opus-5`.

## Asking a question

Press `Tab` to focus the coach prompt, type, and press `Enter`. Or from the command prompt:

```
coach is my stop too tight for the 4h range?
```

Your question is painted in the panel immediately and the answer arrives when it is ready, with `thinking...` in between. The command prompt keeps working the whole time; a model call is never between you and the next command.

```
coach            write the debrief
coach clear      empty the thread
```

The thread remembers the conversation. Only your newest question carries the current numbers, so a long thread does not contain three contradictory equity figures. On restart, today's conversation is restored to the panel.

Answers are short and match the question. A question about a mechanism gets the mechanism; a question about the position gets the position read; a recommendation the coach already made is referred to in a clause rather than rebuilt.

## What the coach can see

The coach is handed three things at the moment you ask, and can re-read none of them afterwards.

### Today's journal

Session length, realized PnL, opening, peak, and current equity, round trips with wins and losses, average win and loss, how long winners and losers were held, longest losing streak, orders placed and cancelled, the trades themselves, every guardrail that fired, what was overridden, and what was flagged. Nothing that identifies you or your account.

The hold-time asymmetry between winners and losers is there on purpose: it is the one statistic that most reliably shows cutting winners and running losers, and it is invisible in a PnL total.

### The market

The block the coach sees is built by the same code that draws the screen, so the coach and the panel cannot disagree:

- Price, top of book, mark, index, spread, funding
- The high, low, and ATR(14) of each RANGE window
- The position: side, size, entry, unrealized PnL, leverage, liquidation, planned risk, how much of the size stops cover, and funding cost per day
- Every working order described by what it will do: "SELL the whole position, stop, triggers at 99.90" or "trails 3x ATR(15m) once price reaches 104.20"
- Candles at eight sizes, one-minute through monthly, covering roughly the last hour through the last three years

The block is stamped with when it was read. If the reading is more than a minute old it says so, and the coach quotes it as of its own time rather than describing the market as doing anything since. Clock times are your local time; daily and coarser bars keep the exchange's date, which is what those bars are called on any chart.

### Previous sessions

The last seven days as a timeline: what was typed, filled, moved, armed, flagged, and overridden, with each day's coach conversation. Days eight through ninety as one line each: trades, realized PnL, wins and losses, what was flagged, how many overrides. The coach is told plainly when there is no history yet.

Not available: order-book depth, positioning data, other instruments (except through search), and anything after the moment the block was read.

## Web search

The coach can search the web, up to three times per answer, and decides when to. The brief tells it to search when something outside the terminal would change the answer: what moved the instrument, a scheduled release, a story you raised, what the wider market did. It is told never to search for anything the market block already answers.

Two things the brief is specific about:

- **Go and get it.** A sharp candle on the half-hour of a jobs report means look up the result, not the preview. A headline you paste gets checked, corrected, or completed with what you left out. A question about the market as a whole is answered from outside these candles.
- **Sources with dates.** A number without a date is not evidence. Reported and speculated are kept apart. The market block is authoritative on price. A headline is not a reason to trade.

Search is offered on questions and debriefs only, never on the one-line sentences that must appear at the speed of a keypress.

## The debrief

```
coach
```

With no question, the coach writes the debrief: the one thing that most affected the outcome, what the journal shows happened after any overridden guardrail, and the single change worth making tomorrow, stated as an instruction. `guard debrief` is the same command.

The debrief runs only when you ask. If nothing happened, no trades and no findings, you get `Nothing to say about this session yet.` and no call is made.

## Guardrail sentences and remarks

**Held orders.** When an order is held, the guardrail's own sentence goes on the confirmation panel at once. The coach is asked, in parallel and with a budget of about a second, for a sharper one-sentence version. If it arrives in time it appears in the activity log as a WARNING. The panel never waits for it.

**Remarks.** When a `hold`-level condition appears or gets worse, the coach can add one unprompted sentence to the panel. This is off by default: every unprompted remark is a model call you did not ask for, and the condition is already on the GUARD line and in the log. To enable it, set `coachRemarks` to `true` in the guard section of `config.json` (there is no command yet). Remarks are limited to one every five minutes and two per behaviour per session, and never interrupt an answer in progress.

## Cost and latency

| Call | When | Search | Typical time |
|---|---|---|---|
| Question | You ask | Yes | 10 to 40 seconds; longer with searches |
| Debrief | `coach` | Yes | 20 to 60 seconds |
| Hold sentence | An order is held | No | Under 1.2 seconds or not used |
| Remark | A condition appears, if enabled | No | A few seconds |

The brief and the previous-sessions block are sent as cached prompt prefixes: the brief never changes and the history changes once a day, so a week of sessions costs full price once per day and is cheap on every call after. Only today's numbers, the market, and your question are paid for at full rate.

A call carrying a search is streamed so a long answer is not abandoned and retried. The ceiling on one answer is three minutes.

When a call fails, the panel says `The coach could not answer that one. The numbers above are unchanged.` and the activity log has the reason as a WARNING, for example `[Coach] 429: rate limited` or `[Coach] Anthropic credentials were rejected; coaching is off.`

## The transcript on disk

Every turn is written to `~/.tame/coach/YYYY-MM-DD.jsonl` as it is shown, one JSON object per line:

```json
{"at":1788527854049,"speaker":"coach","occasion":"answer","text":"...","market":"SOL/USDT:USDT"}
```

`occasion` distinguishes an answer to a question from a remark that arrived uninvited, a debrief, or a hold sentence. The file is plain text on purpose: it is meant to be read by whoever is refining the coaching, not only by the coach. Format details in [Records on disk](reference/records.md#coach-transcript).

## Tuning the brief

The coach's instructions live in one constant, `SYSTEM`, at the top of `src/guard/coach.ts`. It is held fixed because it is a cache prefix; anything that varies per call goes in the user turn, never in the brief.

The transcript is the test bed. When the coach answers badly, the log shows the exact question and the exact answer, and the brief can be changed against them. To try a change without waiting for the next live session, replay today's real questions against the current brief:

```bash
cp -r ~/.tame /tmp/tame-copy/.tame && rm /tmp/tame-copy/.tame/tame.lock
HOME=/tmp/tame-copy npx tsx replay-coach.ts SOL/USDT:USDT replay.json
```

This reads the questions from today's transcript, builds a live market block through the app's own exchange client, derives the snapshot from the journal, and asks each question in turn with the replayed answers as the thread. It records search counts, queries, token usage, and timing per answer. It is read-only against the exchange but makes billable Anthropic calls, and it appends to the coach log, which is why it runs with `HOME` pointed at a copy.

Things the brief is currently specific about, because each one was a real failure:

- Quote a stale market block as of its own timestamp.
- Never say "I have no source for that" while holding a search tool.
- Check a pasted figure rather than taking it as given.
- Answer at the size of the question; do not append the position plan to a question about something else.
- Say a recommendation once per thread and refer back to it.

## Related

- [Guardrails](guardrails.md)
- [Records on disk](reference/records.md)
- [Development](development.md#replaying-the-coach)
