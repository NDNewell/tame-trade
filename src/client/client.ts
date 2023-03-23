// src/client/client.ts

import * as readline from "readline";
import { TradingApi } from "../trading/tradingApi";
import { ConfigManager } from "../config/configManager";
import { formatOutput as fo } from "../utils/formatOutput";
import inquirer from "inquirer";

export class Client {
  private rl: readline.Interface;
  private currentInstrument: string;
  private tradingApi: TradingApi;
  private availableMarkets: string[];
  private configManager: ConfigManager;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.currentInstrument = "";
    this.tradingApi = new TradingApi();
    this.availableMarkets = [];
    this.configManager = new ConfigManager();
    console.log("Client initialized");
  }

  async start() {
    if (!(await this.configManager.hasProfile())) {
      await this.createProfile();
    }

    await this.showMenu();
  }

  private async createProfile() {
    console.log(`${fo("Welcome to Tame!", "yellow", "bold")}`);
    console.log(
      `${fo(
        "In trading, speed, execution, and emotional control are crucial to success. With Tame, you'll be able to access powerful trading commands and custom shortcuts that will allow you to execute trades faster and more efficiently.\n\nOur emotions can often get in the way of rational decision-making, which is why Tame has guardrails to help you stay on track and avoid impulsive trades. Tame will hopefully teach you how to recognize and regulate your emotions, so you can make sound trading decisions while also maximizing your gains.\n\nNow, go be a ruthless predator, and trade with speed, precision, and confidence!",
        "yellow"
      )}`
    );

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

    if (action === "continue") {
      await this.addExchange();
    } else {
      this.quit();
    }
  }

  private async showMenu() {
    const menuChoices = [
      { name: "Start Trading", value: "startTrading" },
      { name: "Add Exchange", value: "addExchange" },
      { name: "Remove Exchange", value: "removeExchange" },
      { name: "Delete Profile", value: "deleteProfile" },
    ];

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Choose an action:",
        choices: menuChoices,
      },
    ]);

    switch (action) {
      case "startTrading":
        await this.startSession();
        break;
      case "addExchange":
        await this.addExchange();
        await this.showMenu();
        break;
      case "removeExchange":
        await this.removeExchange();
        await this.showMenu();
        break;
      case "deleteProfile":
        await this.configManager.deleteProfile();
        console.log("Profile deleted.");
        this.quit();
        break;
      default:
        console.log("Invalid option.");
        await this.showMenu();
        break;
    }
  }

  private async removeExchange() {
    if (await this.configManager.hasProfile()) {
      const profile = await this.configManager.getProfile();

      if (profile.exchanges.length > 0) {
        const exchangeToRemove = await inquirer.prompt([
          {
            type: "list",
            name: "exchange",
            message: "Choose an exchange to remove:",
            choices: profile.exchanges.map(
              (exchangeProfile) => exchangeProfile.exchange
            ),
          },
        ]);

        const updatedExchanges = profile.exchanges.filter(
          (exchangeProfile) =>
            exchangeProfile.exchange !== exchangeToRemove.exchange
        );

        await this.configManager.updateProfile({ exchanges: updatedExchanges });
        console.log("Exchange removed successfully.");
      } else {
        console.log("No exchanges available to remove.");
      }
    } else {
      console.log("No profile found. Please create a profile first.");
    }
  }

  async startSession() {
    const chosenExchange = await this.chooseExchange();
    console.log(`Using exchange: ${chosenExchange}`);
    this.availableMarkets = await this.tradingApi.getMarkets();
    this.promptForCommand();
  }

  private async chooseExchange() {
    const exchanges = await this.configManager.getExchanges();

    if (exchanges.length === 1) {
      return exchanges[0];
    } else {
      const { chosenExchange } = await inquirer.prompt([
        {
          type: "list",
          name: "chosenExchange",
          message: "Which exchange would you like to use?",
          choices: exchanges,
        },
      ]);

      return chosenExchange;
    }
  }

  private async promptForCommand() {
    const command = await inquirer.prompt([
      {
        type: "input",
        name: "command",
        message: this.currentInstrument
          ? `<${fo("Tame", "yellow", "italic")}><${fo(
              this.currentInstrument,
              "green",
              "italic"
            )}> `
          : `<${fo("Tame", "yellow", "italic")}> `,
      },
    ]);

    this.handleCommand(command.command);
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

  private quit() {
    console.log("Exiting...");
    this.rl.close();
    process.exit(0); // Exit the application
  }

  async addExchange(): Promise<void> {
    console.log("Adding an exchange...");

    const supportedExchanges = ["Kraken", "Deribit", "Binance"];
    const currentExchanges = await this.configManager.getExchanges();
    const availableExchanges = supportedExchanges.filter(
      (exchange) => !currentExchanges.includes(exchange)
    );

    if (availableExchanges.length === 0) {
      console.log("You have already added all supported exchanges.");
      return;
    }

    const { selectedExchange } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedExchange",
        message: "Select an exchange:",
        choices: availableExchanges,
      },
    ]);

    const { clientId } = await inquirer.prompt([
      {
        type: "input",
        name: "clientId",
        message: "Enter your Client ID:",
      },
    ]);

    const { clientSecret } = await inquirer.prompt([
      {
        type: "input",
        name: "clientSecret",
        message: "Enter your Client Secret:",
      },
    ]);

    await this.configManager.addExchange(
      selectedExchange,
      clientId,
      clientSecret
    );
    console.log(`${selectedExchange} added successfully.`);
  }

  private async promptQuestion(
    question: string,
    clearAfterInput: boolean = false
  ): Promise<string> {
    const answer = await inquirer.prompt([
      {
        type: "input",
        name: "answer",
        message: question,
      },
    ]);

    if (
      answer.answer.toLowerCase() === "quit" ||
      answer.answer.toLowerCase() === "q"
    ) {
      this.quit();
    }

    if (clearAfterInput) {
      this.clearLine();
    }

    return answer.answer;
  }

  private clearLine() {
    readline.clearScreenDown(process.stdout);
  }
}
