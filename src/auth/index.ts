// src/auth/index.ts

import { ConfigManager } from "../config/configManager";
import * as bcrypt from "bcrypt";
import inquirer from "inquirer";

export class AuthManager {
  private configManager: ConfigManager;

  constructor() {
    this.configManager = new ConfigManager();
  }

  async verifyPassword(): Promise<boolean> {
    const storedPasswordHash = await this.configManager.getPasswordHash();
    let attempts = 0;
    let passwordCorrect = false;

    while (attempts < 3) {
      const { enteredPassword } = await inquirer.prompt([
        {
          type: "password",
          name: "enteredPassword",
          message: "Enter your password:",
        },
      ]);

      passwordCorrect = await bcrypt.compare(
        enteredPassword,
        storedPasswordHash
      );

      if (passwordCorrect) {
        return true;
      } else {
        attempts++;
        console.log(
          `Incorrect password. You have ${3 - attempts} attempts remaining.`
        );
      }
    }

    return false;
  }
}
