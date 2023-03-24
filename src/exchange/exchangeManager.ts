// src/exchange/exchangeManager.ts

import { UserInterface } from "../client/userInterface";
import {
  ConfigManager,
  ExchangeProfile,
  Profile,
} from "../config/configManager";

export class ExchangeManager {
  private configManager: ConfigManager;
  private userInterface: UserInterface;

  constructor() {
    this.configManager = new ConfigManager();
    this.userInterface = new UserInterface();
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

  async removeExchange(exchangeToRemove: string): Promise<void> {
    if (await this.configManager.hasProfile()) {
      const profile = await this.configManager.getProfile();

      if (profile.exchanges.length > 0) {
        const updatedExchanges = profile.exchanges.filter(
          (exchangeProfile) => exchangeProfile.exchange !== exchangeToRemove
        );

        await this.configManager.updateProfile({
          exchanges: updatedExchanges,
          passwordHash: profile.passwordHash,
        });
      } else {
        throw new Error("No exchanges available to remove.");
      }
    } else {
      throw new Error("No profile found. Please create a profile first.");
    }
  }

  async getExchanges(): Promise<string[]> {
    if (await this.configManager.hasProfile()) {
      const profile = await this.configManager.getProfile();
      return profile.exchanges.map(
        (exchangeProfile) => exchangeProfile.exchange
      );
    } else {
      return [];
    }
  }
}
