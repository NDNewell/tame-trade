// src/exchange/exchangeManager.ts

import { UserInterface } from '../client/userInterface';
import { ConfigManager } from '../config/configManager';
import { AppError } from '../errors/appError';
import { ErrorType } from '../errors/errorType';

export class ExchangeManager {
  private configManager: ConfigManager;
  private userInterface: UserInterface;

  constructor() {
    this.configManager = new ConfigManager();
    this.userInterface = new UserInterface();
  }

  async addExchange(): Promise<void> {
    console.log('Adding an exchange...');

    const supportedExchanges = ['Kraken', 'Deribit', 'Binance'];
    const currentExchanges = await this.getAddedExchanges();
    const availableExchanges = supportedExchanges.filter(
      (exchange) => !currentExchanges.includes(exchange)
    );

    if (availableExchanges.length === 0) {
      console.log('You have already added all supported exchanges.');
      return;
    }

    const selectedExchange = await this.userInterface.selectExchange(
      availableExchanges
    );

    const key = await this.userInterface.addExchangeCredentials(
      selectedExchange,
      'key'
    );
    const secret = await this.userInterface.addExchangeCredentials(
      selectedExchange,
      'secret'
    );

    await this.configManager.addExchange(selectedExchange, key, secret);
    console.log(`${selectedExchange} added successfully.`);
  }

  async removeExchange(): Promise<void> {
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
        console.log('Exchange removed successfully.');
      } else {
        console.log('No exchanges available to remove.');
      }
    } else {
      console.log('No profile found. Please create a profile first.');
    }
  }

  async getAddedExchanges(): Promise<string[]> {
    if (await this.configManager.hasProfile()) {
      const profile = await this.configManager.getProfile();
      return profile.exchanges.map(
        (exchangeProfile) => exchangeProfile.exchange
      );
    } else {
      return [];
    }
  }

  async selectExchange(): Promise<string> {
    const availableExchanges = await this.getAddedExchanges();

    if (availableExchanges.length === 0) {
      console.log('No exchanges available. Please add an exchange first.');
      return '';
    }

    return await this.userInterface.selectExchange(availableExchanges);
  }

  async getExchangeCredentials(
    exchange: string
  ): Promise<{ key: string; secret: string }> {
    if (await this.configManager.hasProfile()) {
      const profile = await this.configManager.getProfile();
      const savedExchange = profile.exchanges.find(
        (exchangeProfile) => exchangeProfile.exchange === exchange
      );

      if (savedExchange) {
        return {
          key: savedExchange.key,
          secret: savedExchange.secret,
        };
      } else {
        throw new AppError(ErrorType.EXCHANGE_NOT_FOUND);
      }
    } else {
      throw new AppError(ErrorType.PROFILE_NOT_FOUND);
    }
  }
}
