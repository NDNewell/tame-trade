// src/client/userInterface.ts

import inquirer from 'inquirer';

import autocomplete from 'inquirer-autocomplete-prompt';
import clear from 'console-clear';
import { formatOutput as fo } from '../utils/formatOutput.js';
import { ExchangeProfile } from '../config/configManager.js';
import { ExchangeCommand, OrderType } from '../commands/exchangeCommand.js';
import { StateManager } from '../config/stateManager.js';
import {
  parseTrailSpec,
  isTrailSpecError,
  parseDelayedTrail,
} from '../trading/trailSpec.js';
import { NotificationManager, NType } from '../utils/notificationManager.js';
import { describeExchangeError } from '../utils/exchangeErrors.js';
import { Workspace } from '../ui/workspace.js';
import { ActivityLog } from '../ui/activityLog.js';
import { GuardVerdict } from '../guard/guardrails.js';
import { OrderProposal } from '../guard/detectors.js';
import { ALL_BEHAVIOUR_IDS, isBehaviourId } from '../guard/behaviours.js';
import { releaseInstanceLock } from '../config/instanceLock.js';

export class UserInterface {
  private currentMarket: string;
  private availableMarkets: string[];
  private exchangeCommand: ExchangeCommand;
  private chaseOrderId: string | undefined;
  private lastPositionSize: number | null = null;
  private entryPrice: number | null = null;
  private stateManager: StateManager;
  private isDevMode: boolean;
  private workspace: Workspace | null = null;
  /**
   * An order the guardrails held, waiting for a yes.
   *
   * Held here rather than resolved with a blocking prompt: the workspace owns
   * the input line, and opening a second reader for it produces two things
   * reading one keyboard. This way the confirmation is just the next command,
   * which also means every other command still works while one is pending --
   * including 'cancel all', which is the one an operator may want most.
   */
  private pendingOrder:
    | { command: string; verdict: GuardVerdict; market: string; at: number }
    | null = null;

  constructor() {
    this.exchangeCommand = new ExchangeCommand();
    this.currentMarket = '';
    this.availableMarkets = [];
    this.chaseOrderId = '';
    this.stateManager = StateManager.getInstance();
    this.isDevMode = process.env.NODE_ENV === 'development';
    inquirer.registerPrompt('autocomplete', autocomplete);
  }

  // Save current application state for dev mode
  private async saveDevState(): Promise<void> {
    if (this.isDevMode) {
      const currentExchange = this.exchangeCommand.getExchangeClient().getSelectedExchangeName();
      await this.stateManager.saveState({
        currentExchange: currentExchange || undefined,
        currentMarket: this.currentMarket || undefined,
        isDevMode: true,
        isReload: true // Mark that next start will be a reload
      });
    }
  }

  async displayWelcomeScreen(): Promise<void> {
    console.log(`${fo('Welcome to Tame!', 'yellow', 'bold')}`);
    console.log(
      `${fo(
        "Tame helps you trade faster and more efficiently with powerful commands and shortcuts. The built-in guardrails prevent impulsive trades and help you stay focused.\n\nTrade with speed, precision, and confidence!",
        'yellow'
      )}`
    );
  }

  /**
   * Shows a secret without showing it.
   *
   * Enough of the key to tell two of them apart, and never enough to use. The
   * last four characters are what distinguishes keys from the same account, and
   * the length is what catches a paste that picked up a newline.
   */
  private static maskKey(key: string): string {
    return key.length <= 8
      ? `${'*'.repeat(key.length)} (${key.length} characters — suspiciously short)`
      : `${key.slice(0, 7)}…${key.slice(-4)} (${key.length} characters)`;
  }

  async displayHomeScreen(coachKey?: string): Promise<string> {
    // The menu says whether a key is already there. 'Add' where one exists
    // invites the question of whether it replaces or appends, and the answer
    // should not have to be discovered by trying it.
    const menuChoices = [
      { name: 'Start Trading', value: 'startTrading' },
      { name: 'Add Exchange', value: 'addExchange' },
      { name: 'Remove Exchange', value: 'removeExchange' },
      {
        name: coachKey ? 'AI Coach Key (set)' : 'AI Coach Key (not set)',
        value: 'coachKey',
      },
      { name: 'Delete Profile', value: 'deleteProfile' },
      { name: 'Quit', value: 'quit' },
    ];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Choose an action:',
        choices: menuChoices,
      },
    ]);

    clear();

    return action;
  }

  /**
   * Enter, replace or remove the coach key.
   *
   * Typed with `type: 'password'` so it does not land in the terminal's
   * scrollback, unlike the exchange credentials above -- those predate this and
   * are worth the same treatment, but changing them is a separate decision
   * about a separate flow.
   *
   * Returns the new value, `null` to clear it, or undefined to leave it alone.
   */
  async editCoachKey(current?: string): Promise<string | null | undefined> {
    console.log(
      current
        ? `A coach key is stored: ${UserInterface.maskKey(current)}`
        : 'No coach key is stored. The guardrails work without one; the written debriefs do not.'
    );
    console.log(
      'It is kept in ~/.tame/config.json beside your exchange credentials, and never leaves this machine except in calls to Anthropic.\n'
    );

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'AI Coach Key:',
        choices: [
          { name: current ? 'Replace it' : 'Enter a key', value: 'set' },
          ...(current ? [{ name: 'Remove it', value: 'clear' }] : []),
          { name: 'Back', value: 'back' },
        ],
      },
    ]);

    if (action === 'back') {
      clear();
      return undefined;
    }

    if (action === 'clear') {
      clear();
      return null;
    }

    const { key } = await inquirer.prompt([
      {
        type: 'password',
        name: 'key',
        mask: '*',
        message: 'Paste your Anthropic API key (sk-ant-...):',
      },
    ]);

    clear();

    const trimmed = String(key ?? '').trim();
    // An empty answer is a change of mind, not an instruction to wipe the key
    // that is already there. Removing one is its own menu entry.
    if (trimmed.length === 0) return undefined;

    if (!trimmed.startsWith('sk-ant-')) {
      // Checked rather than rejected. The prefix is a convention and not a
      // guarantee, so this warns and stores it anyway; the alternative is
      // refusing a key that works because the format changed.
      console.log(
        `${fo('That does not look like an Anthropic key (they normally begin sk-ant-). Storing it anyway.', 'yellow')}`
      );
    }

    return trimmed;
  }

  async createProfile(): Promise<string> {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Choose an action:',
        choices: [
          { name: 'Continue', value: 'continue' },
          { name: 'Quit', value: 'quit' },
        ],
      },
    ]);

    clear();

    return action;
  }

  async removeExchange(profile: any): Promise<string> {
    const { exchange } = await inquirer.prompt([
      {
        type: 'list',
        name: 'exchange',
        message: 'Choose an exchange to remove:',
        choices: profile.exchanges.map(
          (exchangeProfile: ExchangeProfile) => exchangeProfile.exchange
        ),
      },
    ]);

    clear();

    return exchange;
  }

  async selectExchange(supportedExchanges: any): Promise<string> {
    async function searchExchanges(
      answers: Record<string, unknown>,
      input: string | null
    ) {
      input = input || '';
      return supportedExchanges.filter((exchange: string) =>
        exchange.toLowerCase().includes(input!.toLowerCase())
      );
    }

    const { exchange } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'exchange',
        message: 'Choose an exchange:',
        source: searchExchanges,
      },
    ]);

    clear();

    return exchange;
  }

  async addExchangeCredentials(credential: string, exchangeName?: string): Promise<any> {
    let message;

    // Special handling for Hyperliquid
    if (exchangeName?.toLowerCase() === 'hyperliquid') {
      if (credential === 'privateKey') {
        message = 'Enter your Private Key:';
      } else if (credential === 'walletAddress') {
        message = 'Enter your API Wallet Address:';
      } else if (credential === 'publicAddress') {
        message = 'Enter your Public Wallet Address for queries (needed to view your positions):';
      } else {
        // Skip other credential types for Hyperliquid
        return '';
      }
    } else {
      // Standard handling for other exchanges
      if (credential === 'key') {
        message = 'Enter your API Key:';
      } else if (credential === 'secret') {
        message = 'Enter your Secret:';
      }
    }

    const { [credential]: enteredCred } = await inquirer.prompt([
      {
        type: 'input',
        name: credential,
        message: message,
      },
    ]);

    clear();

    return enteredCred;
  }

  async startTradingInterface(): Promise<void> {
    this.availableMarkets =
      (await this.exchangeCommand.getExchangeClient().getMarketSymbols()) || [];

    const fatFingerLimit = this.exchangeCommand
      .getExchangeClient()
      .getFatFingerLimit();

    console.log(
      fatFingerLimit === undefined
        ? fo(
            'No fatfinger limit set — order value is unlimited. Set one with "fatfinger <amount>".',
            'yellow'
          )
        : `Fatfinger limit: ${fatFingerLimit} per order.`
    );

    // Load saved state if in dev mode and this is a reload
    if (this.isDevMode) {
      const state = await this.stateManager.loadState();
      if (state.isDevMode && state.isReload && state.currentMarket &&
          this.availableMarkets.includes(state.currentMarket)) {
        this.currentMarket = state.currentMarket;
        this.exchangeCommand.getExchangeClient().followMarket(this.currentMarket);
        console.log(`[Dev] Restored previous market: ${this.currentMarket}`);

        // Reset the reload flag for next time
        await this.stateManager.saveState({
          ...state,
          isReload: false
        });
      }
    }

    // The workspace owns the terminal from here: one repainted view rather than
    // a scrolling console, with the command line docked.
    this.workspace = new Workspace(
      this.exchangeCommand.getExchangeClient(),
      async (command: string) => {
        await this.handleCommand(command.trim());
      },
      () => this.quit(),
      // Sent through the same dispatcher as a typed 'coach ...' so that a
      // question asked at the prompt is journalled, rate-limited and answered
      // by exactly the path a typed one takes. The prompts are separate; what
      // happens after they are read should not be.
      async (question: string) => {
        await this.handleCommand(`coach ${question}`);
      }
    );

    if (this.currentMarket) {
      this.workspace.start(this.currentMarket);
    } else {
      this.workspace.start('');
    }
  }

  private async formatPriceToMarketPrecision(price: number, market: string): Promise<number> {
      try {
          const precision = await this.exchangeCommand.getExchangeClient().getMarketPrecision(market);
          const decimalPlaces = precision.toString().split('.')[1].length;
          const updatedPrice = price.toFixed(decimalPlaces);
          return Number(updatedPrice);
      } catch (error) {
          console.error('Failed to format price to market precision:', error);
          return price
      }
  }

  private processPositionSize(command: string, lastPositionSize: number): string {
    let modifiedCommand = command;

    const percentModifierMatch = command.match(/(\d+)%possize/);
    if (percentModifierMatch) {
      const percentModifier = Number(percentModifierMatch[1]) / 100;
      const adjustedPositionSize = lastPositionSize * percentModifier;
      modifiedCommand = command.replace(/(\d+)%possize/g, adjustedPositionSize.toString());
    } else if (command.includes("possize")) {
      modifiedCommand = command.replace(/possize/g, lastPositionSize.toString());
    }

    return modifiedCommand;
  }

  private replaceCommandVariable(command: string, value: number, variable: string): string {
    command = command.replace(variable, value.toString());
    console.log(command);
    return command;
  }

  // fatfinger             show the current limit
  // fatfinger <amount>    set the most a single order may be worth
  // fatfinger off         remove the limit
  /**
   * Reports a failed command by its meaning, keeping the exchange's own
   * response as a diagnostic. A raw payload in the activity feed breaks the row
   * structure and answers a question the trader wasn't asking.
   */
  private reportFailure(error: unknown): void {
    const failure = describeExchangeError(error);
    NotificationManager.diagnostic(`[command] ${failure.raw}`);
    NotificationManager.notify(failure.summary, NType.ERROR, 'ERROR');
  }

  // trail <distance>   trail that many in price behind the best price
  // trail <percent>%    trail that percentage behind
  //
  // Covers the whole position, like a stop, and is maintained by the exchange
  // rather than by this process.
  /**
   * Reports what a cancel actually did.
   *
   * These used to announce success unconditionally, so a filter that matched
   * nothing and a cancel that was refused both read as 'all orders cancelled'.
   */
  private reportCancelled(
    noun: string,
    result: { cancelled: number; failed: number }
  ): void {
    const count = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;

    if (result.failed > 0) {
      NotificationManager.notify(
        `${count(result.cancelled)} cancelled, ${result.failed} could NOT be cancelled — check the exchange.`,
        NType.ERROR,
        'ERROR'
      );
      return;
    }

    NotificationManager.notify(
      result.cancelled === 0
        ? `No ${noun}s to cancel.`
        : `${count(result.cancelled)} cancelled.`,
      NType.INFO,
      'ORDER'
    );
  }

  private async handleDelayedTrailCommand(command: string): Promise<void> {
    if (!this.currentMarket) {
      NotificationManager.notify('No market selected.', NType.ERROR, 'ERROR');
      return;
    }

    const parsed = parseDelayedTrail(command);
    if (parsed === undefined) return;
    if (isTrailSpecError(parsed)) {
      NotificationManager.notify(parsed.error, NType.ERROR, 'ERROR');
      return;
    }

    try {
      const order = await this.exchangeCommand
        .getExchangeClient()
        .createDelayedTrailOrder(
          this.currentMarket,
          parsed.stopPrice,
          parsed.size,
          parsed.trail
        );

      if (!order) {
        NotificationManager.notify('Stop was NOT placed.', NType.ERROR, 'ERROR');
      }
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async handleTrailCommand(command: string): Promise<void> {
    const arg = command.slice('trail'.length).trim();

    if (arg === '') {
      NotificationManager.notify(
        'Usage: trail 2 | trail 2% | trail 3atr [timeframe]   ' +
          'Delayed: stop <price> [size] trail <spec>, e.g. stop 97 trail 10   ' +
          'Timeframes: 1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w',
        NType.INFO,
        'SYSTEM'
      );
      return;
    }

    if (!this.currentMarket) {
      NotificationManager.notify('No market selected.', NType.ERROR, 'ERROR');
      return;
    }

    const spec = parseTrailSpec(arg);
    if (isTrailSpecError(spec)) {
      NotificationManager.notify(spec.error, NType.ERROR, 'ERROR');
      return;
    }

    try {
      const order = await this.exchangeCommand
        .getExchangeClient()
        .createTrailingStopOrder(this.currentMarket, spec);

      if (!order) {
        NotificationManager.notify(
          'Trailing stop was NOT placed.',
          NType.ERROR,
          'ERROR'
        );
      }
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async handleFatFingerCommand(command: string): Promise<void> {
    const exchangeClient = this.exchangeCommand.getExchangeClient();
    const arg = command.slice('fatfinger'.length).trim();

    if (arg === '') {
      const limit = exchangeClient.getFatFingerLimit();
      console.log(
        limit === undefined
          ? 'No fatfinger limit set. Orders of any value will be accepted. Set one with "fatfinger <amount>".'
          : `Fatfinger limit: ${limit} per order.`
      );
      return;
    }

    if (arg === 'off') {
      await exchangeClient.setFatFingerLimit(undefined);
      console.log(
        'Fatfinger limit removed. Orders of any value will now be accepted.'
      );
      return;
    }

    const limit = Number(arg);

    if (!Number.isFinite(limit) || limit <= 0) {
      console.log(
        `Invalid fatfinger amount '${arg}'. Give a number greater than 0, or "off" to remove the limit.`
      );
      return;
    }

    await exchangeClient.setFatFingerLimit(limit);
    console.log(
      `Fatfinger limit set to ${limit} per order, measured as size x price in the market's quote currency. ` +
        `Orders worth more than this are rejected before being sent.`
    );
  }


  // ==========================================================================
  // Behavioural guardrails
  // ==========================================================================

  /**
   * Whether an order the operator typed should be sent.
   *
   * Returns true to proceed. A held order is stored and the caller returns
   * without sending; the operator's next command decides its fate.
   *
   * Anything that goes wrong here allows the order. A guard that fails closed
   * would mean a slow position lookup could stop someone trading, which is a
   * far worse failure than missing one observation.
   */
  private async guardReview(
    command: string,
    type: OrderType,
    quantity: number | undefined,
    price: number | undefined
  ): Promise<boolean> {
    if (this.bypassGuardOnce) {
      this.bypassGuardOnce = false;
      return true;
    }

    const client = this.exchangeCommand.getExchangeClient();

    try {
      const proposal = await this.proposalFor(type, quantity, price);
      if (!proposal) return true;

      const verdict = await client.reviewProposal(proposal);

      if (verdict.action === 'allow') {
        // A notice is worth one line next to the order it is about, and no
        // more than that.
        if (verdict.headline) {
          ActivityLog.getInstance().add('WARNING', verdict.headline);
        }
        return true;
      }

      if (verdict.action === 'refuse') {
        NotificationManager.notify(
          `${verdict.headline} No order was placed.`,
          NType.ERROR,
          'ERROR'
        );
        return false;
      }

      this.holdOrder(command, verdict, proposal);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * The order, described the way the guard needs to see it.
   *
   * The intent is worked out from the position rather than from the words: a
   * 'sell' is an exit when there is a long open and an entry when there is not,
   * and the guard must never obstruct the first case.
   */
  private async proposalFor(
    type: OrderType,
    quantity: number | undefined,
    price: number | undefined
  ): Promise<OrderProposal | undefined> {
    if (quantity === undefined || !(quantity > 0)) return undefined;

    let side: 'buy' | 'sell';
    switch (type) {
      case OrderType.MARKET_BUY:
      case OrderType.LIMIT_BUY:
        side = 'buy';
        break;
      case OrderType.MARKET_SELL:
      case OrderType.LIMIT_SELL:
        side = 'sell';
        break;
      case OrderType.STOP:
        // A stop is protection, whichever way it points.
        return {
          market: this.currentMarket,
          side: 'sell',
          intent: 'protective',
          size: quantity,
          price,
        };
      default:
        return undefined;
    }

    const position = await this.exchangeCommand
      .getExchangeClient()
      .getPositionView(this.currentMarket)
      .catch(() => null);

    const opposing =
      position !== null &&
      position.size > 0 &&
      ((position.side.toLowerCase() === 'long' && side === 'sell') ||
        (position.side.toLowerCase() === 'short' && side === 'buy'));

    return {
      market: this.currentMarket,
      side,
      intent: opposing ? 'exit' : 'entry',
      size: quantity,
      price,
    };
  }

  /** Puts a held order on screen and waits for the next command. */
  private holdOrder(command: string, verdict: GuardVerdict, proposal: OrderProposal): void {
    this.pendingOrder = {
      command,
      verdict,
      market: this.currentMarket,
      at: Date.now(),
    };

    const value =
      proposal.price !== undefined ? proposal.size * proposal.price : undefined;

    this.workspace?.showConfirmation({
      action: `${proposal.side.toUpperCase()} ${
        proposal.price === undefined ? 'MARKET' : 'LIMIT'
      }`,
      size: String(proposal.size),
      estimatedValue: value === undefined ? '--' : value.toFixed(2),
      estimatedFee: '--',
      warning: verdict.headline,
      prompt: "'y' to send anyway, anything else cancels",
    });

    NotificationManager.notify(
      `HELD — ${verdict.headline} Type 'y' to send it anyway, anything else cancels.`,
      NType.ERROR,
      'WARNING'
    );

    // The coach's wording arrives afterwards if it arrives at all. Waiting for
    // it would put a network call between a keystroke and the panel.
    const guard = this.exchangeCommand.getExchangeClient().getGuard();
    const leading = verdict.findings[0];
    if (leading && guard.coachAvailable()) {
      void guard
        .phraseFor(leading)
        .then((phrase) => {
          if (this.pendingOrder && phrase !== leading.detail) {
            ActivityLog.getInstance().add('WARNING', phrase);
          }
        })
        .catch(() => undefined);
    }
  }

  /**
   * The operator's answer to a held order.
   *
   * Returns true when the input was consumed as an answer, so the caller knows
   * not to also run it as a command. Only 'y' sends; everything else cancels
   * the held order and then runs normally, which means an operator who has
   * changed their mind and typed 'cancel all' gets exactly that.
   */
  private async resolvePending(command: string): Promise<boolean> {
    const pending = this.pendingOrder;
    if (!pending) return false;

    this.pendingOrder = null;
    this.workspace?.showConfirmation(null);

    const answer = command.trim().toLowerCase();

    if (answer !== 'y' && answer !== 'yes') {
      NotificationManager.notify(
        `Held order cancelled: ${pending.command}`,
        NType.INFO,
        'ORDER'
      );
      return answer === 'n' || answer === 'no';
    }

    // On the record. A guard that is overridden every single time is either
    // wrong or being treated as a formality, and the debrief can only say so
    // if the overrides were counted.
    const guard = this.exchangeCommand.getExchangeClient().getGuard();
    for (const finding of pending.verdict.findings) {
      guard.recordOverride(pending.market, finding.behaviour.id);
    }

    NotificationManager.notify(`Sending anyway: ${pending.command}`, NType.INFO, 'ORDER');

    this.bypassGuardOnce = true;
    await this.handleCommand(pending.command);
    return true;
  }

  private bypassGuardOnce = false;

  /**
   * coach <question>   ask about the session, in the coach panel
   * coach              write the debrief
   * coach clear        empty the thread
   *
   * The one command here that talks to a model on purpose, rather than as an
   * improvement on wording that already existed. It answers in the panel rather
   * than the activity log: a hundred and twenty words of prose in a column of
   * timestamped events is unreadable, and it evicts the events besides.
   */
  private async handleCoachCommand(command: string): Promise<void> {
    const guard = this.exchangeCommand.getExchangeClient().getGuard();
    const thread = guard.getThread();
    const question = command.trim().slice('coach'.length).trim();

    if (question.toLowerCase() === 'clear') {
      thread.clear();
      this.workspace?.showCoach();
      return;
    }

    if (!guard.coachAvailable()) {
      thread.note(
        "No coach configured. Add a key under 'AI Coach Key' on the home menu; " +
          "'guard' on its own always works without one."
      );
      this.workspace?.showCoach();
      return;
    }

    // Bare 'coach' is the debrief, which is a different call: it weighs the
    // whole session rather than answering a question about it.
    if (question.length === 0) {
      thread.note('Writing the debrief...');
      this.workspace?.showCoach();

      const written = await guard.debrief().catch(() => undefined);
      if (written && written.length > 0) thread.speak(written);
      else thread.note('Nothing to say about this session yet.');
      this.workspace?.showCoach();
      return;
    }

    // Painted before the call goes out, so the panel shows what was asked while
    // the answer is still being written. Not awaited by the command loop: a
    // model call must never be between the operator and the next command.
    void thread
      .ask(question)
      .then(() => this.workspace?.showCoach())
      .catch(() => undefined);

    this.workspace?.showCoach();
  }

  /**
   * guard                     where the session stands
   * guard on | off            the whole system
   * guard explain <id>        what a behaviour means and why it is checked
   * guard limit <amount>      daily loss limit — the one rule that refuses
   * guard limit off
   * guard mute <id>           stop checking one behaviour
   * guard unmute <id>
   * guard severity <id> <notice|hold|block>
   * guard autoexit <id>       let the guard close a position on this behaviour
   * guard autoexit off
   * guard unlock              lift a lockout, deliberately and on the record
   * guard exit [now]          run a worked exit on the current position
   * guard exit stop
   * guard debrief             what the session looked like (an alias for 'coach')
   */
  private async handleGuardCommand(command: string): Promise<void> {
    const client = this.exchangeCommand.getExchangeClient();
    const guard = client.getGuard();
    const words = command.trim().split(/\s+/).slice(1);
    const [verb, first, second] = words;
    const policy = { ...guard.getPolicy() };

    const save = async () => {
      await client.saveGuardPolicy(policy);
      NotificationManager.notify('Guardrails updated.', NType.SUCCESS, 'SYSTEM');
    };

    if (verb === undefined) {
      for (const line of guard.status()) console.log(line);
      return;
    }

    switch (verb.toLowerCase()) {
      case 'on':
      case 'off':
        policy.enabled = verb.toLowerCase() === 'on';
        await save();
        return;

      case 'explain': {
        if (!first || !isBehaviourId(first)) {
          console.log(`Name a behaviour: ${ALL_BEHAVIOUR_IDS.join(', ')}`);
          return;
        }
        console.log(guard.explain(first));
        return;
      }

      case 'limit': {
        if (first === undefined) {
          console.log(
            policy.dailyLossLimit === undefined
              ? 'No daily loss limit set.'
              : `Daily loss limit: ${policy.dailyLossLimit}`
          );
          return;
        }
        if (first.toLowerCase() === 'off') {
          policy.dailyLossLimit = undefined;
          await save();
          return;
        }
        const amount = Number(first);
        if (!Number.isFinite(amount) || amount <= 0) {
          console.log(`'${first}' is not a usable loss limit.`);
          return;
        }
        policy.dailyLossLimit = amount;
        await save();
        return;
      }

      case 'mute':
      case 'unmute': {
        if (!first || !isBehaviourId(first)) {
          console.log(`Name a behaviour: ${ALL_BEHAVIOUR_IDS.join(', ')}`);
          return;
        }
        policy.muted =
          verb.toLowerCase() === 'mute'
            ? [...new Set([...policy.muted, first])]
            : policy.muted.filter((id) => id !== first);
        await save();
        return;
      }

      case 'severity': {
        if (!first || !isBehaviourId(first)) {
          console.log(`Name a behaviour: ${ALL_BEHAVIOUR_IDS.join(', ')}`);
          return;
        }
        if (second !== 'notice' && second !== 'hold' && second !== 'block') {
          console.log("Give a severity: notice, hold, or block.");
          return;
        }
        policy.severity = { ...policy.severity, [first]: second };
        await save();
        return;
      }

      case 'autoexit': {
        if (first === undefined) {
          console.log(
            policy.autoExit.length === 0
              ? 'Nothing may close a position automatically.'
              : `Will close positions on: ${policy.autoExit.join(', ')}`
          );
          return;
        }
        if (first.toLowerCase() === 'off') {
          policy.autoExit = [];
          await save();
          return;
        }
        if (!isBehaviourId(first)) {
          console.log(`Name a behaviour: ${ALL_BEHAVIOUR_IDS.join(', ')}`);
          return;
        }
        policy.autoExit = [...new Set([...policy.autoExit, first])];
        // Worth spelling out. This is the only setting that lets the software
        // send an order nobody typed.
        NotificationManager.notify(
          `Tame will now close the position by itself when '${first}' fires. ` +
            `Turn it off with 'guard autoexit off'.`,
          NType.ERROR,
          'WARNING'
        );
        await save();
        return;
      }

      case 'unlock': {
        const lockout = guard.lockedOut();
        if (!lockout) {
          console.log('Nothing is locked out.');
          return;
        }
        guard.liftLockout('lifted by the operator');
        NotificationManager.notify(
          'Lockout lifted. It is on the record.',
          NType.INFO,
          'SYSTEM'
        );
        return;
      }

      case 'exit': {
        if (first?.toLowerCase() === 'stop') {
          console.log(
            client.abortAssistedExit()
              ? 'Stopping the exit. Anything already resting stays where it is.'
              : 'No exit is running.'
          );
          return;
        }
        if (!this.currentMarket) {
          console.log('No market selected.');
          return;
        }
        const urgency =
          first?.toLowerCase() === 'now'
            ? 'immediate'
            : first?.toLowerCase() === 'firm'
              ? 'firm'
              : 'measured';
        const built = await client.buildExitPlan(this.currentMarket, urgency);
        if (!built) {
          console.log('No position to exit.');
          return;
        }
        await client.runExitPlan(this.currentMarket, built.side, built.plan);
        return;
      }

      // Kept as an alias now that the coach has a panel of its own. Routing it
      // through the same handler is what stops the debrief appearing in two
      // different places depending on which word the operator reached for.
      case 'debrief':
        await this.handleCoachCommand('coach');
        return;

      default:
        console.log(
          "guard | on | off | explain <id> | limit <amount> | mute <id> | severity <id> <level> | " +
            'autoexit <id> | unlock | exit [now|firm|stop] | debrief'
        );
    }
  }

  private async handleCommand(command: string) {
    // Recorded first, as typed, before substitution and before anything is
    // dispatched. The intention is the part worth keeping: 'trail 3atr 15m arm
    // 96.2' says what was wanted, and the stop it eventually produces does not
    // -- a reader given only the resulting order has to infer the plan, and a
    // command that was refused leaves no order to infer anything from at all.
    //
    // Best-effort, and outside anything that can stop the command running: a
    // failure to write the record must never be a failure to trade.
    try {
      this.exchangeCommand
        .getExchangeClient()
        .getGuard()
        .recordCommand(command, { market: this.currentMarket });
    } catch {
      // No guard, or no journal. The command proceeds either way.
    }

    // A held order is answered before anything else is read. 'y' sends it;
    // 'n' cancels and stops there; anything else cancels it and then runs as
    // the command it is -- so an operator who has changed their mind and typed
    // 'cancel all' gets exactly that, and not a surprise entry.
    if (this.pendingOrder && (await this.resolvePending(command))) return;

    if (command.startsWith('print')) {
      if (command.includes('possize')) {
        const positionSize = await this.exchangeCommand
          .getExchangeClient()
          .getPositionSize(this.currentMarket);
        console.log(positionSize);
      } else if (command.includes('entry')) {
        this.entryPrice = await this.exchangeCommand
          .getExchangeClient()
          .getEntryPrice(this.currentMarket) ?? null;
        if (this.entryPrice !== null) {
          this.entryPrice = await this.formatPriceToMarketPrecision(this.entryPrice, this.currentMarket);
        } else {
          this.entryPrice = null;
        }
        console.log(this.entryPrice);
      }  else if (command.includes('precision')) {
        const precision = await this.exchangeCommand
          .getExchangeClient()
          .getMarketPrecision(this.currentMarket);
        console.log(precision);
      }

      return;
    }

    if (command.includes("possize")) {
      // Replace 'possize' with the latest position size
      this.lastPositionSize = await this.exchangeCommand
        .getExchangeClient()
        .getPositionSize(this.currentMarket);
      // If the position size is zero, throw an error and do not proceed

      if (this.lastPositionSize === 0) {
        console.log('Error: Cannot execute an order with a position size of zero.');
        return;
      }

      // Replace all instances of 'possize' with the actual position size
      command = this.processPositionSize(command, this.lastPositionSize);
    }

    if (command.includes("entry")) {
      this.entryPrice = await this.exchangeCommand
          .getExchangeClient()
          .getEntryPrice(this.currentMarket) ?? null;

      if (this.entryPrice === null) {
        console.log('Error: Cannot execute an order with an entry price of null.');
        return;
      }

      this.entryPrice = await this.formatPriceToMarketPrecision(this.entryPrice, this.currentMarket);

      if (this.entryPrice === 0) {
        console.log('Error: Cannot execute an order with an entry price of zero.');
        return;
      }

      if (this.entryPrice !== null) {
        command = this.replaceCommandVariable(command, this.entryPrice, 'entry');
      }
    }
    if (command === 'list methods') {
      this.displayAvailableMethods();
    } else if (command.startsWith('stop ') && / trail\b/.test(command)) {
      await this.handleDelayedTrailCommand(command);
    } else if (command === 'trail' || command.startsWith('trail ')) {
      await this.handleTrailCommand(command);
    } else if (command === 'fatfinger' || command.startsWith('fatfinger ')) {
      await this.handleFatFingerCommand(command);
    } else if (command === 'coach' || command.startsWith('coach ')) {
      await this.handleCoachCommand(command);
    } else if (command === 'guard' || command.startsWith('guard ')) {
      await this.handleGuardCommand(command);
    } else if (command.startsWith('market')) {
      const market = command.split(' ')[1];
      if (this.availableMarkets.includes(market)) {
        this.currentMarket = market;
        this.exchangeCommand.getExchangeClient().followMarket(market);
        this.workspace?.setMarket(market);
        ActivityLog.getInstance().add('MARKET', `${market.split(':')[0]} selected`);

        // Save state for dev mode
        await this.saveDevState();
      } else {
        console.log(`Invalid market: ${market}`);
      }
    } else if (command.startsWith('watch')) {
      const commandParts = command.split(' ');

      if (commandParts.length === 3 && commandParts[2] === 'orderbook') {
        const market = commandParts[1];

        if (this.availableMarkets.includes(market)) {
          try {
            await this.exchangeCommand
              .getExchangeClient()
              .watchOrderBook(market);
          } catch (error: unknown) {
            this.reportFailure(error);
          }
        } else {
          console.log(`Invalid market: ${market}`);
        }
      } else {
        console.log('Invalid command format. Usage: watch [symbol] orderbook');
      }
    } else if (command === 'list markets') {
      const marketType = await this.selectMarketType();
      this.currentMarket = await this.selectMarketByType(marketType);

      if (this.currentMarket && this.currentMarket !== 'back') {
        this.exchangeCommand.getExchangeClient().followMarket(this.currentMarket);
      }

      // Save state for dev mode
      if (this.currentMarket && this.currentMarket !== 'back') {
        await this.saveDevState();
      }
    } else if (command === 'get market structure') {
      if (this.currentMarket.length > 0) {
        this.exchangeCommand
          .getExchangeClient()
          .getMarketStructure(this.currentMarket);
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel all') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllOrders(this.currentMarket)
            .then((result) => this.reportCancelled('order', result));
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel limits') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllLimitOrders(this.currentMarket)
            .then((result) => this.reportCancelled('limit order', result));
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'close position') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .closePosition(this.currentMarket);
          console.log('Position closed');
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command === 'cancel stops') {
      if (this.currentMarket) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelAllStopOrders(this.currentMarket)
            .then((result) => this.reportCancelled('stop order', result));
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('No market selected. Please select a market first.');
      }
    } else if (command.startsWith('bump')) {
      // Accepts 'bump +10', 'bump + 10', 'bump -10', 'bump - 10' and 'bump 10'.
      const bumpRegex = /^bump\s+([-+])?\s*(\d*\.?\d+)/;
      const match = command.match(bumpRegex);
      if (match) {
        const priceChange = parseFloat(`${match[1] ?? ''}${match[2]}`);
        if (this.currentMarket) {
          try {
            await this.exchangeCommand
              .getExchangeClient()
              .bumpOrders(this.currentMarket, priceChange);
            console.log(`All orders have been bumped by ${priceChange}.`);
          } catch (error: unknown) {
            this.reportFailure(error);
          }
        } else {
          console.log('No market selected. Please select a market first.');
        }
      } else {
        console.log(
          'Invalid bump command format. Use "bump + [value]" or "bump - [value]".'
        );
      }
    } else if (command.startsWith('cancel orders')) {
      const regex = /^cancel orders\s*(top|bottom)?\s*(\d+)?(\:)?(\d+)?$/;
      const match = command.match(regex);
      if (match) {
        const [, direction, rangeStartStr, colon, rangeEndStr] = match;
        let rangeStart: number | undefined;
        let rangeEnd: number | undefined;

        if (rangeStartStr !== undefined) {
          rangeStart = parseInt(rangeStartStr, 10);
          if (colon !== undefined && rangeEndStr !== undefined) {
            rangeEnd = parseInt(rangeEndStr, 10);
          } else {
            rangeEnd = rangeStart;
          }
        }

        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelOrdersByDirection(
              this.currentMarket,
              direction || 'top',
              rangeStart,
              rangeEnd
            );
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log(
          'Invalid command format. Usage: cancel orders [top | bottom] [start:end | specific order]'
        );
      }
    } else if (
      command.startsWith('range buy') ||
      command.startsWith('range sell')
    ) {
      const commandParts = command.split(' ');
      const action = commandParts[1];
      const market = this.currentMarket;
      const questions = [
        {
          type: 'number',
          name: 'startPrice',
          message: 'Enter the start price:',
        },
        {
          type: 'number',
          name: 'endPrice',
          message: 'Enter the end price:',
        },
        {
          type: 'number',
          name: 'numOrders',
          message: 'Enter the number of orders:',
        },
        {
          type: 'number',
          name: 'totalRiskPercentage',
          message: 'Enter the total risk percentage:',
        },
        {
          type: 'number',
          name: 'stopPrice',
          message: 'Enter the stop price:',
        },
        {
          type: 'number',
          name: 'takeProfitPrice',
          message: 'Enter the take profit price:',
        },
        {
          type: 'number',
          name: 'totalCapitalToRisk',
          message: 'Enter the total capital to risk:',
        },
        {
          type: 'number',
          name: 'riskReturnRatioThreshold',
          message: 'Enter the risk-return ratio threshold:',
        },
      ];

      const answers = await inquirer.prompt(questions);

      if (
        market &&
        answers.startPrice &&
        answers.endPrice &&
        answers.numOrders &&
        answers.totalRiskPercentage &&
        answers.stopPrice &&
        answers.takeProfitPrice &&
        answers.totalCapitalToRisk &&
        answers.riskReturnRatioThreshold
      ) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .submitRangeOrders(
              action,
              market,
              answers.startPrice,
              answers.endPrice,
              answers.numOrders,
              answers.totalRiskPercentage,
              answers.stopPrice,
              answers.takeProfitPrice,
              answers.totalCapitalToRisk,
              answers.riskReturnRatioThreshold
            );
          console.log(
            `Range ${action} orders placed between ${answers.startPrice} and ${answers.endPrice}`
          );
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log(
          'Invalid range command format. Usage: range [buy/sell] [startPrice] [endPrice] [numOrders] [risk%] [stopPrice] [takeProfitPrice] [totalCapitalToRisk] [riskReturnRatioThreshold]'
        );
      }
    } else if (
      command.startsWith('chase buy') ||
      command.startsWith('chase sell')
    ) {
      const commandParts = command.split(' ');
      const action = commandParts[1];
      const market = this.currentMarket;
      const amount = parseFloat(commandParts[2]);
      const decay = commandParts[3] ? commandParts[3] : undefined;

      if (
        !this.exchangeCommand.getExchangeClient().getChaseLimitOrderStatus()
      ) {
        if (market && amount) {
          try {
            const orderId = await this.exchangeCommand
              .getExchangeClient()
              .chaseLimitOrder(market, action, amount, decay);
            if (orderId) {
              this.chaseOrderId = orderId;
            } else {
              throw new Error('orderId is undefined');
            }
          } catch (error: unknown) {
            this.reportFailure(error);
          }
        } else {
          console.log(
            'Invalid chase command format. Usage: chase [buy/sell] [amount]'
          );
        }
      } else {
        console.log('Chase order already active.');
      }
    } else if (command.startsWith('cancel chase')) {
      if (
        this.chaseOrderId !== undefined &&
        this.exchangeCommand.getExchangeClient().getChaseLimitOrderStatus()
      ) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .cancelChaseOrder(this.chaseOrderId, this.currentMarket);
        } catch (error: unknown) {
          this.reportFailure(error);
        }
        this.chaseOrderId = '';
      } else {
        console.log('No chase orders active.');
      }
    } else if (
      command.startsWith('bracket buy') ||
      command.startsWith('bracket sell')
    ) {
      const side = command.split(' ')[1];
      const entryPrice = parseFloat(command.split(' ')[2]);
      const stopPrice = parseFloat(command.split(' ')[3]);

      const questions = [
        {
          type: 'number',
          name: 'capitalToRisk',
          message: 'Enter the amount of capital you want to risk:',
        },
        {
          type: 'number',
          name: 'riskPercentage',
          message: 'Enter the percentage of capital you want to risk:',
        },
      ];

      const answers = await inquirer.prompt(questions);

      if (
        answers.capitalToRisk &&
        answers.riskPercentage &&
        stopPrice &&
        entryPrice
      ) {
        try {
          await this.exchangeCommand
            .getExchangeClient()
            .createBracketLimitOrder(
              this.currentMarket,
              side,
              answers.capitalToRisk,
              answers.riskPercentage,
              stopPrice,
              entryPrice
            );
        } catch (error: unknown) {
          this.reportFailure(error);
        }
      } else {
        console.log('Invalid bracket command format. Please try again.');
      }
    } else if (command.startsWith('move stop')) {
      const parts = command.split(' ');
      if (parts.length === 3 && this.currentMarket) {
        const newStopPrice = parseFloat(parts[2]);
        if (!isNaN(newStopPrice)) {
          try {
              const currentStopOrderId = await this.exchangeCommand
                .getExchangeClient()
                .editCurrentStopOrder(this.currentMarket, newStopPrice);

              // 'processed' was reported whether or not anything moved, so a
              // failed move read as a successful one.
              if (currentStopOrderId) {
                const client = this.exchangeCommand.getExchangeClient();
                const position = await client
                  .getPositionView(this.currentMarket)
                  .catch(() => null);

                // The protective side is the one that closes the position.
                const side =
                  position?.side === 'LONG'
                    ? 'SELL'
                    : position?.side === 'SHORT'
                    ? 'BUY'
                    : undefined;

                NotificationManager.notify('', NType.SUCCESS, 'ORDER', undefined, {
                  side,
                  quantity: 'ALL',
                  price: client.formatPriceForDisplay(this.currentMarket, newStopPrice),
                  status: 'STOP UPDATED',
                });
              } else {
                NotificationManager.notify(
                  'No stop order found to move',
                  NType.ERROR,
                  'ERROR',
                  undefined,
                  { side: 'STOP', status: 'REJECTED' }
                );
              }
          } catch (error) {
              const failure = describeExchangeError(error);
              console.error(`[userInterface/move stop] ${failure.raw}`);
              NotificationManager.notify(failure.summary, NType.ERROR, 'ERROR', undefined, {
                side: 'STOP',
                status: 'REJECTED',
              });
          }
        } else {
          console.log('Invalid price format.');
        }
      } else {
        console.log('Usage: move stop <new stop price>');
      }
    } else if (command.startsWith('update stop')) {
      const parts = command.split(' ');
      let amount: number | undefined;
      if (parts.length > 3 || parts.length < 2) {
          console.log('Usage: update stop <amount>');
          return;
      }

      if (parts[1] !== 'stop') {
          console.log('Invalid command. Only stop order can be updated.');
          return;
      }

      if (parts.length === 3) {
          amount = parseFloat(parts[2]);
          if (isNaN(amount)) {
              console.log('Invalid amount. Amount should be a number.');
              return;
          }
      }

      try {
        if(amount !== undefined) {
          await this.exchangeCommand.getExchangeClient().updateStopOrder(this.currentMarket, amount);
          console.log(`Stop order updated with amount: ${amount}`);
        } else {
          await this.exchangeCommand.getExchangeClient().updateStopOrder(this.currentMarket);
          console.log('Stop order updated.');
        }
      } catch (error: unknown) {
          this.reportFailure(error);
      }
    } else if (this.currentMarket) {
      try {
        const commandParams = await OrderType.parseCommand(command);
        if (commandParams !== null) {
          const { type, quantity, price } = commandParams;

          // The last thing between a typed order and the exchange. It can
          // hold the order or refuse it; it can never alter it.
          const cleared = await this.guardReview(
            command,
            type,
            quantity === undefined ? undefined : Number(quantity),
            price === undefined ? undefined : Number(price)
          );

          if (!cleared) return;

          if (
            type === OrderType.MARKET_BUY ||
            type === OrderType.MARKET_SELL
          ) {
            await this.exchangeCommand.execute(type, this.currentMarket, {
              quantity: Number(quantity),
            });
          } else if (
            type === OrderType.STOP ||
            type === OrderType.LIMIT_BUY ||
            type === OrderType.LIMIT_SELL
          ) {
            await this.exchangeCommand.execute(type, this.currentMarket, {
              price: Number(price),
              ...(quantity !== undefined
                ? { quantity: Number(quantity) }
                : {}),
            });
          }
        }
      } catch (error: unknown) {
        this.reportFailure(error);
      }
    } else {
      console.log('No market selected. Please select a market first.');
    }

    if (command === 'quit' || command === 'q') {
      // Clear dev state before quitting
      if (this.isDevMode) {
        await this.stateManager.clearState();
      }
      this.quit();
    }

  }

  private async selectMarketType(): Promise<string | undefined> {
    const availableTypes = await this.exchangeCommand
      .getExchangeClient()
      .getMarketTypes();

    const { marketType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'marketType',
        message: 'Select market type:',
        choices: [
          ...Array.from(availableTypes),
          { name: 'Back', value: 'back' },
        ],
      },
    ]);

    clear();

    if (marketType === 'back') {
      return;
    } else {
      return marketType;
    }
  }

  private async selectMarketByType(
    marketType: string | undefined
  ): Promise<string> {
    if (marketType === undefined) {
      return 'back';
    }

    const marketsByType = await this.exchangeCommand
      .getExchangeClient()
      .getMarketByType(marketType);

    async function searchMarkets(
      answers: Record<string, unknown>,
      input: string | null
    ) {
      input = input || '';
      return marketsByType.filter((market) =>
        market.toLowerCase().includes(input!.toLowerCase())
      );
    }

    const { market } = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'market',
        message: 'Select market:',
        source: searchMarkets,
      },
    ]);

    clear();

    return market;
  }

  public async displayAvailableMethods(): Promise<void> {
    const methods = this.exchangeCommand.getAvailableMethods();
    Object.keys(methods)
      .sort()
      .forEach((key) => {
        const temp = methods[key];
        delete methods[key];
        methods[key] = temp;
      });
    console.log('Available methods:');
    for (const [method, availability] of Object.entries(methods)) {
      if (availability) {
        console.log(`- ${method}`);
      }
    }
  }

  quit() {
    releaseInstanceLock();
    this.workspace?.stop();
    console.log('Exiting...');
    // Give time for readline to clean up
    setTimeout(() => {
      process.exit(0);
    }, 50);
  }
}
