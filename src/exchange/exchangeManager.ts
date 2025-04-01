// src/exchange/exchangeManager.ts

import { UserInterface } from '../client/userInterface';
import { ConfigManager } from '../config/configManager';
import { AppError } from '../errors/appError';
import { ErrorType } from '../errors/errorType';
import { ExchangeClient } from './exchangeClient';

export class ExchangeManager {
  private configManager: ConfigManager;
  private userInterface: UserInterface;
  private exchangeClient: ExchangeClient;

  constructor() {
    this.configManager = new ConfigManager();
    this.userInterface = new UserInterface();
    this.exchangeClient = ExchangeClient.getInstance();
  }

  private async initializeExchangeClient(): Promise<void> {
    try {
      await this.exchangeClient.init();
    } catch (error) {
      console.error('Failed to initialize ExchangeClient:', error);
    }
  }

  async getExchangeClient(): Promise<ExchangeClient> {
    if (!this.exchangeClient.isInitialized()) {
      await this.initializeExchangeClient();
    }
    return this.exchangeClient;
  }

  async addExchange(): Promise<void> {
    console.log('Adding an exchange...');

    const exchangeClient = await this.getExchangeClient();
    const supportedExchanges = exchangeClient.getSupportedExchanges();
    if (supportedExchanges.length === 0) {
      console.log('You have already added all supported exchanges.');
      return;
    }

    const selectedExchange = await this.userInterface.selectExchange(
      supportedExchanges
    );

    // Check if the selected exchange is Hyperliquid
    if (selectedExchange.toLowerCase() === 'hyperliquid') {
      const privateKey = await this.userInterface.addExchangeCredentials('privateKey', selectedExchange);
      const walletAddress = await this.userInterface.addExchangeCredentials('walletAddress', selectedExchange);
      await this.configManager.addExchange(selectedExchange, 'privateKey', { privateKey, walletAddress });
    } else {
      const key = await this.userInterface.addExchangeCredentials('key', selectedExchange);
      const secret = await this.userInterface.addExchangeCredentials('secret', selectedExchange);
      await this.configManager.addExchange(selectedExchange, 'apiKey', { key, secret });
    }

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

  async selectSavedExchange(): Promise<string> {
    const addedExchanges = await this.getAddedExchanges();
    return await this.userInterface.selectExchange(addedExchanges);
  }

  async selectExchange(): Promise<string> {
    const supportedExchanges = this.exchangeClient.getSupportedExchanges();

    if (supportedExchanges.length === 0) {
      console.log('No exchanges available. Please add an exchange first.');
      return '';
    }

    return await this.userInterface.selectExchange(supportedExchanges);
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
