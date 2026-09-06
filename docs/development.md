# Development

How the code is organised, how to run and test it, and what is known to be unfinished. Read this before changing anything under `src/`.

**On this page**

- [Running from source](#running-from-source)
- [Architecture](#architecture)
- [Design rules](#design-rules)
- [Tests](#tests)
- [Scripts](#scripts)
- [Replaying the coach](#replaying-the-coach)
- [Style](#style)
- [Known gaps](#known-gaps)

## Running from source

```bash
yarn install
yarn start        # tsx src/index.ts
yarn dev          # restart on change, keep exchange and market
yarn dev:np       # same, skipping the password
yarn test         # every *.test.ts, in order, stopping at the first failure
npx tsc --noEmit  # type check
```

There is no build step. `tsconfig.json` sets `noEmit`, `strict`, and `module: node16`, which is why every relative import carries a `.js` extension even though the files are `.ts`.

`yarn dev` watches `src/` for `.ts`, `.js`, and `.json` changes with a one-second debounce. Before restarting it writes the current exchange and market to `~/.tame/dev-state.json` with a reload flag; the new process reads that and reopens the workspace without the password or the menu. The child is killed with SIGKILL, so it never releases the instance lock; the next start recognises the stale lock and takes it over.

## Architecture

```
src/
  index.ts          acquire the instance lock, start the client
  client/           session shell: home menu, credential prompts, the command dispatcher
  auth/             bcrypt password, dev bypass
  config/           config.json, dev state, instance lock
  commands/         the order grammar (buy/sell/limit/stop) and its dispatcher
  exchange/         the ccxt boundary: streams, caches, every order type, chase, trail monitor
  trading/          pure domain logic: risk, ATR, trail placement, order descriptions, exit plans
  guard/            behaviours, detectors, guardrails, policy, journal, coach
  ui/               the workspace: screen, frame, activity log, coach rendering
  utils/            formatting, notifications, error condensing, monotonic clock, pass guard
  errors/           AppError and its message table
```

### Data flow

A typed line goes:

1. `Screen.handleKey` reads raw keystrokes and hands a completed line to the workspace.
2. `UserInterface.handleCommand` journals the line as typed, offers it to a held order if one is pending, substitutes `possize` and `entry`, and matches it against the command chain.
3. An order command reaches `guardReview`, which builds a proposal (intent derived from the position, not the word) and asks `GuardService` for a verdict. Allow continues; hold shows the confirmation panel; refuse drops it.
4. `ExchangeCommand.execute` calls the matching `ExchangeClient.create*Order`, which passes the size through `getQuantityPrecision` (where the fatfinger limit is enforced), applies the per-exchange stop parameters, and sends.

The screen is fed separately: a two-second REST refresh (position, orders, risk, funds, ranges), WebSocket ticker and order feeds, a ten-second trail monitor, and a thirty-second guard sweep. Every one of those is one-at-a-time with a monotonic deadline; `src/utils/passGuard.ts` is that pattern extracted after it had been reinvented in three places.

### Module responsibilities

| Module | Owns | Knows nothing about |
|---|---|---|
| `exchange/exchangeClient.ts` | Everything that touches ccxt | Guard rules |
| `guard/` | Measuring, deciding, recording, coaching | Exchanges, markets, ccxt. Everything arrives as an argument. |
| `trading/` | Pure calculations that can close a position at the wrong price if wrong | I/O of any kind |
| `ui/` | Rendering and input | Trading semantics |

The `exchangeClient.ts` guard section is plumbing only: it hands the guard what it needs to measure and carries out what it decides. The rules are in `src/guard/`.

### Inside the guard

| File | Role |
|---|---|
| `behaviours.ts` | The closed catalogue: id, group, claim, why, default severity. Definitions only. |
| `detectors.ts` | One pure function per behaviour. No clock, no exchange, no config. |
| `guardrails.ts` | Turns observations into allow / confirm / refuse. Exits and protective orders return allow before any detector runs. |
| `guardPolicy.ts` | Every threshold and default, in one file. |
| `findingTracker.ts` | Turns per-sweep state into appeared / escalated / cleared edges, so a standing condition is reported once. |
| `sessionJournal.ts` | The append-only record and `deriveSnapshot`, recomputed from scratch every call so there is one implementation of the rules. |
| `history.ts` | Previous days assembled as a byte-stable cache prefix. |
| `marketContext.ts` | The market block the coach sees, assembled explicitly. |
| `coach.ts`, `coachThread.ts`, `coachLog.ts` | The model call, the in-memory thread, the transcript on disk. |
| `guardService.ts` | The single façade the rest of the app talks to. |

## Design rules

These are enforced by the structure and by tests. A change that breaks one needs a very good reason.

1. **Nothing obstructs an exit or a protective order.** Not held, not blocked, not delayed, not size-limited. Not negotiable by config.
2. **Only limits the operator set can refuse.** Shipped defaults never block.
3. **Nothing closes a position unless authorised.** `autoExit` defaults to empty, and that default is load-bearing.
4. **The model never decides.** Findings are fixed before the coach sees them. No order waits on a network call.
5. **The guard fails quiet.** A detector that throws is skipped. A slow position lookup lets the order through. The sweep is never the reason a session ends.
6. **State goes on a status line; events go in a log.** A condition that is still true is not news.
7. **Records outlive the process.** The journal is on disk per day. A trail's terms are in its client order id, so the exchange itself is the register.
8. **What leaves the machine is assembled explicitly.** Adding a field to the journal cannot silently start sending it to the model.
9. **Stamps use `Date.now()`; durations use `performance.now()`.** A host clock that is stepped makes every wall-clock duration meaningless. See `src/utils/monotonic.ts` for the incident that produced this rule.
10. **Colour is spans over a grid, never bytes in a string.** And never the only carrier of meaning.

## Tests

Tests are plain `tsx` scripts beside the module they cover, with no framework. `yarn test` runs each in turn, suppresses output on success, and re-runs the first failure with output visible.

The convention in every file:

```ts
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

check('A  a zero-sized trigger order is the whole position, not nothing', view.quantity === 'ALL', view.quantity);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
```

- Cases are lettered and named as full sentences stating the rule.
- The third argument is the observed value, printed on every run, so a passing run is also a readable spec.
- Each file opens with a comment naming the incident it pins down, not what the module does.
- Tests are pure and offline. Anything that touches the network or the home directory is behind an injected function.

Run one file directly with `npx tsx src/guard/coach.test.ts`.

Coverage is concentrated in `src/trading/`, `src/guard/`, and `src/exchange/` rules extracted for the purpose (`orderCacheRules.ts`, `pollGuard`). `exchangeClient.ts` itself has no tests; testable pieces are extracted from it rather than tested in place.

## Scripts

Standalone `tsx` scripts in the repository root. None are referenced by `package.json`, and none are type-checked by `tsc`. All read `~/.tame/config.json` for credentials.

| Script | Purpose | Exchange | Disk |
|---|---|---|---|
| `read-my-equity.ts [CCY]` | Print balance, positions, derived unrealized PnL, and equity as Tame computes them | Read-only | None |
| `read-my-leverage.ts <symbol>` | Dump raw position fields and seven candidate leverage formulas, to solve the denominator against what Phemex shows | Read-only | None |
| `read-my-stop.ts <symbol>` | Dump a hand-placed stop's raw shape so Tame can replicate it | Read-only | None |
| `repair-journal.ts [--write]` | Remove duplicate fills from journal files; keeps `.orig` backups | None | Rewrites with `--write` |
| `backfill-state.ts [--write]` | Record the exchange's working orders and position into today's journal without inventing fills | Read-only | Appends with `--write` |
| `replay-coach.ts <symbol> <out.json>` | Replay today's coach questions against the current brief | Read-only | Appends to the coach log; run with `HOME` pointed at a copy |

## Replaying the coach

The coach transcript is the test bed for the brief. To evaluate a prompt change on real questions:

```bash
cp -r ~/.tame /tmp/tame-copy/.tame && rm /tmp/tame-copy/.tame/tame.lock
HOME=/tmp/tame-copy npx tsx replay-coach.ts SOL/USDT:USDT replay.json
```

The script boots the real `ExchangeClient`, follows the symbol, warms the candle ladder, builds the market block, derives today's snapshot from the journal, and asks each of today's questions in order with the replayed answers as the thread. The output records, per answer: the original answer from the log, the replayed answer, seconds taken, number of searches, the queries, stop reason, and token usage including cache hits.

Read the output side by side with what the coach actually said. What to look for depends on the change, but the two failure modes the current brief was tuned against are: saying it cannot see or verify something while holding a search tool, and attaching the full position plan to a question that was not about the position.

The script makes billable Anthropic calls and is not fast: expect 20 to 40 seconds per question.

## Style

- Prettier: single quotes, trailing commas where ES5 allows, two-space indent. Not every older file matches yet.
- Comments explain **why**, and the ones at the top of a file are the authoritative statement of its purpose and the incident that shaped it. Keep them current when the code changes.
- Error messages say what happened, what was not done, and what to do next: `... No order was placed. The stop price comes first: 'stop <price> [size]'.`
- New commands: add the journal event if the command produces a plan, and extend `src/trading/orderView.ts` if it produces a new kind of working order, so the panel and the coach describe it the same way.

## Known gaps

Things the code advertises or half-implements that do not work today. Documented here so the guides do not promise them.

| Gap | Detail |
|---|---|
| `help` command | Listed in the stacked layout's footer, along with `orders` and `positions`. None has a handler; all print `Invalid command`. |
| Confirm-above threshold | `confirmAbove` is stored and validated and `describeOrder().needsConfirmation` is implemented, but nothing calls it. The only live confirmation is the guardrail hold. `Screen.confirm()`, the keystroke-answered dialog it was built for, has no callers. |
| CHASE region | `frame.ts` renders a CHASE block, but the workspace never populates it. Chase state reaches the screen only through the MODE and EXPIRES columns. |
| Removing an exchange wipes settings | `ExchangeManager.removeExchange` rewrites the profile with only the exchange list and password hash, dropping `fatFinger`, `confirmAbove`, `guard`, and `anthropicApiKey`. |
| `guard` freezes defaults | A `guard` mutation writes the fully resolved policy, not a partial, so later default changes do not reach a profile that has been touched. |
| `coachRemarks` has no command | Only reachable by editing `config.json`. |
| Thresholds have no command | Only `enabled`, `dailyLossLimit`, `muted`, `severity`, and `autoExit` are reachable from `guard`. |
| `flag` events only on review | Flags are journalled when a proposed order is reviewed, not when the sweep finds a condition, so the `flagged` column in day summaries counts only order-time findings. |
| Adding a first exchange from the menu | With no exchanges saved, `Start Trading` prompts to add one and then reads a stale list, so it returns to the menu instead of starting. Choose `Start Trading` again. |
| Exchange picker overstates support | Every ccxt Pro exchange with WebSocket support is listed. Stops work only on Phemex, Hyperliquid, and Deribit. |
| `q` with a market selected | Falls through the order parser and logs one `Invalid command` before quitting. |
| Old wireframes | `docs/mockups/` predates the RANGE block, the coach sidebar, and the second prompt. |

## Related

- [Troubleshooting](troubleshooting.md)
- [Records on disk](reference/records.md)
- [The coach](coach.md)
