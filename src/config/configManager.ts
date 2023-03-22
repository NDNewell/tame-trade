// src/config/configManager.ts

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Profile {
  exchange: string;
  clientId: string;
  clientSecret: string;
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

  async createProfile(
    exchange: string,
    clientId: string,
    clientSecret: string
  ): Promise<void> {
    const profile: Profile = {
      exchange,
      clientId,
      clientSecret,
    };

    await fs.promises.writeFile(this.configFile, JSON.stringify(profile));
  }

  async getProfile(): Promise<Profile> {
    if (await this.hasProfile()) {
      const profileData = await fs.promises.readFile(this.configFile, "utf8");
      return JSON.parse(profileData) as Profile;
    } else {
      throw new Error("Profile not found");
    }
  }
}
