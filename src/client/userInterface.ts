// src/client/userInterface.ts

import inquirer from "inquirer";
import clear from "console-clear";
import * as readline from "readline";
import { TradingApi } from "../trading/tradingApi";
import { formatOutput as fo } from "../utils/formatOutput";

import { ExchangeProfile } from "../config/configManager";

export class UserInterface {
  private rl?: readline.Interface;
  private currentInstrument: string;
  private tradingApi: TradingApi;
  private availableMarkets: string[];

  constructor() {
    this.tradingApi = new TradingApi();
    this.currentInstrument = "";
    this.availableMarkets = [];
  }

  async displayWelcomeScreen(): Promise<void> {
    console.log(`${fo("Welcome to Tame!", "yellow", "bold")}`);
    console.log(
      `${fo(
        "In trading, speed, execution, and emotional control are crucial to success. With Tame, you'll be able to access powerful trading commands and custom shortcuts that will allow you to execute trades faster and more efficiently.\n\nOur emotions can often get in the way of rational decision-making, which is why Tame has guardrails to help you stay on track and avoid impulsive trades. Tame will hopefully teach you how to recognize and regulate your emotions, so you can make sound trading decisions while also maximizing your gains.\n\nNow, go be a ruthless predator, and trade with speed, precision, and confidence!",
        "yellow"
      )}`
    );
  }

  async displayHomeScreen(): Promise<string> {
    const menuChoices = [
      { name: "Start Trading", value: "startTrading" },
      { name: "Add Exchange", value: "addExchange" },
      { name: "Remove Exchange", value: "removeExchange" },
      { name: "Delete Profile", value: "deleteProfile" },
      { name: "Quit", value: "quit" },
    ];
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Choose an action:",
        choices: menuChoices,
      },
    ]);

    clear();

    return action;
  }

  async createProfile(): Promise<string> {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Choose an action:",
        choices: [
          { name: "Continue", value: "continue" },
          { name: "Quit", value: "quit" },
        ],
      },
    ]);

    clear();

    return action;
  }

  async removeExchange(profile: any): Promise<string> {
    const { exchange } = await inquirer.prompt([
      {
        type: "list",
        name: "exchange",
        message: "Choose an exchange to remove:",
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
        type: "list",
        name: "exchange",
        message: "Choose an exchange:",
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

    if (exchange.toLowerCase() === "kraken") {
      if (credential === "key") {
        message = "Enter your API Key:";
      } else if (credential === "secret") {
        message = "Enter you Private Key";
      }
    } else if (exchange.toLowerCase() === "deribit") {
      if (credential === "secret") {
        message = "Enter your Client ID:";
      } else if (credential === "secret") {
        message = "Enter your Client Secret:";
      }
    }
    const { enteredCred } = await inquirer.prompt([
      {
        type: "input",
        name: credential,
        message: message,
      },
    ]);

    clear();

    return enteredCred;
  }

  async startTradingInterface(): Promise<void> {
    this.availableMarkets = await this.tradingApi.getMarkets();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.promptForCommand();
  }

  private promptForCommand() {
    const promptMessage = this.currentInstrument
      ? `<${fo("Tame", "yellow", "italic")}><${fo(
          this.currentInstrument,
          "green",
          "italic"
        )}> `
      : `<${fo("Tame", "yellow", "italic")}> `;

    this.rl?.question(promptMessage, (command) => {
      this.handleCommand(command);
    });
  }

  private handleCommand(command: string) {
    if (command.startsWith("instrument ")) {
      const instrument = command.split(" ")[1];
      if (this.availableMarkets.includes(instrument)) {
        this.currentInstrument = instrument;
        console.log(`Switched to instrument: ${instrument}`);
      } else {
        console.log(`Invalid instrument: ${instrument}`);
      }
    } else if (command === "quit" || command === "q") {
      this.quit();
    } else {
      console.log(`Command received: ${command}`);
    }
    this.promptForCommand();
  }

  quit() {
    console.log("Exiting...");
    this.rl?.close();
    process.exit(0);
  }
}
