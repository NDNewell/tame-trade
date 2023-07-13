// src/client/userInterface.ts

import inquirer from 'inquirer';
import InquirerExpanded from '../../plugins/inquirer-expanded';

import autocomplete from 'inquirer-autocomplete-prompt';
import clear from 'console-clear';
import { formatOutput as fo } from '../utils/formatOutput';
import { ExchangeProfile } from '../config/configManager';
import { ExchangeCommand, OrderType } from '../commands/exchangeCommand';

export class UserInterface {
  private currentMarket: string;
  private availableMarkets: string[];
  private exchangeCommand: ExchangeCommand;
  private chaseOrderId: string | undefined;

  constructor() {
    this.exchangeCommand = new ExchangeCommand();
    this.currentMarket = '';
    this.availableMarkets = [];
    this.chaseOrderId = '';
    inquirer.registerPrompt('autocomplete', autocomplete);
    inquirer.registerPrompt('inquirer-expanded', InquirerExpanded);
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
    const tameDisplay = `[${fo('Tame', 'yellow')}]`;
    const marketDisplay = `[${fo(`${this.currentMarket}`, 'green')}]`;
    const exchangeDisplay = exchangeName
      ? `[${fo(exchangeName, 'orange')}]`
      : '';

    const promptMessage = this.currentMarket
      ? `${marketDisplay} `
      : `${tameDisplay}${exchangeDisplay} `;

    const { command } = await inquirer.prompt<{ command: string }>([
      {
        type: 'inquirer-expanded' as any, // Update the type to use the new plugin and bypass type checking
        name: 'command',
        message: promptMessage,
        prefix: '',
      },
    ]);

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
    } else if (command === 'get market structure') {
      if (this.currentMarket.length > 0) {
        this.exchangeCommand
          .getExchangeClient()
          .getMarketStructure(this.currentMarket);
      } else {
        console.log('No market selected. Please select a market first.');
      }
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
    } else if (command.startsWith('cancel orders')) {
      const regex = /^cancel orders\s*(top|bottom)?\s*(\d+)?(\:)?(\d+)?$/;
      const match = command.match(regex);
      if (match) {
        const [, direction, rangeStartStr, colon, rangeEndStr] = match;
        let rangeStart: number | undefined;
        let rangeEnd: number | undefined;

        if (rangeStartStr !== undefined) {
          rangeStart = parseInt(rangeStartStr, 10);
          if (colon !== undefined && rangeEndStr !== undefined) {
            rangeEnd = parseInt(rangeEndStr, 10);
          } else {
            rangeEnd = rangeStart;
          }
        }

        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelOrdersByDirection(
              this.currentMarket,
              direction || 'top',
              rangeStart,
              rangeEnd
            );
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log(
          'Invalid command format. Usage: cancel orders [top | bottom] [start:end | specific order]'
        );
      }
    } else if (
      command.startsWith('range buy') ||
      command.startsWith('range sell')
    ) {
      const commandParts = command.split(' ');
      const action = commandParts[1];
      const market = this.currentMarket;
      const questions = [
        {
          type: 'number',
          name: 'startPrice',
          message: 'Enter the start price:',
        },
        {
          type: 'number',
          name: 'endPrice',
          message: 'Enter the end price:',
        },
        {
          type: 'number',
          name: 'numOrders',
          message: 'Enter the number of orders:',
        },
        {
          type: 'number',
          name: 'totalRiskPercentage',
          message: 'Enter the total risk percentage:',
        },
        {
          type: 'number',
          name: 'stopPrice',
          message: 'Enter the stop price:',
        },
        {
          type: 'number',
          name: 'takeProfitPrice',
          message: 'Enter the take profit price:',
        },
        {
          type: 'number',
          name: 'totalCapitalToRisk',
          message: 'Enter the total capital to risk:',
        },
        {
          type: 'number',
          name: 'riskReturnRatioThreshold',
          message: 'Enter the risk-return ratio threshold:',
        },
      ];

      const answers = await inquirer.prompt(questions);

      if (
        market &&
        answers.startPrice &&
        answers.endPrice &&
        answers.numOrders &&
        answers.totalRiskPercentage &&
        answers.stopPrice &&
        answers.takeProfitPrice &&
        answers.totalCapitalToRisk &&
        answers.riskReturnRatioThreshold
      ) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .submitRangeOrders(
              action,
              market,
              answers.startPrice,
              answers.endPrice,
              answers.numOrders,
              answers.totalRiskPercentage,
              answers.stopPrice,
              answers.takeProfitPrice,
              answers.totalCapitalToRisk,
              answers.riskReturnRatioThreshold
            );
          console.log(
            `Range ${action} orders placed between ${answers.startPrice} and ${answers.endPrice}`
          );
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log(
          'Invalid range command format. Usage: range [buy/sell] [startPrice] [endPrice] [numOrders] [risk%] [stopPrice] [takeProfitPrice] [totalCapitalToRisk] [riskReturnRatioThreshold]'
        );
      }
    } else if (
      command.startsWith('chase buy') ||
      command.startsWith('chase sell')
    ) {
      const commandParts = command.split(' ');
      const action = commandParts[1];
      const market = this.currentMarket;
      const amount = parseFloat(commandParts[2]);
      const decay = commandParts[3] ? commandParts[3] : undefined;

      if (
        !this.exchangeCommand.getExchangeClient().getChaseLimitOrderStatus()
      ) {
        if (market && amount) {
          try {
            const orderId = await this.exchangeCommand
              .getExchangeClient()
              .chaseLimitOrder(market, action, amount, decay);
            if (orderId) {
              this.chaseOrderId = orderId;
            } else {
              throw new Error('orderId is undefined');
            }
          } catch (error: unknown) {
            console.log((error as Error).message);
          }
        } else {
          console.log(
            'Invalid chase command format. Usage: chase [buy/sell] [amount]'
          );
        }
      } else {
        console.log('Chase order already active.');
      }
    } else if (command.startsWith('cancel chase')) {
      if (
        this.chaseOrderId !== undefined &&
        this.exchangeCommand.getExchangeClient().getChaseLimitOrderStatus()
      ) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelChaseOrder(this.chaseOrderId, this.currentMarket);
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
        this.chaseOrderId = '';
      } else {
        console.log('No chase orders active.');
      }
    } else if (
      command.startsWith('bracket buy') ||
      command.startsWith('bracket sell')
    ) {
      const side = command.split(' ')[1];
      const entryPrice = parseFloat(command.split(' ')[2]);
      const stopPrice = parseFloat(command.split(' ')[3]);

      const questions = [
        {
          type: 'number',
          name: 'capitalToRisk',
          message: 'Enter the amount of capital you want to risk:',
        },
        {
          type: 'number',
          name: 'riskPercentage',
          message: 'Enter the percentage of capital you want to risk:',
        },
      ];

      const answers = await inquirer.prompt(questions);

      if (
        answers.capitalToRisk &&
        answers.riskPercentage &&
        stopPrice &&
        entryPrice
      ) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .createBracketLimitOrder(
              this.currentMarket,
              side,
              answers.capitalToRisk,
              answers.riskPercentage,
              stopPrice,
              entryPrice
            );
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log('Invalid bracket command format. Please try again.');
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
