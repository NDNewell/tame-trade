// src/client/userInterface.ts

import inquirer from "inquirer";
import clear from "console-clear";

import { ExchangeProfile } from "../config/configManager";
import { getJSDocReadonlyTag } from "typescript";

export class UserInterface {
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
    const { exchangeToRemove } = await inquirer.prompt([
      {
        type: "list",
        name: "exchange",
        message: "Choose an exchange to remove:",
        choices: profile.exchanges.map((exchangeProfile: ExchangeProfile) => {
          return exchangeProfile.exchange;
        }),
      },
    ]);

    clear();

    return exchangeToRemove;
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
}
