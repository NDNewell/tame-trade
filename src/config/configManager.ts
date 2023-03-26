// src/config/configManager.ts

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppError } from '../errors/appError';
import { ErrorType } from '../errors/errorType';

export interface ExchangeProfile {
  exchange: string;
  key: string;
  secret: string;
}

export interface Profile {
  exchanges: ExchangeProfile[];
  passwordHash: string;
}

export class ConfigManager {
  private configPath: string;
  private configFile: string;

  constructor() {
    this.configPath = path.join(os.homedir(), '.tame');
    this.configFile = path.join(this.configPath, 'config.json');

    if (!fs.existsSync(this.configPath)) {
      fs.mkdirSync(this.configPath);
    }
  }

  async initializeProfile(): Promise<void> {
    const emptyProfile: Profile = { exchanges: [], passwordHash: '' };
    await fs.promises.writeFile(this.configFile, JSON.stringify(emptyProfile));
  }

  async hasProfile(): Promise<boolean> {
    try {
      await fs.promises.access(this.configFile, fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getPasswordHash(): Promise<string> {
    if (await this.hasProfile()) {
      const profile = await this.getProfile();
      return profile.passwordHash;
    } else {
      throw new AppError(ErrorType.PROFILE_NOT_FOUND);
    }
  }

  async addExchange(
    exchange: string,
    key: string,
    secret: string
  ): Promise<void> {
    const exchangeProfile: ExchangeProfile = {
      exchange,
      key,
      secret,
    };

    let currentProfile: Profile;

    if (await this.hasProfile()) {
      currentProfile = await this.getProfile();
    } else {
      currentProfile = { exchanges: [], passwordHash: '' };
    }

    currentProfile.exchanges.push(exchangeProfile);

    await fs.promises.writeFile(
      this.configFile,
      JSON.stringify(currentProfile)
    );
  }

  async getProfile(): Promise<Profile> {
    if (await this.hasProfile()) {
      const profileData = await fs.promises.readFile(this.configFile, 'utf8');
      return JSON.parse(profileData) as Profile;
    } else {
      throw new AppError(ErrorType.PROFILE_NOT_FOUND);
    }
  }

  async updateProfile(profile: Profile): Promise<void> {
    await fs.promises.writeFile(this.configFile, JSON.stringify(profile));
  }

  async deleteProfile(): Promise<void> {
    try {
      await fs.promises.unlink(this.configFile);
    } catch (error) {
      throw new AppError(ErrorType.DELETE_PROFILE_FAILED);
    }
  }
  async getExchangeCredentials(
    exchange: string
  ): Promise<{ key: string; secret: string }> {
    if (await this.hasProfile()) {
      const profile = await this.getProfile();
      const savedExchange = profile.exchanges.find(
        (exchangeProfile) =>
          exchangeProfile.exchange.toLowerCase() === exchange.toLowerCase()
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
