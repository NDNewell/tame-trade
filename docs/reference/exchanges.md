# Exchanges

Tame talks to exchanges through ccxt. This page lists what is actually supported, what credentials each venue needs, and the per-exchange behaviour that affects how orders are placed.

**On this page**

- [Support levels](#support-levels)
- [Credentials](#credentials)
- [Connection settings](#connection-settings)
- [Symbols](#symbols)
- [Phemex](#phemex)
- [Hyperliquid](#hyperliquid)
- [Deribit](#deribit)

## Support levels

| Exchange | Level | Notes |
|---|---|---|
| Phemex | **Primary.** Built and tested against it. | Everything on this page applies. |
| Hyperliquid | Wired. | Private-key auth, emulated market orders, symbol lookup across spellings. Less exercised. |
| Deribit | Wired. | Stop-order parameters are defined. Least exercised. |
| Everything else | Listed but not supported. | The picker shows every ccxt Pro exchange with WebSocket support. Connecting may work; placing a stop will fail because Tame has no stop-order parameters for that venue. |

## Credentials

| Exchange | Prompts | Permissions |
|---|---|---|
| Phemex, Deribit, others | API key, secret | Read, trading, futures. A spot-only key fails when markets load, because Tame connects with the futures default type. |
| Hyperliquid | Private key, API wallet address, public wallet address | The public wallet is used for reads (positions, orders); the private key signs. |

Credentials are stored in plain text in `~/.tame/config.json`, mode `0600`. See [Configuration](configuration.md).

## Connection settings

Applied to every exchange:

- **Rate limiting on.** ccxt's built-in limiter is enabled, and Tame's own refresh, sweep, and candle passes are each one-at-a-time with a deadline, so a slow venue never gets a queue of duplicate requests.
- **IPv4 forced.** On networks without working IPv6 (most VPNs), the AAAA lookup for the exchange API goes unanswered and stalls around twelve seconds, longer than ccxt's ten-second timeout. Forcing IPv4 avoids the stall.
- **Default type `future`.** Markets, positions, and orders are resolved as derivatives.
- **Clock adjustment on.** ccxt adjusts for the difference between the host clock and the exchange's.

## Symbols

Tame uses ccxt's unified symbol format and requires an exact, case-sensitive match:

| Form | Example | Meaning |
|---|---|---|
| `BASE/QUOTE:SETTLE` | `SOL/USDT:USDT` | Linear perpetual settled in USDT |
| `BASE/QUOTE:BASE` | `BTC/USD:BTC` | Inverse perpetual settled in the base |
| `BASE/QUOTE` | `BTC/USDT` | Spot |

`list markets` shows the exact strings for the connected venue.

## Phemex

**Stops.** A stop is sent as a market order carrying a trigger price. ccxt turns that into the right Phemex order type: a Stop when the trigger is on the losing side of the market and a MarketIfTouched when it is not. Tame sets:

| Parameter | Value | Why |
|---|---|---|
| `closeOnTrigger` | `true` | Phemex rejects `reduceOnly` on conditional orders. `closeOnTrigger` is the conditional-order equivalent and stops a stop from opening an opposite position. |
| `triggerType` | `ByLastPrice` | Matches what the Phemex interface creates. ccxt's default is mark price. |
| `triggerDirection` | `up` or `down` | Derived from where the trigger sits relative to the market. |
| Quantity `0` | Whole position | When you gave no size, Phemex reads a zero-quantity stop as "whatever the position is when this fires". The panel shows `ALL`. |

**Trails.** A fixed trail is a pegged order: `pegPriceType: TrailingStopPeg` with an offset whose sign follows the position, triggered `ByMarkPrice`. A peg sent without a trigger price becomes a plain market order and closes the position immediately, so Tame always sends both.

**Position figures.** ccxt's unrealized PnL for Phemex is not usable, so Tame re-derives it from entry and the position's own mark. Realized PnL is read from Phemex's raw fields (`curTermRealisedPnlRv`, or the `Ev` form scaled by 1e8 on inverse markets). Effective leverage is derived because Phemex reports only the configured leverage.

**Candles.** The kline endpoint accepts only the limits 5, 10, 50, 100, 500, and 1000. Tame snaps every candle request to one of those.

**Balance.** The balance call rejects the `future` type and accepts only `spot` or `swap`, so Tame passes `swap` explicitly.

## Hyperliquid

- Every position, order, and cancel call carries `user: <publicAddress>`.
- A market order is emulated as a limit five percent through the touch, which is how the venue expresses one.
- Position lookup tries five spellings of the symbol, because Hyperliquid's own format differs from ccxt's: `SOL`, `SOL/USDC:USDC`, `SOL-USD`, `SOL/USD`, `SOLUSD`.
- Stops are sent as market orders with a trigger price and an explicit `reduceOnly: true`; the trigger uses the last price.
- Chase orders use `timeInForce: Alo` (add-liquidity-only) rather than a post-only flag, and re-price no faster than every 1.5 seconds.
- `move stop` is a cancel-and-replace on this venue.

## Deribit

Stops are `stop_market` orders with the trigger under `stopLossPrice` and `reduce_only: true`. Deribit was Tame's original venue; it is the least exercised of the three today.

## Related

- [Placing and managing orders](../orders.md)
- [Configuration](configuration.md)
- [Troubleshooting](../troubleshooting.md)
