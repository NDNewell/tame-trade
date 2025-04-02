import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ApplicationState {
  currentExchange?: string;
  currentMarket?: string;
  isDevMode?: boolean;
  isReload?: boolean;
}

export class StateManager {
  private statePath: string;
  private stateFile: string;
  private static instance: StateManager | null = null;

  private constructor() {
    this.statePath = path.join(os.homedir(), '.tame');
    this.stateFile = path.join(this.statePath, 'dev-state.json');

    if (!fs.existsSync(this.statePath)) {
      fs.mkdirSync(this.statePath);
    }
  }

  static getInstance(): StateManager {
    if (!this.instance) {
      this.instance = new StateManager();
    }
    return this.instance;
  }

  async saveState(state: ApplicationState): Promise<void> {
    try {
      await fs.promises.writeFile(this.stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error(`Error saving application state: ${error}`);
    }
  }

  async loadState(): Promise<ApplicationState> {
    try {
      if (await this.hasState()) {
        const stateData = await fs.promises.readFile(this.stateFile, 'utf8');
        return JSON.parse(stateData) as ApplicationState;
      }
      return {};
    } catch (error) {
      console.error(`Error loading application state: ${error}`);
      return {};
    }
  }

  async hasState(): Promise<boolean> {
    try {
      await fs.promises.access(this.stateFile, fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  async clearState(): Promise<void> {
    try {
      if (await this.hasState()) {
        await fs.promises.unlink(this.stateFile);
      }
    } catch (error) {
      console.error(`Error clearing application state: ${error}`);
    }
  }
}
