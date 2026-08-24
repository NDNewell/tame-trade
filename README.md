# Tame

Tame is a Node.js and TypeScript trading app that communicates with Deribit's API. It provides a terminal-based client interface for users to input basic string commands, such as `limit buy .01`. The app also supports alias functionality, which allows users to create custom shortcuts for core commands.

## Installation

Clone this repository.
Run `yarn install` to install the required dependencies.
Run `yarn build` to compile the TypeScript code.
Usage
Run `yarn start` to start the application. Follow the prompts to enter your API keys with trading, futures, and read permissions enabled. The API keys and configuration data will be stored locally in the `.tame/config.json` file located in your home directory.

### Development Mode

For development with hot-reload capability, use:

`yarn dev`

This starts the application in development mode with file watching. The app will automatically restart whenever you make changes to any `.ts`, `.js`, or `.json` files in the source directory. The watcher includes a 1-second debounce to prevent multiple rapid restarts when saving multiple files.

For faster development without password authentication:

`yarn dev:np`

This runs the app in development mode while skipping the password verification step.

Development mode features:
- Automatic restart when files change, with debounce to prevent rapid restarts
- State preservation between restarts (preserves current exchange and market)
- Password authentication can be skipped with the `-np` flag
- Clear indication when running in development mode

### Fatfinger

The fatfinger limit caps how much a single order may be **worth**, so one number
means the same thing on every market. Set it by typing `fatfinger` followed by an
amount:

`fatfinger 5000`

No single order may exceed 5000 in the market's quote currency. On `BTC/USD:BTC`
that is 5000 USD; on `BTC/USDT:USDT` it is 5000 USDT, or about 0.065 BTC at a
price of 77,000.

An order's value is its size multiplied by its price. Limit and stop orders are
valued at the price you gave; market orders are valued at the last traded price.
On inverse contracts, where each contract is already worth one unit of the quote
currency, the size is the value.

- `fatfinger` — show the current limit
- `fatfinger 5000` — set the limit
- `fatfinger off` — remove the limit

The limit is saved to your profile and applies across sessions. It is **not** set
by default; when no limit is set, Tame says so on startup.

Orders are rejected before being sent to the exchange, and the rejection tells you
what the order was worth. Sizes that Tame works out from your own position —
closing a position, or a stop sized to cover one — are not subject to the limit,
so a protective order can always be placed.

### Aliases

Aliases are custom shortcuts that can be created for one or multiple core commands. To create an alias, edit the initrun.txt file located in the application's root directory or create it if it doesn't exist.

Alias example:

```
{
"b": "limit buy 0.01",
"s": "limit sell 0.01"
}`
```

With this alias configuration, typing b in the terminal will execute the limit buy 0.01 command, and typing s will execute the limit sell 0.01 command.

### General Commands

`market [symbol]`: Switch to another market (e.g., market btc-perp or market eth-perp).

`buy [size] @ [price]`: Place a limit buy order (e.g., buy 0.001 @ 9000).

`sell [size] @ [price]`: Place a limit sell order (e.g., sell 0.001 @ 9000).

`stop [price] [size]`: Place a stop loss order. **The price always comes first.**
`stop 15000` places a stop at 15000 sized to cover your position; `stop 15000 0.5`
places one at 15000 for a size of 0.5.

A stop price far from the current market is rejected rather than placed, because
it almost always means the price and size were entered the wrong way round.

Stops are sent reduce-only and trigger on the last traded price, matching what the
exchange UI creates. Being reduce-only, a stop can only close what you hold — it
can never open a position in the opposite direction.

`trigger buy [size] [price] or trigger sell [size] [price]`: Place a non-reduce-only stop order.

`trail [distance]` / `trail [percent]%`: Place a trailing stop covering the whole
position. `trail 1.5` trails 1.50 behind the best price; `trail 2%` trails 2%.
The stop starts one trail-width away from the current price.

The exchange maintains the trail, not Tame, so it keeps working whether or not
this application is running. That is deliberate: a trail maintained locally would
freeze wherever it happened to be if the process stopped, while still looking
like it was following the price.

Trails follow the **mark price** rather than the last traded price. Last price is
what a wick moves: a spike on this venue ratchets the trail up behind it, and
when price returns the stop is left near the market and closes the position on a
move that never really happened. Mark price comes from the index, so a wick that
does not move the wider market barely moves the trail. Fixed stops still trigger
on last price, matching the exchange UI.

`bump + [value] or bump - [value]`: Bump all orders by the specified value.

`cancel all`: Cancel all resting orders, including stops.

`cancel limits`: Cancel all resting orders, excluding stops.

`cancel stops`: Cancel stop loss, take profit, and trailing stop orders.

`cancel buys`: Cancel buy orders.

`cancel sells`: Cancel sell orders.

`logout`: Delete stored API credentials from the tame-config-db.json file.

`q`: Quit the application.

## Cancel Specific Orders by Range

You can cancel a range of orders based on their position in the order
book:

```
cancel orders top 5
```
Cancels the top 5 orders from the order book.

```
cancel orders bottom 5
```
Cancels the bottom 5 orders from the order book.

## Cancel Orders by Specific Range

To cancel orders within a specific price range:

```
cancel orders top 3:5
```
Cancels orders from top positions 3 to 5 in the order book.

```
cancel orders bottom 2:4
```
Cancels orders from bottom positions 2 to 4 in the order book.

## Cancel Orders by Specific Index

To cancel a specific order by its index in the order book, you can use
the same command without the colon:

```
cancel orders top 3
```
Cancels the third order from the top of the order book.

```
cancel orders bottom 1
```
Cancels the very first order from the bottom of the order book.

Remember that these commands are context-sensitive and apply to the
orders of the market that is currently selected within the client
session.

Please ensure that you have selected the appropriate market when using
these commands to cancel limit orders.
```

## License

Tame is released under the MIT License.
