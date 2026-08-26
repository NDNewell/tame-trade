// src/config/configManager.ts

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppError } from '../errors/appError.js';
import { ErrorType } from '../errors/errorType.js';
import { GuardPolicy } from '../guard/guardPolicy.js';

export type ExchangeAuthType = 'apiKey' | 'privateKey';

export interface ExchangeProfile {
  exchange: string;
  authType: ExchangeAuthType;
  // For API key based exchanges
  key?: string;
  secret?: string;
  // For private key based exchanges (like Hyperliquid)
  privateKey?: string;
  walletAddress?: string;
  publicAddress?: string;
}

export interface Profile {
  exchanges: ExchangeProfile[];
  passwordHash: string;
  // Maximum size for a single order. Undefined means no limit is set.
  fatFinger?: number;
  // Orders worth at least this much ask for confirmation before being sent.
  // Undefined means no order is ever held for confirmation.
  confirmAbove?: number;
  // Guardrail thresholds. Stored as a partial: only what the operator changed
  // is written, so a later version's new defaults reach an existing profile
  // rather than being frozen at whatever this version happened to ship.
  guard?: Partial<GuardPolicy>;
}

export class ConfigManager {
  private configPath: string;
  private configFile: string;

  constructor() {
    this.configPath = path.join(os.homedir(), '.tame');
    this.configFile = path.join(this.configPath, 'config.json');

    if (!fs.existsSync(this.configPath)) {
      fs.mkdirSync(this.configPath, { mode: 0o700 });
    } else {
      this.restrict(this.configPath, 0o700);
    }
  }

  /**
   * Keeps a path readable only by its owner.
   *
   * This file holds API secrets in plaintext, so a default-permission write
   * leaves them readable by every account on the machine. Best effort: a
   * filesystem that cannot express the mode (Windows, some mounts) must not
   * stop the config from being written, or the app cannot be used at all.
   */
  private restrict(target: string, mode: number): void {
    try {
      fs.chmodSync(target, mode);
    } catch {
      // Nothing to do about it here; failing the write would be worse.
    }
  }

  /**
   * The single path by which the profile reaches disk.
   *
   * `mode` on writeFile only applies when the file is created, so an existing
   * config keeps whatever permissions it already had -- including the
   * world-readable ones every version before this one wrote. The explicit
   * chmod repairs those in place on the next save.
   */
  private async writeConfig(profile: Profile): Promise<void> {
    await fs.promises.writeFile(this.configFile, JSON.stringify(profile), {
      mode: 0o600,
    });
    this.restrict(this.configFile, 0o600);
  }

  async initializeProfile(): Promise<void> {
    const emptyProfile: Profile = { exchanges: [], passwordHash: '' };
    await this.writeConfig(emptyProfile);
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

  // Returns the saved fatfinger limit, or undefined if none is set. Anything
  // stored that isn't a usable positive number is treated as unset rather than
  // trusted, so a corrupt config can't silently disable the guard.
  async getFatFinger(): Promise<number | undefined> {
    if (!(await this.hasProfile())) {
      return undefined;
    }

    const profile = await this.getProfile();
    const limit = profile.fatFinger;

    return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? limit
      : undefined;
  }

  async setFatFinger(limit: number | undefined): Promise<void> {
    const profile = await this.getProfile();

    if (limit === undefined) {
      delete profile.fatFinger;
    } else {
      profile.fatFinger = limit;
    }

    await this.updateProfile(profile);
  }

  async getConfirmAbove(): Promise<number | undefined> {
    if (!(await this.hasProfile())) return undefined;

    const profile = await this.getProfile();
    const threshold = profile.confirmAbove;

    return typeof threshold === 'number' &&
      Number.isFinite(threshold) &&
      threshold > 0
      ? threshold
      : undefined;
  }

  async setConfirmAbove(threshold: number | undefined): Promise<void> {
    const profile = await this.getProfile();

    if (threshold === undefined) {
      delete profile.confirmAbove;
    } else {
      profile.confirmAbove = threshold;
    }

    await this.updateProfile(profile);
  }

  /**
   * The stored guardrail settings, or nothing if none were ever changed.
   *
   * Deliberately not resolved against the defaults here -- `resolvePolicy` does
   * that, and doing it in two places is how the two copies come to disagree.
   */
  async getGuardPolicy(): Promise<Partial<GuardPolicy> | undefined> {
    if (!(await this.hasProfile())) return undefined;

    const profile = await this.getProfile();
    const stored = profile.guard;

    return stored && typeof stored === 'object' ? stored : undefined;
  }

  async setGuardPolicy(policy: Partial<GuardPolicy> | undefined): Promise<void> {
    const profile = await this.getProfile();

    if (policy === undefined) {
      delete profile.guard;
    } else {
      profile.guard = policy;
    }

    await this.updateProfile(profile);
  }

  async addExchange(
    exchange: string,
    authType: ExchangeAuthType,
    credentials: {
      key?: string;
      secret?: string;
      privateKey?: string;
      walletAddress?: string;
      // Hyperliquid queries positions by a public address separate from the
      // signing wallet. It was already being passed and stored via the spread,
      // but was absent from this type, so a typo in the caller would have gone
      // unnoticed and silently saved nothing.
      publicAddress?: string;
    }
  ): Promise<void> {
    const exchangeProfile: ExchangeProfile = {
      exchange,
      authType,
      ...credentials
    };

    let currentProfile: Profile;

    if (await this.hasProfile()) {
      currentProfile = await this.getProfile();
    } else {
      currentProfile = { exchanges: [], passwordHash: '' };
    }

    currentProfile.exchanges.push(exchangeProfile);

    await this.writeConfig(currentProfile);
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
    await this.writeConfig(profile);
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
  ): Promise<{ key?: string; secret?: string; privateKey?: string; walletAddress?: string; publicAddress?: string; authType: ExchangeAuthType }> {
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
          privateKey: savedExchange.privateKey,
          walletAddress: savedExchange.walletAddress,
          publicAddress: savedExchange.publicAddress,
          authType: savedExchange.authType
        };
      } else {
        throw new AppError(ErrorType.EXCHANGE_NOT_FOUND);
      }
    } else {
      throw new AppError(ErrorType.PROFILE_NOT_FOUND);
    }
  }
}
