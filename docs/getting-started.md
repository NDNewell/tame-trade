# Getting started

This guide takes you from a clone to your first protected position. It assumes you already have an exchange account with API access.

**On this page**

- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [First run](#first-run)
- [Your first session](#your-first-session)
- [Starting Tame again](#starting-tame-again)
- [Development mode](#development-mode)
- [Where your data lives](#where-your-data-lives)

## Requirements

| Requirement | Notes |
|---|---|
| Node.js 20 or later | Tame runs TypeScript directly through `tsx`; there is no build step. |
| Yarn or npm | Either works. Examples use `yarn`. |
| A terminal at least 72 columns by 24 rows | Below 80 columns the workspace stacks its regions. At 120 columns or wider the coach gets its own sidebar. |
| An exchange API key | Read, trading, and futures permissions. See [Exchanges](reference/exchanges.md). |
| An Anthropic API key (optional) | Only needed for the coach. The guardrails work without one. |

## Install and run

```bash
git clone <this repository>
cd tame-trade
yarn install
yarn start
```

`yarn start` runs `tsx src/index.ts`. Nothing is compiled to disk.

> **Note**
> Tame allows one running instance per machine. If you start a second copy it tells you the first is running and offers to stop it. See [Only one Tame at a time](#only-one-tame-at-a-time).

## First run

The first start walks you through a profile:

1. **Create a password.** You are asked to type it twice. The password gates the home menu on later starts. It does not encrypt your keys; those are protected by file permissions (see [Where your data lives](#where-your-data-lives)).
2. **Choose an exchange.** Start typing to filter the list. Tame is built and tested against **Phemex**. Hyperliquid and Deribit are also wired in. Other names appear in the list because the underlying library supports them, but stop orders will fail on them.
3. **Enter credentials.**
   - Most exchanges: an API key and a secret.
   - Hyperliquid: a private key, an API wallet address, and the public wallet address used to read your positions.

> **Warning**
> The exchange key and secret prompts echo what you type. Clear your terminal scrollback afterwards if others can see your screen. The coach key prompt masks its input.

After the profile is created you land on the home menu.

### The home menu

| Item | What it does |
|---|---|
| **Start Trading** | Opens the workspace on your saved exchange. With more than one exchange saved, you pick one first. |
| **Add Exchange** | Save credentials for another venue. |
| **Remove Exchange** | Delete a saved exchange. |
| **AI Coach Key (set / not set)** | Store, replace, or remove your Anthropic API key. The key is masked on screen and takes effect on the next Start Trading. |
| **Delete Profile** | Remove everything in `~/.tame/config.json`. |
| **Quit** | Exit. |

> **Warning**
> Removing an exchange currently rewrites the profile with only the exchange list and password, which also drops your fatfinger limit, guard policy, and coach key. Re-enter them afterwards. This is tracked in [Known gaps](development.md#known-gaps).

## Your first session

Choose **Start Trading**. The workspace opens with the header, an empty MARKET block, and the activity log reporting the connection.

### 1. Set a fatfinger limit

Before anything else, cap what a single order can be worth:

```
fatfinger 5000
```

No single order may now exceed 5,000 in the market's quote currency. Tame reminds you on every start if no limit is set. Orders Tame sizes from your own position, such as closing out or a stop covering the position, are exempt so a protective order can always be placed. Details in [Orders](orders.md#the-fatfinger-limit).

### 2. Follow a market

Symbols are the exchange's own, exactly as the exchange spells them, and they are case-sensitive:

```
market SOL/USDT:USDT
```

If you do not know the symbol, `list markets` opens a picker: choose a market type, then start typing to filter.

Once a market is followed the MARKET and RANGE blocks fill in, and the position and order panels show what you hold there.

### 3. Place an order

```
limit buy 10 101.20
```

Order commands take size first, then price. `buy 10` on its own is a market order. The order appears in ACTIVE ORDERS, and the activity log shows it being submitted and filled.

### 4. Protect it

```
stop 99.90
```

The price comes first. With no size, the stop covers the whole position. A stop is always reduce-only, so it can only close what you hold. To have the stop follow the price instead:

```
trail 3atr 15m
```

That trails three times the 15-minute ATR behind the best price the position has seen. See [Trailing stops](orders.md#trailing-stops).

### 5. Ask where you stand

```
guard
```

Prints the session so far: whether guardrails are on, round trips and realized PnL, your daily loss limit, any lockout, and whether the coach is available. This never makes a network call.

### 6. Quit

`q`, `quit`, or `Ctrl+C`. Resting orders and exchange-side trails stay on the exchange. An ATR trail, which Tame moves itself, stops moving when Tame is not running.

## Starting Tame again

On later starts you enter your password, then the home menu. If one exchange is saved, **Start Trading** opens it directly.

Today's journal is reloaded on start, so a daily loss limit, a lockout, and the coach thread all continue from where they were. Restarting is not a way around a limit.

### Only one Tame at a time

Two instances on one account would each place orders the other cannot see or cancel, and a chase started in one cannot be cancelled from the other. So Tame holds a lock file at `~/.tame/tame.lock`.

If you start a second copy while one is running:

```
Tame is already running (pid 1234, started 04/09/2026, 09:12:33).
Two instances on the same account place orders the other cannot see or cancel.
? That session is running in another terminal.
  Leave it running and quit (switch to its terminal)
  Stop it and start here — any chase it is running stops; resting orders stay on the exchange
```

A lock left behind by a crashed instance is recognised as stale and taken over automatically.

## Development mode

`yarn dev` runs Tame under a file watcher. Any change to a `.ts`, `.js`, or `.json` file under `src/` restarts the app after a one-second settle. Before restarting, the watcher saves the current exchange and market to `~/.tame/dev-state.json`, and the new process reopens them without the password or the menu.

`yarn dev:np` does the same and also skips password creation and verification. Use it only on a machine nobody else can reach.

Development mode sets `NODE_ENV=development`. See [Development](development.md) for the rest of the workflow.

## Where your data lives

Everything is under `~/.tame/`, created with permissions that only your user can read:

| Path | Contents |
|---|---|
| `~/.tame/config.json` | Exchanges and credentials, password hash, fatfinger limit, guard policy, coach key |
| `~/.tame/journal/YYYY-MM-DD.jsonl` | The session journal: every fill, order, stop move, command, and guardrail event |
| `~/.tame/coach/YYYY-MM-DD.jsonl` | The coach conversation, one turn per line |
| `~/.tame/activity/YYYY-MM-DD.jsonl` | The activity log, including diagnostics hidden from the panel |
| `~/.tame/tame.lock` | The single-instance lock |
| `~/.tame_command_history.log` | Command history for the up and down keys |

Formats are documented in [Records on disk](reference/records.md). Fields in `config.json` are in [Configuration](reference/configuration.md).

## Related

- [The workspace](workspace.md)
- [Placing and managing orders](orders.md)
- [Command reference](reference/commands.md)
