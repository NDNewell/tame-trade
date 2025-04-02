// src/auth/index.ts

import { ConfigManager } from "../config/configManager.js";
import * as bcrypt from "bcrypt";
import inquirer from "inquirer";

export class AuthManager {
  private configManager: ConfigManager;
  private skipPasswordAuth: boolean;

  constructor() {
    this.configManager = new ConfigManager();
    this.skipPasswordAuth = process.env.SKIP_PASSWORD_AUTH === 'true';
  }

  async verifyPassword(): Promise<boolean> {
    // Skip password verification in development mode if flag is set
    if (this.skipPasswordAuth) {
      // Don't log anything here - already logged in startup
      return true;
    }

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

  async createPassword(): Promise<void> {
    // In development mode with skip flag, create a simple placeholder password
    if (this.skipPasswordAuth) {
      // Don't log anything here - already logged in verifyPassword
      const passwordHash = await bcrypt.hash("devpassword", 10);

      const currentProfile = await this.configManager.getProfile();
      currentProfile.passwordHash = passwordHash;

      await this.configManager.updateProfile(currentProfile);
      return;
    }

    const { password } = await inquirer.prompt([
      {
        type: "password",
        name: "password",
        message: "Create a password to increase security:",
      },
    ]);

    const { confirmPassword } = await inquirer.prompt([
      {
        type: "password",
        name: "confirmPassword",
        message: "Confirm your password:",
      },
    ]);

    if (password !== confirmPassword) {
      console.log("Passwords do not match. Please try again.");
      await this.createPassword();
    } else {
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      const currentProfile = await this.configManager.getProfile();
      currentProfile.passwordHash = passwordHash;

      await this.configManager.updateProfile(currentProfile);
      console.log("Password created successfully.");
    }
  }
}
