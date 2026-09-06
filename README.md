# Tame

Tame is a terminal client for trading crypto perpetuals. You type short commands (`limit buy 1 101.20`, `stop 99.90`, `trail 3atr 15m`), and a fixed workspace shows the market, your position, your working orders, and an activity log, all repainted in place.

Two things set it apart from a plain order-entry tool:

- **Behavioural guardrails.** Tame watches your own session for the patterns that end accounts (revenge entries, size escalation, a position left without a stop) and holds an order in front of you when it sees one. Nothing ever obstructs an exit or a protective order, and nothing blocks unless you set the limit yourself.
- **A trading coach.** With an Anthropic API key, a coach reads your journal, the market, and your previous week of sessions, and answers questions in a side panel. It writes about what was measured; it never decides what happens.

Tame runs from source with `tsx`. It is built and tested against **Phemex**, with Hyperliquid and Deribit wired in.

## Quickstart

```bash
git clone <this repository>
cd tame-trade
yarn install
yarn start
```

On first run Tame asks you to create a password, choose an exchange, and paste an API key and secret. Keys need **read, trading, and futures** permissions. Everything is stored in `~/.tame/config.json`, readable only by you.

Then, in the trading screen:

```
market SOL/USDT:USDT      follow a market (exact exchange symbol)
fatfinger 5000            cap any single order at 5,000 USDT
limit buy 10 101.20       rest a bid
stop 99.90                protect the whole position
guard                     where the session stands
```

Press `Tab` to move to the coach prompt and ask it something. `Ctrl+C` quits.

## Documentation

**Guides**

| Page | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first run, your first market and order, development mode |
| [The workspace](docs/workspace.md) | Every region of the screen, the two prompts, keys, the confirmation panel |
| [Placing and managing orders](docs/orders.md) | Market, limit, stop, trailing stops, chase, bump, cancel, the fatfinger limit |
| [Guardrails](docs/guardrails.md) | The seventeen behaviours, severities, holds and overrides, lockouts, assisted exits |
| [The coach](docs/coach.md) | Setup, asking questions, what the coach can see, debriefs, tuning the brief |

**Reference**

| Page | What it covers |
|---|---|
| [Command reference](docs/reference/commands.md) | Every command, its syntax, examples, and error messages |
| [Configuration](docs/reference/configuration.md) | `~/.tame/config.json`, every guard policy setting, environment variables |
| [Records on disk](docs/reference/records.md) | The journal, coach transcript, and activity log formats |
| [Exchanges](docs/reference/exchanges.md) | Supported venues, credentials, and per-exchange behaviour |

**For contributors**

| Page | What it covers |
|---|---|
| [Development](docs/development.md) | Architecture, running from source, tests, scripts, known gaps |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, causes, and fixes |

## Principles

These are enforced in code, not just intended:

1. **Nothing obstructs an exit or a protective order.** Closing a position and placing a stop are never held, refused, delayed, or size-limited.
2. **Only limits you set can refuse an order.** Shipped defaults warn or hold; they never block.
3. **Nothing closes a position unless you authorised it.** Tame recommends a worked exit by default and executes one only for behaviours you named with `guard autoexit`.
4. **Trails live on the exchange.** A fixed trailing stop keeps working when Tame is not running.
5. **The record outlives the process.** The session journal is written to disk per day, so a daily loss limit survives a restart.
6. **The coach describes; it never decides.** Guardrail findings are fixed before the model sees them, and no order waits on a network call.

## License

MIT.
