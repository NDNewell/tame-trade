// src/config/configManager.ts

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ExchangeProfile {
  exchange: string;
  clientId: string;
  clientSecret: string;
}

export interface Profile {
  exchanges: ExchangeProfile[];
}

export class ConfigManager {
  private configPath: string;
  private configFile: string;

  constructor() {
    this.configPath = path.join(os.homedir(), ".tame");
    this.configFile = path.join(this.configPath, "config.json");

    if (!fs.existsSync(this.configPath)) {
      fs.mkdirSync(this.configPath);
    }
  }

  async hasProfile(): Promise<boolean> {
    try {
      await fs.promises.access(this.configFile, fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getExchanges(): Promise<string[]> {
    if (await this.hasProfile()) {
      const profile = await this.getProfile();
      return profile.exchanges.map(
        (exchangeProfile) => exchangeProfile.exchange
      );
    } else {
      return [];
    }
  }

  async addExchange(
    exchange: string,
    clientId: string,
    clientSecret: string
  ): Promise<void> {
    const exchangeProfile: ExchangeProfile = {
      exchange,
      clientId,
      clientSecret,
    };

    let currentProfile: Profile;

    if (await this.hasProfile()) {
      currentProfile = await this.getProfile();
    } else {
      currentProfile = { exchanges: [] };
    }

    currentProfile.exchanges.push(exchangeProfile);

    await fs.promises.writeFile(
      this.configFile,
      JSON.stringify(currentProfile)
    );
  }

  async getProfile(): Promise<Profile> {
    if (await this.hasProfile()) {
      const profileData = await fs.promises.readFile(this.configFile, "utf8");
      return JSON.parse(profileData) as Profile;
    } else {
      throw new Error("Profile not found");
    }
  }

  async updateProfile(profile: Profile): Promise<void> {
    await fs.promises.writeFile(this.configFile, JSON.stringify(profile));
  }

  async deleteProfile(): Promise<void> {
    try {
      await fs.promises.unlink(this.configFile);
    } catch (error) {
      throw new Error("Failed to delete profile.");
    }
  }
}
