// src/client/client.ts

import { ConfigManager } from '../config/configManager.js';
import { AuthManager } from '../auth/authManager.js';
import { UserInterface } from './userInterface.js';
import { ExchangeManager } from '../exchange/exchangeManager.js';
import { ExchangeClient } from '../exchange/exchangeClient.js';

export class Client {
  private configManager: ConfigManager;
  private authManager: AuthManager;
  private userInterface: UserInterface;
  private exchangeManager: ExchangeManager;
  private exchangeClient: ExchangeClient;

  constructor() {
    this.configManager = new ConfigManager();
    this.exchangeManager = new ExchangeManager();
    this.authManager = new AuthManager();
    this.userInterface = new UserInterface();
    this.exchangeClient = ExchangeClient.getInstance();
  }

  async start() {
    console.log('Client initialized');
    this.exchangeClient.init();
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

    let addedExchanges = await this.exchangeManager.getAddedExchanges();
    let selectedExchange = '';

    if (addedExchanges.length === 0) {
      console.log('No exchanges available. Please add an exchange first.');
      await this.exchangeManager.addExchange();
      selectedExchange = addedExchanges[0];
    } else if (addedExchanges.length === 1) {
      selectedExchange = addedExchanges[0];
    } else {
      selectedExchange = await this.exchangeManager.selectSavedExchange();
    }

    if (!selectedExchange) {
      return;
    }

    await this.exchangeClient.setExchange(selectedExchange);

    this.userInterface.startTradingInterface();
  }

  async addExchange(): Promise<void> {}
}
