// src/client/client.ts

import { ConfigManager } from '../config/configManager';
import { AuthManager } from '../auth/authManager';
import { UserInterface } from './userInterface';
import { ExchangeManager } from '../exchange/exchangeManager';
import { ExchangeClient } from '../exchange/exchangeClient';

export class Client {
  private configManager: ConfigManager;
  private authManager: AuthManager;
  private userInterface: UserInterface;
  private exchangeManager: ExchangeManager;

  constructor() {
    this.configManager = new ConfigManager();
    this.exchangeManager = new ExchangeManager();
    this.authManager = new AuthManager();
    this.userInterface = new UserInterface();
    console.log('Client initialized');
  }

  async start() {
    ExchangeClient.testCcxt();
    if (await this.configManager.hasProfile()) {
      const passwordCorrect = await this.authManager.verifyPassword();
      if (!passwordCorrect) {
        console.log('Too many incorrect password attempts. Exiting...');
        process.exit(1);
      }
    } else {
      await this.createProfile();
    }

    await this.showMenu();
  }

  private async createProfile() {
    this.userInterface.displayWelcomeScreen();

    const action = await this.userInterface.createProfile();

    if (action === 'continue') {
      await this.configManager.initializeProfile();
      await this.authManager.createPassword();
      await this.exchangeManager.addExchange();
    } else {
      this.userInterface.quit();
    }
  }

  private async showMenu() {
    const action = await this.userInterface.displayHomeScreen();

    switch (action) {
      case 'startTrading':
        await this.startSession();
        break;
      case 'addExchange':
        await this.exchangeManager.addExchange();
        await this.showMenu();
        break;
      case 'removeExchange':
        await this.exchangeManager.removeExchange();
        await this.showMenu();
        break;
      case 'deleteProfile':
        await this.configManager.deleteProfile();
        console.log('Profile deleted.');
        this.userInterface.quit();
        break;
      case 'quit':
        this.userInterface.quit();
        break;
      default:
        console.log('Invalid option.');
        await this.showMenu();
        break;
    }
  }

  async startSession(): Promise<void> {
    console.log('Starting trading session...');

    let availableExchanges = await this.exchangeManager.getAddedExchanges();
    let selectedExchange = '';

    if (availableExchanges.length === 0) {
      console.log('No exchanges available. Please add an exchange first.');
      await this.exchangeManager.addExchange();
      availableExchanges = await this.exchangeManager.getAddedExchanges();
      selectedExchange = availableExchanges[0];
    } else if (availableExchanges.length === 1) {
      selectedExchange = availableExchanges[0];
    } else {
      selectedExchange = await this.exchangeManager.selectExchange();
    }

    if (!selectedExchange) {
      return;
    }

    console.log(`Using exchange: ${selectedExchange}`);

    this.userInterface.startTradingInterface();
  }

  async addExchange(): Promise<void> {}
}
