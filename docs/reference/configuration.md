# Configuration

Everything Tame keeps between sessions lives under `~/.tame/`. This page documents every field of the profile, every guard policy setting with its default, and every environment variable Tame reads.

**On this page**

- [Files](#files)
- [The profile: config.json](#the-profile-configjson)
- [Guard policy](#guard-policy)
- [Environment variables](#environment-variables)
- [Permissions](#permissions)

## Files

| Path | Purpose | Written by |
|---|---|---|
| `~/.tame/config.json` | Profile: exchanges, credentials, password hash, limits, guard policy, coach key | Home menu, `fatfinger`, `guard` |
| `~/.tame/journal/YYYY-MM-DD.jsonl` | Session journal | Every fill, order, command, and guard event |
| `~/.tame/coach/YYYY-MM-DD.jsonl` | Coach transcript | Every coach turn |
| `~/.tame/activity/YYYY-MM-DD.jsonl` | Activity log with diagnostics | Every activity event |
| `~/.tame/tame.lock` | Single-instance lock: `{"pid":1234,"startedAt":"..."}` | Startup |
| `~/.tame/dev-state.json` | Development-mode restart state | `yarn dev` |
| `~/.tame_command_history.log` | Command history, last 500 lines | Every command |

Record formats are in [Records on disk](records.md).

## The profile: config.json

One JSON object. Tame writes it minified; edit it only while Tame is not running.

```json
{
  "exchanges": [
    {
      "exchange": "Phemex",
      "authType": "apiKey",
      "key": "...",
      "secret": "..."
    }
  ],
  "passwordHash": "$2b$10$...",
  "fatFinger": 5000,
  "guard": {
    "dailyLossLimit": 500,
    "muted": ["chasing"],
    "severity": { "loss-streak": "block" }
  },
  "anthropicApiKey": "sk-ant-..."
}
```

| Field | Type | Description |
|---|---|---|
| `exchanges` | array | One entry per saved exchange. See below. |
| `passwordHash` | string | bcrypt hash of the home-menu password. |
| `fatFinger` | number | Maximum value of a single order in the quote currency. Absent means no limit. Anything that is not a positive finite number is treated as unset. |
| `confirmAbove` | number | Reserved. Stored and validated, but nothing currently reads it. See [Known gaps](../development.md#known-gaps). |
| `guard` | object | Guard policy overrides. See [Guard policy](#guard-policy). |
| `anthropicApiKey` | string | The coach's key. Absent or empty means no coach. |

### Exchange entries

| Field | Used by | Description |
|---|---|---|
| `exchange` | all | Display name as chosen in the picker, for example `Phemex`. |
| `authType` | all | `apiKey` or `privateKey`. |
| `key`, `secret` | `apiKey` exchanges | API key and secret. |
| `privateKey`, `walletAddress`, `publicAddress` | Hyperliquid | Signing key, API wallet, and the public wallet used for reads. `publicAddress` falls back to `walletAddress`. |

Credentials are stored in plain text. The password does not encrypt them; the file's permissions protect them.

## Guard policy

The `guard` object holds the thresholds behind every behaviour. Any key you omit takes its default, so a later version's new defaults reach an existing profile. Times are in milliseconds.

Settings marked with a command can be changed from the prompt. Everything else is edited in the file.

### Switches

| Key | Default | Command | Meaning |
|---|---|---|---|
| `enabled` | `true` | `guard on`, `guard off` | The whole system. |
| `muted` | `[]` | `guard mute`, `guard unmute` | Behaviour ids that are not checked at all. |
| `severity` | `{}` | `guard severity` | Per-behaviour override: `{"loss-streak": "block"}`. |
| `autoExit` | `[]` | `guard autoexit` | Behaviours on which Tame may close a position by itself. |
| `coachRemarks` | `false` | none | Whether the coach may add an unprompted sentence when a hold-level condition appears. |
| `dailyLossLimit` | unset | `guard limit` | Realized loss at which entries are refused. The only setting that blocks. |
| `lockoutMs` | `1800000` (30 min) | none | How long a lockout lasts. |

### Tilt thresholds

| Key | Default | Behaviour | Meaning |
|---|---|---|---|
| `revengeWindowMs` | `300000` (5 min) | `revenge-entry` | An entry this soon after a losing exit is a revenge entry. |
| `revengeMinLoss` | `0` | `revenge-entry` | A loss smaller than this does not arm the window. |
| `rapidFireWindowMs` | `600000` (10 min) | `rapid-fire` | Window over which entries are counted. |
| `rapidFireCount` | `4` | `rapid-fire` | Entries in that window before it fires. |
| `sizeEscalationFactor` | `1.75` | `size-escalation` | Multiple of the session's median entry size. |
| `sizeEscalationMinLoss` | `0` | `size-escalation` | How far down the session must be. |
| `chaseMovePercent` | `1.5` | `chasing` | Move in the entry's direction that makes it a chase. |
| `chaseWindowMs` | `300000` (5 min) | `chasing` | Window over which that move is measured. |
| `flipWindowMs` | `900000` (15 min) | `direction-flipping` | Window for counting reversals. |
| `flipCount` | `3` | `direction-flipping` | Reversals before it fires. |
| `churnRatio` | `4` | `order-churn` | Cancels per fill. |
| `churnMinOrders` | `8` | `order-churn` | Below this many orders the ratio is noise. |

### Risk thresholds

| Key | Default | Behaviour | Meaning |
|---|---|---|---|
| `stopGraceMs` | `180000` (3 min) | `no-stop` | How long a position may sit without a stop. |
| `recentEventWindowMs` | `600000` (10 min) | `stop-widened`, `stop-removed` | How far back a stop change still counts as recent. |
| `maxRiskPercentOfEquity` | `1` | `risk-per-trade` | Planned downside ceiling as a percentage of equity. |
| `maxLeverage` | `10` | `leverage-creep` | Notional divided by equity. |

### Discipline thresholds

| Key | Default | Behaviour | Meaning |
|---|---|---|---|
| `maxConsecutiveLosses` | `3` | `loss-streak` | Losing round trips in a row. |
| `maxTradesPerSession` | `20` | `overtrading` | Round trips in the session. |
| `givebackPercent` | `40` | `profit-giveback` | Fall from peak equity as a percentage of the session's peak profit. |
| `maxSessionMs` | `14400000` (4 h) | `session-length` | Time since the session's first event. |

### Validation

A value of the wrong type falls back to its default rather than disabling the check: a non-finite number, a `severity` that is not an object, a `muted` or `autoExit` that is not an array. `dailyLossLimit` is the exception in the other direction: only a positive finite number counts as set. `enabled` is true unless it is exactly `false`.

> **Note**
> Changing any setting from the `guard` command currently writes the fully resolved policy back to the file, not just the keys you changed. After that, a future version's new defaults will not apply until you remove the frozen keys. Tracked in [Known gaps](../development.md#known-gaps).

## Environment variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Fallback coach key. A key stored in the profile always takes precedence. |
| `NODE_ENV` | `development` enables the dev-mode restart path and state file. Set by `yarn dev`. |
| `SKIP_PASSWORD_AUTH` | `true` bypasses password creation and verification. Set by `yarn dev:np`. Has no effect on `yarn start`. |
| `TERM`, `LANG`, `LC_ALL`, `LC_CTYPE` | Box-drawing characters are used only when `TERM` is set and not `dumb` and one locale variable contains `UTF-8`. |

## Permissions

`~/.tame/` is created with mode `0700` and every file in it with `0600`. Existing files are repaired to those modes on each save, because a file created by an older version may have been world-readable. On filesystems that cannot express modes, the chmod failure is ignored and the file is still written.

## Related

- [Getting started](../getting-started.md)
- [Guardrails](../guardrails.md)
- [Records on disk](records.md)
