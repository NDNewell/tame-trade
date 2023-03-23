# Tame

Tame is a Node.js and TypeScript trading app that communicates with Deribit's API. It provides a terminal-based client interface for users to input basic string commands, such as `limit buy .01`. The app also supports alias functionality, which allows users to create custom shortcuts for core commands.

## Installation

Clone this repository.
Run `yarn install` to install the required dependencies.
Run `yarn build` to compile the TypeScript code.
Usage
Run `yarn start` to start the application. Follow the prompts to enter your API keys with trading, futures, and read permissions enabled. The API keys and configuration data will be stored locally in the `.tame/config.json` file located in your home directory.

### Fatfinger

Set a fatfinger value (maximum individual order size) by typing fatfinger followed by the amount. For example:

`fatfinger 10`

This command sets the maximum individual order size to 10 BTC.

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

`instrument [symbol]`: Switch to another instrument (e.g., instrument btc-perp or instrument eth-perp).

`buy [size] @ [price]`: Place a limit buy order (e.g., buy 0.001 @ 9000).

`sell [size] @ [price]`: Place a limit sell order (e.g., sell 0.001 @ 9000).

`stop [price]`: Place a stop loss order (e.g., stop 15000).

`trigger buy [size] [price] or trigger sell [size] [price]`: Place a non-reduce-only stop order.

`bump + [value] or bump - [value]`: Bump all orders by the specified value.

`cancel all`: Cancel all resting orders, including stops.

`cancel limits`: Cancel all resting orders, excluding stops.

`cancel stops`: Cancel stop loss, take profit, and trailing stop orders.

`cancel buys`: Cancel buy orders.

`cancel sells`: Cancel sell orders.

`logout`: Delete stored API credentials from the tame-config-db.json file.

`q`: Quit the application.

## License

Tame is released under the MIT License.
