// src/client/userInterface.ts

import inquirer from "inquirer";
import clear from "console-clear";

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
}
