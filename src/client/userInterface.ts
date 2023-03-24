// src/client/userInterface.ts

import inquirer from "inquirer";
import clear from "console-clear";

import { ExchangeProfile } from "../config/configManager";

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
}
