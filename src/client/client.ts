// src/client/client.ts

import * as readline from "readline";
import { TradingApi } from "../trading/tradingApi";
import { ConfigManager } from "../config/configManager";
import { formatOutput as fo } from "../utils/formatOutput";
import { AuthManager } from "../auth/authManager";
import { UserInterface } from "./userInterface";
import inquirer from "inquirer";
import clear from "console-clear";

export class Client {
  private rl?: readline.Interface;
  private currentInstrument: string;
  private tradingApi: TradingApi;
  private availableMarkets: string[];
  private configManager: ConfigManager;
  private authManager: AuthManager;
  private userInterface: UserInterface;

  constructor() {
    this.currentInstrument = "";
    this.tradingApi = new TradingApi();
    this.availableMarkets = [];
    this.configManager = new ConfigManager();
    this.authManager = new AuthManager();
    this.userInterface = new UserInterface();
    console.log("Client initialized");
  }

  async start() {
    if (await this.configManager.hasProfile()) {
      const passwordCorrect = await this.authManager.verifyPassword();
      if (!passwordCorrect) {
        console.log("Too many incorrect password attempts. Exiting...");
        process.exit(1);
      }
    } else {
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

    const action = await this.userInterface.createProfile();

    if (action === "continue") {
      await this.configManager.initializeProfile();
      await this.authManager.createPassword();
      await this.addExchange();
    } else {
      this.quit();
    }
  }

  private async showMenu() {
    const action = await this.userInterface.displayHomeScreen();

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
      case "quit":
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
        const exchangeToRemove = await this.userInterface.removeExchange(
          profile
        );
        const updatedExchanges = profile.exchanges.filter(
          (exchangeProfile) => exchangeProfile.exchange !== exchangeToRemove
        );

        await this.configManager.updateProfile({
          exchanges: updatedExchanges,
          passwordHash: profile.passwordHash,
        });
        console.log("Exchange removed successfully.");
      } else {
        console.log("No exchanges available to remove.");
      }
    } else {
      console.log("No profile found. Please create a profile first.");
    }
  }

  async startSession(): Promise<void> {
    console.log("Starting trading session...");

    let availableExchanges = await this.configManager.getExchanges();
    let selectedExchange = "";

    if (availableExchanges.length === 0) {
      console.log("No exchanges available. Please add an exchange first.");
      await this.addExchange();
      availableExchanges = await this.configManager.getExchanges();
      selectedExchange = availableExchanges[0];
    } else if (availableExchanges.length === 1) {
      selectedExchange = availableExchanges[0];
    } else {
      selectedExchange = await this.selectExchange();
    }

    if (!selectedExchange) {
      return;
    }

    console.log(`Using exchange: ${selectedExchange}`);
    this.availableMarkets = await this.tradingApi.getMarkets();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.promptForCommand();
  }

  async selectExchange(): Promise<string> {
    const availableExchanges = await this.configManager.getExchanges();

    if (availableExchanges.length === 0) {
      console.log("No exchanges available. Please add an exchange first.");
      return "";
    }

    return await this.userInterface.selectExchange(availableExchanges);
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

  private quit() {
    console.log("Exiting...");
    this.rl?.close();
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

    const selectedExchange = await this.userInterface.selectExchange(
      availableExchanges
    );

    const key = await this.userInterface.addExchangeCredentials(
      selectedExchange,
      "key"
    );
    const secret = await this.userInterface.addExchangeCredentials(
      selectedExchange,
      "secret"
    );

    await this.configManager.addExchange(selectedExchange, key, secret);
    console.log(`${selectedExchange} added successfully.`);
  }
}
