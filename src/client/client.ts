// src/client/client.ts

import * as readline from "readline";
import { TradingApi } from "../trading/tradingApi";
import { ConfigManager } from "../config/configManager";
import { formatOutput as fo } from "../utils/formatOutput";
import { NotificationManager, NType } from "../utils/notificationManager";

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

    console.log("Starting new trading session...");
    console.log("Session initiated");

    this.availableMarkets = await this.tradingApi.getMarkets();
    this.promptForCommand();
  }

  private promptForCommand() {
    const promptText = this.currentInstrument
      ? `<${fo("Tame", "yellow", "italic")}><${fo(
          this.currentInstrument,
          "green",
          "italic"
        )}> `
      : `<${fo("Tame", "yellow", "italic")}> `;
    this.rl.question(promptText, (command) => {
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
    this.rl.close();
    process.exit(0); // Exit the application
  }

  private async createProfile() {
    console.log("Creating new profile...");

    const allowedExchanges = [
      { name: "Kraken", shortcut: "k" },
      { name: "Deribit", shortcut: "d" },
      { name: "Binance", shortcut: "b" },
    ];
    let exchange: string | undefined;

    while (!exchange) {
      const input = await this.promptQuestion(
        `Enter your preferred exchange (${allowedExchanges
          .map((ex) => `[${ex.shortcut.toUpperCase()}]${ex.name.slice(1)}`)
          .join(", ")}): `
      );
      const foundExchange = allowedExchanges.find(
        (allowedExchange) =>
          allowedExchange.name.toLowerCase() === input.toLowerCase() ||
          allowedExchange.shortcut.toLowerCase() === input.toLowerCase()
      );

      if (foundExchange) {
        exchange = foundExchange.name;
      } else {
        NotificationManager.notify(
          `Invalid exchange entered. Please choose from the following: ${allowedExchanges
            .map((exchange) => exchange.name)
            .join(", ")}`,
          NType.ERROR
        );
      }
    }

    const clientId = await this.promptQuestion("Enter your Client ID: ");
    const clientSecret = await this.promptQuestion(
      "Enter your Client Secret: ",
      true
    );
    await this.configManager.createProfile(exchange, clientId, clientSecret);
    NotificationManager.notify("Profile created successfully", NType.SUCCESS);
  }

  private promptQuestion(
    question: string,
    clearAfterInput: boolean = false
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.rl.question(question, (answer) => {
        if (answer.toLowerCase() === "quit" || answer.toLowerCase() === "q") {
          this.quit();
        }

        if (clearAfterInput) {
          this.clearLine();
        }
        resolve(answer);
      });
    });
  }

  private clearLine() {
    readline.clearScreenDown(process.stdout);
  }
}
