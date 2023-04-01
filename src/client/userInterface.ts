// src/client/userInterface.ts

import inquirer from 'inquirer';
import autocomplete from 'inquirer-autocomplete-prompt';
import clear from 'console-clear';
import { formatOutput as fo } from '../utils/formatOutput';
import { ExchangeProfile } from '../config/configManager';
import { ExchangeCommand, OrderType } from '../commands/exchangeCommand';

export class UserInterface {
  private currentMarket: string;
  private availableMarkets: string[];
  private exchangeCommand: ExchangeCommand;

  constructor() {
    this.exchangeCommand = new ExchangeCommand();
    this.currentMarket = '';
    this.availableMarkets = [];
    inquirer.registerPrompt('autocomplete', autocomplete);
  }

  async displayWelcomeScreen(): Promise<void> {
    console.log(`${fo('Welcome to Tame!', 'yellow', 'bold')}`);
    console.log(
      `${fo(
        "In trading, speed, execution, and emotional control are crucial to success. With Tame, you'll be able to access powerful trading commands and custom shortcuts that will allow you to execute trades faster and more efficiently.\n\nOur emotions can often get in the way of rational decision-making, which is why Tame has guardrails to help you stay on track and avoid impulsive trades. Tame will hopefully teach you how to recognize and regulate your emotions, so you can make sound trading decisions while also maximizing your gains.\n\nNow, go be a ruthless predator, and trade with speed, precision, and confidence!",
        'yellow'
      )}`
    );
  }

  async displayHomeScreen(): Promise<string> {
    const menuChoices = [
      { name: 'Start Trading', value: 'startTrading' },
      { name: 'Add Exchange', value: 'addExchange' },
      { name: 'Remove Exchange', value: 'removeExchange' },
      { name: 'Delete Profile', value: 'deleteProfile' },
      { name: 'Quit', value: 'quit' },
    ];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Choose an action:',
        choices: menuChoices,
      },
    ]);

    clear();

    return action;
  }

  async createProfile(): Promise<string> {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Choose an action:',
        choices: [
          { name: 'Continue', value: 'continue' },
          { name: 'Quit', value: 'quit' },
        ],
      },
    ]);

    clear();

    return action;
  }

  async removeExchange(profile: any): Promise<string> {
    const { exchange } = await inquirer.prompt([
      {
        type: 'list',
        name: 'exchange',
        message: 'Choose an exchange to remove:',
        choices: profile.exchanges.map(
          (exchangeProfile: ExchangeProfile) => exchangeProfile.exchange
        ),
      },
    ]);

    clear();

    return exchange;
  }

  async selectExchange(supportedExchanges: any): Promise<string> {
    async function searchExchanges(
      answers: Record<string, unknown>,
      input: string | null
    ) {
      input = input || '';
      return supportedExchanges.filter((exchange: string) =>
        exchange.toLowerCase().includes(input!.toLowerCase())
      );
    }

    const { exchange } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'exchange',
        message: 'Choose an exchange:',
        source: searchExchanges,
      },
    ]);

    clear();

    return exchange;
  }

  async addExchangeCredentials(credential: string): Promise<any> {
    let message;

    if (credential === 'key') {
      message = 'Enter your API Key:';
    } else if (credential === 'secret') {
      message = 'Enter your Secret';
    }

    const { [credential]: enteredCred } = await inquirer.prompt([
      {
        type: 'input',
        name: credential,
        message: message,
      },
    ]);

    clear();

    return enteredCred;
  }

  async startTradingInterface(): Promise<void> {
    this.availableMarkets =
      (await this.exchangeCommand.getExchangeClient().getMarketSymbols()) || [];

    this.promptForCommand();
  }

  private async promptForCommand() {
    const exchangeClient = this.exchangeCommand.getExchangeClient();
    const exchangeName = exchangeClient.getSelectedExchangeName();
    const tameDisplay = `<${fo('Tame', 'yellow', 'italic')}>`;
    const marketDisplay = `<${fo(`${this.currentMarket}`, 'green', 'italic')}>`;
    const exchangeDisplay = exchangeName
      ? `<${fo(exchangeName, 'orange', 'italic')}>`
      : '';

    const promptMessage = this.currentMarket
      ? `${tameDisplay}${exchangeDisplay}${marketDisplay} `
      : `${tameDisplay}${exchangeDisplay} `;

    const { command } = await inquirer.prompt({
      type: 'input',
      name: 'command',
      message: promptMessage,
      prefix: '',
    });

    this.handleCommand(command.trim());
  }

  private async handleCommand(command: string) {
    if (command === 'list methods') {
      this.displayAvailableMethods();
    } else if (command.startsWith('market')) {
      const market = command.split(' ')[1];
      if (this.availableMarkets.includes(market)) {
        this.currentMarket = market;
        console.log(`Switched to market: ${market}`);
      } else {
        console.log(`Invalid market: ${market}`);
      }
    } else if (command.startsWith('watch')) {
      const commandParts = command.split(' ');

      if (commandParts.length === 3 && commandParts[2] === 'orderbook') {
        const market = commandParts[1];

        if (this.availableMarkets.includes(market)) {
          try {
            await this.exchangeCommand
              .getExchangeClient()
              .watchOrderBook(market);
          } catch (error: unknown) {
            console.log((error as Error).message);
          }
        } else {
          console.log(`Invalid market: ${market}`);
        }
      } else {
        console.log('Invalid command format. Usage: watch [symbol] orderbook');
      }
    } else if (command === 'list markets') {
      const marketType = await this.selectMarketType();
      this.currentMarket = await this.selectMarketByType(marketType);
    } else if (command === 'quit' || command === 'q') {
      this.quit();
    } else if (command === 'cancel all') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllOrders(this.currentMarket);
          console.log('All orders cancelled for market:', this.currentMarket);
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel limits') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllLimitOrders(this.currentMarket);
          console.log('All limit orders have been cancelled.');
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'close position') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .closePosition(this.currentMarket);
          console.log('Position closed');
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel stops') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllStopOrders(this.currentMarket);
          console.log('All stop orders have been cancelled.');
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command.startsWith('bump')) {
      const bumpRegex = /^bump\s+([-+]?\d*\.?\d+)/;
      const match = command.match(bumpRegex);
      if (match) {
        const priceChange = parseFloat(match[1]);
        if (this.currentMarket) {
          try {
            await this.exchangeCommand
              .getExchangeClient()
              .bumpOrders(this.currentMarket, priceChange);
            console.log(`All orders have been bumped by ${priceChange}.`);
          } catch (error: unknown) {
            console.log((error as Error).message);
          }
        } else {
          console.log('No market selected. Please select a market first.');
        }
      } else {
        console.log(
          'Invalid bump command format. Use "bump + [value]" or "bump - [value]".'
        );
      }
    } else if (command.startsWith('print')) {
      if (command.includes('possize')) {
        const positionSize = await this.exchangeCommand
          .getExchangeClient()
          .getPositionSize(this.currentMarket);
        console.log(positionSize);
      }
    } else {
      if (this.currentMarket) {
        try {
          const commandParams = await OrderType.parseCommand(command);
          if (commandParams !== null) {
            const { type, quantity, price } = commandParams;

            if (
              type === OrderType.MARKET_BUY ||
              type === OrderType.MARKET_SELL
            ) {
              await this.exchangeCommand.execute(type, this.currentMarket, {
                quantity: Number(quantity),
              });
            } else if (
              type === OrderType.STOP ||
              type === OrderType.LIMIT_BUY ||
              type === OrderType.LIMIT_SELL
            ) {
              await this.exchangeCommand.execute(type, this.currentMarket, {
                price: Number(price),
                ...(quantity !== undefined
                  ? { quantity: Number(quantity) }
                  : {}),
              });
            }
          }
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    }
    this.promptForCommand();
  }

  private async selectMarketType(): Promise<string | undefined> {
    const availableTypes = await this.exchangeCommand
      .getExchangeClient()
      .getMarketTypes();

    const { marketType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'marketType',
        message: 'Select market type:',
        choices: [
          ...Array.from(availableTypes),
          { name: 'Back', value: 'back' },
        ],
      },
    ]);

    clear();

    if (marketType === 'back') {
      return;
    } else {
      return marketType;
    }
  }

  private async selectMarketByType(
    marketType: string | undefined
  ): Promise<string> {
    if (marketType === undefined) {
      return 'back';
    }

    const marketsByType = await this.exchangeCommand
      .getExchangeClient()
      .getMarketByType(marketType);

    async function searchMarkets(
      answers: Record<string, unknown>,
      input: string | null
    ) {
      input = input || '';
      return marketsByType.filter((market) =>
        market.toLowerCase().includes(input!.toLowerCase())
      );
    }

    const { market } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'market',
        message: 'Select market:',
        source: searchMarkets,
      },
    ]);

    clear();

    return market;
  }

  public async displayAvailableMethods(): Promise<void> {
    const methods = this.exchangeCommand.getAvailableMethods();
    Object.keys(methods)
      .sort()
      .forEach((key) => {
        const temp = methods[key];
        delete methods[key];
        methods[key] = temp;
      });
    console.log('Available methods:');
    for (const [method, availability] of Object.entries(methods)) {
      if (availability) {
        console.log(`- ${method}`);
      }
    }
  }

  quit() {
    console.log('Exiting...');
    process.exit(0);
  }
}
