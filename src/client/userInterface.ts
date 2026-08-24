// src/client/userInterface.ts

import inquirer from 'inquirer';

import autocomplete from 'inquirer-autocomplete-prompt';
import clear from 'console-clear';
import { formatOutput as fo } from '../utils/formatOutput.js';
import { ExchangeProfile } from '../config/configManager.js';
import { ExchangeCommand, OrderType } from '../commands/exchangeCommand.js';
import { StateManager } from '../config/stateManager.js';
import { NotificationManager, NType } from '../utils/notificationManager.js';
import { describeExchangeError } from '../utils/exchangeErrors.js';
import { Workspace } from '../ui/workspace.js';
import { ActivityLog } from '../ui/activityLog.js';
import { releaseInstanceLock } from '../config/instanceLock.js';

export class UserInterface {
  private currentMarket: string;
  private availableMarkets: string[];
  private exchangeCommand: ExchangeCommand;
  private chaseOrderId: string | undefined;
  private lastPositionSize: number | null = null;
  private entryPrice: number | null = null;
  private stateManager: StateManager;
  private isDevMode: boolean;
  private workspace: Workspace | null = null;

  constructor() {
    this.exchangeCommand = new ExchangeCommand();
    this.currentMarket = '';
    this.availableMarkets = [];
    this.chaseOrderId = '';
    this.stateManager = StateManager.getInstance();
    this.isDevMode = process.env.NODE_ENV === 'development';
    inquirer.registerPrompt('autocomplete', autocomplete);
  }

  // Save current application state for dev mode
  private async saveDevState(): Promise<void> {
    if (this.isDevMode) {
      const currentExchange = this.exchangeCommand.getExchangeClient().getSelectedExchangeName();
      await this.stateManager.saveState({
        currentExchange: currentExchange || undefined,
        currentMarket: this.currentMarket || undefined,
        isDevMode: true,
        isReload: true // Mark that next start will be a reload
      });
    }
  }

  async displayWelcomeScreen(): Promise<void> {
    console.log(`${fo('Welcome to Tame!', 'yellow', 'bold')}`);
    console.log(
      `${fo(
        "Tame helps you trade faster and more efficiently with powerful commands and shortcuts. The built-in guardrails prevent impulsive trades and help you stay focused.\n\nTrade with speed, precision, and confidence!",
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

  async addExchangeCredentials(credential: string, exchangeName?: string): Promise<any> {
    let message;

    // Special handling for Hyperliquid
    if (exchangeName?.toLowerCase() === 'hyperliquid') {
      if (credential === 'privateKey') {
        message = 'Enter your Private Key:';
      } else if (credential === 'walletAddress') {
        message = 'Enter your API Wallet Address:';
      } else if (credential === 'publicAddress') {
        message = 'Enter your Public Wallet Address for queries (needed to view your positions):';
      } else {
        // Skip other credential types for Hyperliquid
        return '';
      }
    } else {
      // Standard handling for other exchanges
      if (credential === 'key') {
        message = 'Enter your API Key:';
      } else if (credential === 'secret') {
        message = 'Enter your Secret:';
      }
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

    const fatFingerLimit = this.exchangeCommand
      .getExchangeClient()
      .getFatFingerLimit();

    console.log(
      fatFingerLimit === undefined
        ? fo(
            'No fatfinger limit set — order value is unlimited. Set one with "fatfinger <amount>".',
            'yellow'
          )
        : `Fatfinger limit: ${fatFingerLimit} per order.`
    );

    // Load saved state if in dev mode and this is a reload
    if (this.isDevMode) {
      const state = await this.stateManager.loadState();
      if (state.isDevMode && state.isReload && state.currentMarket &&
          this.availableMarkets.includes(state.currentMarket)) {
        this.currentMarket = state.currentMarket;
        this.exchangeCommand.getExchangeClient().followMarket(this.currentMarket);
        console.log(`[Dev] Restored previous market: ${this.currentMarket}`);

        // Reset the reload flag for next time
        await this.stateManager.saveState({
          ...state,
          isReload: false
        });
      }
    }

    // The workspace owns the terminal from here: one repainted view rather than
    // a scrolling console, with the command line docked.
    this.workspace = new Workspace(
      this.exchangeCommand.getExchangeClient(),
      async (command: string) => {
        await this.handleCommand(command.trim());
      },
      () => this.quit()
    );

    if (this.currentMarket) {
      this.workspace.start(this.currentMarket);
    } else {
      this.workspace.start('');
    }
  }

  private async formatPriceToMarketPrecision(price: number, market: string): Promise<number> {
      try {
          const precision = await this.exchangeCommand.getExchangeClient().getMarketPrecision(market);
          const decimalPlaces = precision.toString().split('.')[1].length;
          const updatedPrice = price.toFixed(decimalPlaces);
          return Number(updatedPrice);
      } catch (error) {
          console.error('Failed to format price to market precision:', error);
          return price
      }
  }

  private processPositionSize(command: string, lastPositionSize: number): string {
    let modifiedCommand = command;

    const percentModifierMatch = command.match(/(\d+)%possize/);
    if (percentModifierMatch) {
      const percentModifier = Number(percentModifierMatch[1]) / 100;
      const adjustedPositionSize = lastPositionSize * percentModifier;
      modifiedCommand = command.replace(/(\d+)%possize/g, adjustedPositionSize.toString());
    } else if (command.includes("possize")) {
      modifiedCommand = command.replace(/possize/g, lastPositionSize.toString());
    }

    return modifiedCommand;
  }

  private replaceCommandVariable(command: string, value: number, variable: string): string {
    command = command.replace(variable, value.toString());
    console.log(command);
    return command;
  }

  // fatfinger             show the current limit
  // fatfinger <amount>    set the most a single order may be worth
  // fatfinger off         remove the limit
  /**
   * Reports a failed command by its meaning, keeping the exchange's own
   * response as a diagnostic. A raw payload in the activity feed breaks the row
   * structure and answers a question the trader wasn't asking.
   */
  private reportFailure(error: unknown): void {
    const failure = describeExchangeError(error);
    NotificationManager.diagnostic(`[command] ${failure.raw}`);
    NotificationManager.notify(failure.summary, NType.ERROR, 'ERROR');
  }

  // trail <distance>   trail that many in price behind the best price
  // trail <percent>%    trail that percentage behind
  //
  // Covers the whole position, like a stop, and is maintained by the exchange
  // rather than by this process.
  /**
   * Reports what a cancel actually did.
   *
   * These used to announce success unconditionally, so a filter that matched
   * nothing and a cancel that was refused both read as 'all orders cancelled'.
   */
  private reportCancelled(
    noun: string,
    result: { cancelled: number; failed: number }
  ): void {
    const count = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;

    if (result.failed > 0) {
      NotificationManager.notify(
        `${count(result.cancelled)} cancelled, ${result.failed} could NOT be cancelled — check the exchange.`,
        NType.ERROR,
        'ERROR'
      );
      return;
    }

    NotificationManager.notify(
      result.cancelled === 0
        ? `No ${noun}s to cancel.`
        : `${count(result.cancelled)} cancelled.`,
      NType.INFO,
      'ORDER'
    );
  }

  private async handleTrailCommand(command: string): Promise<void> {
    const arg = command.slice('trail'.length).trim();

    if (arg === '') {
      NotificationManager.notify(
        'Usage: trail <distance> or trail <percent>%',
        NType.INFO,
        'SYSTEM'
      );
      return;
    }

    if (!this.currentMarket) {
      NotificationManager.notify('No market selected.', NType.ERROR, 'ERROR');
      return;
    }

    const percent = arg.endsWith('%');
    const value = Number(percent ? arg.slice(0, -1).trim() : arg);

    if (!Number.isFinite(value) || value <= 0) {
      NotificationManager.notify(
        `Invalid trail '${arg}'. Give a distance greater than 0, or a percentage such as 2%.`,
        NType.ERROR,
        'ERROR'
      );
      return;
    }

    try {
      const order = await this.exchangeCommand
        .getExchangeClient()
        .createTrailingStopOrder(this.currentMarket, value, percent);

      if (!order) {
        NotificationManager.notify(
          'Trailing stop was NOT placed.',
          NType.ERROR,
          'ERROR'
        );
      }
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async handleFatFingerCommand(command: string): Promise<void> {
    const exchangeClient = this.exchangeCommand.getExchangeClient();
    const arg = command.slice('fatfinger'.length).trim();

    if (arg === '') {
      const limit = exchangeClient.getFatFingerLimit();
      console.log(
        limit === undefined
          ? 'No fatfinger limit set. Orders of any value will be accepted. Set one with "fatfinger <amount>".'
          : `Fatfinger limit: ${limit} per order.`
      );
      return;
    }

    if (arg === 'off') {
      await exchangeClient.setFatFingerLimit(undefined);
      console.log(
        'Fatfinger limit removed. Orders of any value will now be accepted.'
      );
      return;
    }

    const limit = Number(arg);

    if (!Number.isFinite(limit) || limit <= 0) {
      console.log(
        `Invalid fatfinger amount '${arg}'. Give a number greater than 0, or "off" to remove the limit.`
      );
      return;
    }

    await exchangeClient.setFatFingerLimit(limit);
    console.log(
      `Fatfinger limit set to ${limit} per order, measured as size x price in the market's quote currency. ` +
        `Orders worth more than this are rejected before being sent.`
    );
  }

  private async handleCommand(command: string) {
    if (command.startsWith('print')) {
      if (command.includes('possize')) {
        const positionSize = await this.exchangeCommand
          .getExchangeClient()
          .getPositionSize(this.currentMarket);
        console.log(positionSize);
      } else if (command.includes('entry')) {
        this.entryPrice = await this.exchangeCommand
          .getExchangeClient()
          .getEntryPrice(this.currentMarket) ?? null;
        if (this.entryPrice !== null) {
          this.entryPrice = await this.formatPriceToMarketPrecision(this.entryPrice, this.currentMarket);
        } else {
          this.entryPrice = null;
        }
        console.log(this.entryPrice);
      }  else if (command.includes('precision')) {
        const precision = await this.exchangeCommand
          .getExchangeClient()
          .getMarketPrecision(this.currentMarket);
        console.log(precision);
      }

      return;
    }

    if (command.includes("possize")) {
      // Replace 'possize' with the latest position size
      this.lastPositionSize = await this.exchangeCommand
        .getExchangeClient()
        .getPositionSize(this.currentMarket);
      // If the position size is zero, throw an error and do not proceed

      if (this.lastPositionSize === 0) {
        console.log('Error: Cannot execute an order with a position size of zero.');
        return;
      }

      // Replace all instances of 'possize' with the actual position size
      command = this.processPositionSize(command, this.lastPositionSize);
    }

    if (command.includes("entry")) {
      this.entryPrice = await this.exchangeCommand
          .getExchangeClient()
          .getEntryPrice(this.currentMarket) ?? null;

      if (this.entryPrice === null) {
        console.log('Error: Cannot execute an order with an entry price of null.');
        return;
      }

      this.entryPrice = await this.formatPriceToMarketPrecision(this.entryPrice, this.currentMarket);

      if (this.entryPrice === 0) {
        console.log('Error: Cannot execute an order with an entry price of zero.');
        return;
      }

      if (this.entryPrice !== null) {
        command = this.replaceCommandVariable(command, this.entryPrice, 'entry');
      }
    }
    if (command === 'list methods') {
      this.displayAvailableMethods();
    } else if (command === 'trail' || command.startsWith('trail ')) {
      await this.handleTrailCommand(command);
    } else if (command === 'fatfinger' || command.startsWith('fatfinger ')) {
      await this.handleFatFingerCommand(command);
    } else if (command.startsWith('market')) {
      const market = command.split(' ')[1];
      if (this.availableMarkets.includes(market)) {
        this.currentMarket = market;
        this.exchangeCommand.getExchangeClient().followMarket(market);
        this.workspace?.setMarket(market);
        ActivityLog.getInstance().add('MARKET', `${market.split(':')[0]} selected`);

        // Save state for dev mode
        await this.saveDevState();
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
            this.reportFailure(error);
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

      if (this.currentMarket && this.currentMarket !== 'back') {
        this.exchangeCommand.getExchangeClient().followMarket(this.currentMarket);
      }

      // Save state for dev mode
      if (this.currentMarket && this.currentMarket !== 'back') {
        await this.saveDevState();
      }
    } else if (command === 'get market structure') {
      if (this.currentMarket.length > 0) {
        this.exchangeCommand
          .getExchangeClient()
          .getMarketStructure(this.currentMarket);
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel all') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllOrders(this.currentMarket)
            .then((result) => this.reportCancelled('order', result));
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel limits') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllLimitOrders(this.currentMarket)
            .then((result) => this.reportCancelled('limit order', result));
        } catch (error: unknown) {
          this.reportFailure(error);
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
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel stops') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllStopOrders(this.currentMarket)
            .then((result) => this.reportCancelled('stop order', result));
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command.startsWith('bump')) {
      // Accepts 'bump +10', 'bump + 10', 'bump -10', 'bump - 10' and 'bump 10'.
      const bumpRegex = /^bump\s+([-+])?\s*(\d*\.?\d+)/;
      const match = command.match(bumpRegex);
      if (match) {
        const priceChange = parseFloat(`${match[1] ?? ''}${match[2]}`);
        if (this.currentMarket) {
          try {
            await this.exchangeCommand
              .getExchangeClient()
              .bumpOrders(this.currentMarket, priceChange);
            console.log(`All orders have been bumped by ${priceChange}.`);
          } catch (error: unknown) {
            this.reportFailure(error);
          }
        } else {
          console.log('No market selected. Please select a market first.');
        }
      } else {
        console.log(
          'Invalid bump command format. Use "bump + [value]" or "bump - [value]".'
        );
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
          this.reportFailure(error);
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
          this.reportFailure(error);
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
            this.reportFailure(error);
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
          this.reportFailure(error);
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
          this.reportFailure(error);
        }
      } else {
        console.log('Invalid bracket command format. Please try again.');
      }
    } else if (command.startsWith('move stop')) {
      const parts = command.split(' ');
      if (parts.length === 3 && this.currentMarket) {
        const newStopPrice = parseFloat(parts[2]);
        if (!isNaN(newStopPrice)) {
          try {
              const currentStopOrderId = await this.exchangeCommand
                .getExchangeClient()
                .editCurrentStopOrder(this.currentMarket, newStopPrice);

              // 'processed' was reported whether or not anything moved, so a
              // failed move read as a successful one.
              if (currentStopOrderId) {
                const client = this.exchangeCommand.getExchangeClient();
                const position = await client
                  .getPositionView(this.currentMarket)
                  .catch(() => null);

                // The protective side is the one that closes the position.
                const side =
                  position?.side === 'LONG'
                    ? 'SELL'
                    : position?.side === 'SHORT'
                    ? 'BUY'
                    : undefined;

                NotificationManager.notify('', NType.SUCCESS, 'ORDER', undefined, {
                  side,
                  quantity: 'ALL',
                  price: client.formatPriceForDisplay(this.currentMarket, newStopPrice),
                  status: 'STOP UPDATED',
                });
              } else {
                NotificationManager.notify(
                  'No stop order found to move',
                  NType.ERROR,
                  'ERROR',
                  undefined,
                  { side: 'STOP', status: 'REJECTED' }
                );
              }
          } catch (error) {
              const failure = describeExchangeError(error);
              console.error(`[userInterface/move stop] ${failure.raw}`);
              NotificationManager.notify(failure.summary, NType.ERROR, 'ERROR', undefined, {
                side: 'STOP',
                status: 'REJECTED',
              });
          }
        } else {
          console.log('Invalid price format.');
        }
      } else {
        console.log('Usage: move stop <new stop price>');
      }
    } else if (command.startsWith('update stop')) {
      const parts = command.split(' ');
      let amount: number | undefined;
      if (parts.length > 3 || parts.length < 2) {
          console.log('Usage: update stop <amount>');
          return;
      }

      if (parts[1] !== 'stop') {
          console.log('Invalid command. Only stop order can be updated.');
          return;
      }

      if (parts.length === 3) {
          amount = parseFloat(parts[2]);
          if (isNaN(amount)) {
              console.log('Invalid amount. Amount should be a number.');
              return;
          }
      }

      try {
        if(amount !== undefined) {
          await this.exchangeCommand.getExchangeClient().updateStopOrder(this.currentMarket, amount);
          console.log(`Stop order updated with amount: ${amount}`);
        } else {
          await this.exchangeCommand.getExchangeClient().updateStopOrder(this.currentMarket);
          console.log('Stop order updated.');
        }
      } catch (error: unknown) {
          this.reportFailure(error);
      }
    } else if (this.currentMarket) {
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
        this.reportFailure(error);
      }
    } else {
      console.log('No market selected. Please select a market first.');
    }

    if (command === 'quit' || command === 'q') {
      // Clear dev state before quitting
      if (this.isDevMode) {
        await this.stateManager.clearState();
      }
      this.quit();
    }

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
    releaseInstanceLock();
    this.workspace?.stop();
    console.log('Exiting...');
    // Give time for readline to clean up
    setTimeout(() => {
      process.exit(0);
    }, 50);
  }
}
