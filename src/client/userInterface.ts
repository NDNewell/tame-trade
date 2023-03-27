// src/client/userInterface.ts

import inquirer from 'inquirer';
import clear from 'console-clear';
import * as readline from 'readline';
import { TradingApi } from '../trading/tradingApi';
import { formatOutput as fo } from '../utils/formatOutput';
import { ExchangeProfile } from '../config/configManager';
import {
  ExchangeCommand,
  CommandType,
  InstrumentType,
} from '../commands/exchangeCommand';

export class UserInterface {
  private rl?: readline.Interface;
  private currentInstrument: string;
  private tradingApi: TradingApi;
  private availableMarkets: string[];
  private exchangeCommand: ExchangeCommand;

  constructor() {
    this.tradingApi = new TradingApi();
    this.exchangeCommand = new ExchangeCommand();
    this.currentInstrument = '';
    this.availableMarkets = [];
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

  async selectExchange(availableExchanges: any): Promise<string> {
    const { exchange } = await inquirer.prompt([
      {
        type: 'list',
        name: 'exchange',
        message: 'Choose an exchange:',
        choices: availableExchanges,
      },
    ]);

    clear();

    return exchange;
  }

  async addExchangeCredentials(
    exchange: string,
    credential: string
  ): Promise<any> {
    let message;

    if (exchange.toLowerCase() === 'kraken') {
      if (credential === 'key') {
        message = 'Enter your API Key:';
      } else if (credential === 'secret') {
        message = 'Enter your Private Key';
      }
    } else if (exchange.toLowerCase() === 'deribit') {
      if (credential === 'key') {
        message = 'Enter your Client ID:';
      } else if (credential === 'secret') {
        message = 'Enter your Client Secret:';
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
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.promptForCommand();
  }

  private pauseReadline() {
    this.rl?.pause();
  }

  private resumeReadline() {
    this.rl?.resume();
  }

  private promptForCommand() {
    const exchangeClient = this.exchangeCommand.getExchangeClient();
    const exchangeName = exchangeClient.getSelectedExchangeName();
    const tameDisplay = `<${fo('Tame', 'yellow', 'italic')}>`;
    const instrumentDisplay = `<${fo(
      `${this.currentInstrument}`,
      'green',
      'italic'
    )}>`;
    const exchangeDisplay = exchangeName
      ? `<${fo(exchangeName, 'orange', 'italic')}>`
      : '';

    const promptMessage = this.currentInstrument
      ? `${tameDisplay}${exchangeDisplay}${instrumentDisplay} `
      : `${tameDisplay}${exchangeDisplay} `;

    this.rl?.question(promptMessage, (command) => {
      this.handleCommand(command);
    });
  }

  private async handleCommand(command: string) {
    if (command.startsWith('instrument ')) {
      const instrument = command.split(' ')[1];
      if (this.availableMarkets.includes(instrument)) {
        this.currentInstrument = instrument;
        console.log(`Switched to instrument: ${instrument}`);
      } else {
        console.log(`Invalid instrument: ${instrument}`);
      }
    } else if (command === 'list instruments') {
      await this.selectInstrumentType();
    } else if (command === 'quit' || command === 'q') {
      this.quit();
    } else {
      if (this.currentInstrument) {
        try {
          const commandParams = await CommandType.parseCommand(command);
          if (commandParams !== null) {
            const { type, quantity, price } = commandParams;

            if (
              type === CommandType.MARKET_BUY ||
              type === CommandType.MARKET_SELL
            ) {
              await this.exchangeCommand.execute(
                type,
                this.currentInstrument,
                Number(quantity)
              );
            } else if (
              type === CommandType.STOP ||
              type === CommandType.LIMIT_BUY ||
              type === CommandType.LIMIT_SELL
            ) {
              await this.exchangeCommand.execute(
                type,
                this.currentInstrument,
                Number(quantity),
                Number(price)
              );
            }
          }
        } catch (error: unknown) {
          console.log((error as Error).message);
        }
      } else {
        console.log(
          'No instrument selected. Please select an instrument first.'
        );
      }
    }
    this.promptForCommand();
  }

  private async selectInstrumentType(): Promise<void> {
    this.pauseReadline();

    const availableTypes = await this.exchangeCommand
      .getExchangeClient()
      .getMarketTypes();

    const { instrumentType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'instrumentType',
        message: 'Select instrument type:',
        choices: [
          ...Array.from(availableTypes),
          { name: 'Back', value: 'back' },
        ],
      },
    ]);

    if (instrumentType === 'back') {
      this.resumeReadline();
    } else {
      this.exchangeCommand.listInstruments(instrumentType);
    }

    clear();
  }

  quit() {
    console.log('Exiting...');
    this.rl?.close();
    process.exit(0);
  }
}
