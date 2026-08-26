// src/guard/coach.ts
//
// The part that talks.
//
// Everything else in this directory is deterministic: the detectors measure,
// the policy decides, and both are testable line by line. That is a deliberate
// division and this file is on the other side of it. A model is asked to write
// about what was measured -- never to decide whether something was measured,
// and never to decide what happens about it.
//
// The reason is latency and trust in equal parts. An order cannot wait on a
// network call, so nothing here is ever in the path of one; and a guard whose
// findings vary run to run cannot be argued with, so the findings are fixed
// before this file sees them. What is left is the thing a model is actually
// better at than a lookup table: saying the true thing in a way that lands,
// at the moment it is worth hearing.
//
// It is optional. With no credentials configured every method here returns
// undefined and the canned wording from the catalogue is used instead. The
// guardrails work without it; they are just blunter.

import Anthropic from '@anthropic-ai/sdk';

import { Finding } from './guardrails.js';
import { SessionSnapshot } from './sessionJournal.js';

const MODEL = 'claude-opus-5';

/**
 * The brief, held constant so it caches.
 *
 * Prompt caching is a prefix match, so anything that varies per call has to go
 * after this and none of it may leak in. That is also why the session's numbers
 * are passed as a JSON block in the user turn rather than interpolated into
 * these instructions.
 */
const SYSTEM = `You are a trading-discipline coach built into Tame, a terminal trading client.

You are shown facts recorded by the client's own journal: completed trades, realized PnL, order and cancel counts, and any guardrails that fired. You never see the market, and you have no opinion about it.

Hard rules:
- Never give trading advice. No entries, no exits, no price levels, no directional views, no opinions about instruments. If the facts invite it, decline the invitation.
- Speak only about process: pace, size discipline, stop discipline, whether the operator's own rules were kept.
- Cite the operator's actual numbers. "Three entries in six minutes" beats "you traded too fast".
- Do not moralise, catastrophise, or praise. The operator is an adult who is paying for accuracy, not encouragement.
- Do not hedge with therapeutic language. No "it's okay", no "remember to be kind to yourself".
- When the session was disciplined, say so plainly and briefly. Do not invent a problem to have something to report.
- Never speculate about the operator's emotional state as fact. "The pattern is consistent with X" is honest; "you were tilted" is not something the journal can show.

Style: plain sentences, second person, no lists unless there are genuinely separate items, no headings. British spelling. Brevity is the point — an operator reads this between trades.`;

/** One side of the coach thread, as the panel and the model both see it. */
export interface ThreadTurn {
  role: 'operator' | 'coach';
  text: string;
}

export interface CoachOptions {
  apiKey?: string;
  model?: string;
  /** Off switch that does not require removing credentials. */
  enabled?: boolean;
}

/**
 * What the model is allowed to see.
 *
 * Assembled explicitly rather than by handing over the snapshot, so that adding
 * a field to the journal later cannot silently start sending it. Nothing here
 * identifies the operator or their account.
 */
function facts(snapshot: SessionSnapshot, findings: Finding[]): string {
  const trades = snapshot.trades.map((trade) => ({
    market: trade.market.split(':')[0],
    side: trade.side,
    heldMs: trade.closedAt - trade.openedAt,
    pnl: Number(trade.realizedPnl.toFixed(2)),
  }));

  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const average = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  return JSON.stringify(
    {
      currency: snapshot.currency,
      sessionMinutes: Math.round((snapshot.now - snapshot.startedAt) / 60_000),
      realizedPnl: Number(snapshot.realizedPnl.toFixed(2)),
      openingEquity: snapshot.openingEquity,
      peakEquity: snapshot.peakEquity,
      currentEquity: snapshot.equity,
      roundTrips: trades.length,
      wins: wins.length,
      losses: losses.length,
      averageWin: Number(average(wins.map((t) => t.pnl)).toFixed(2)),
      averageLoss: Number(average(losses.map((t) => t.pnl)).toFixed(2)),
      // The asymmetry between how long winners and losers are held is the one
      // statistic that most reliably shows cutting winners and running losers,
      // and it is invisible in a PnL total.
      averageHoldWinsMs: Math.round(average(wins.map((t) => t.heldMs))),
      averageHoldLossesMs: Math.round(average(losses.map((t) => t.heldMs))),
      longestLosingStreak: snapshot.consecutiveLosses,
      ordersPlaced: snapshot.ordersPlaced,
      ordersCancelled: snapshot.ordersCancelled,
      fills: snapshot.fills,
      trades,
      guardrailsFired: findings.map((finding) => ({
        behaviour: finding.behaviour.id,
        severity: finding.severity,
        detail: finding.detail,
      })),
      // What was said and ignored is the most useful signal in the file: a
      // guard that is overridden every time is either wrong or being used as a
      // formality, and both are worth naming.
      overridden: snapshot.overrides.map((override) => override.behaviour),
      flagsRaisedThisSession: snapshot.flags.map((flag) => flag.behaviour),
    },
    null,
    1
  );
}

/** Where the key in use came from, or why there isn't one. */
export type KeySource = 'profile' | 'environment' | 'none' | 'rejected';

export class Coach {
  private client: Anthropic | undefined;
  private model: string;
  private enabled: boolean;
  private source: KeySource = 'none';

  constructor(options: CoachOptions = {}) {
    this.model = options.model ?? MODEL;
    this.enabled = options.enabled !== false;
    this.useKey(options.apiKey);
  }

  /**
   * Adopts a key, which is normally found after this object already exists.
   *
   * The profile is read from disk well after the guard is constructed -- the
   * guard has to be able to record from the very first fill, so it cannot wait
   * on a file -- and the coach has to be able to come to life at that point.
   *
   * Rebuilt in place rather than replaced. The thread holds a reference to this
   * object, and swapping the coach out from under it would leave it talking to
   * the previous one for the rest of the session.
   *
   * A key stored in the profile beats one exported in the shell. Someone who
   * has just typed a key into this application is entitled to expect that to be
   * the key it uses, and a stale export is much the harder of the two to
   * notice: it fails by quietly working with the wrong account.
   */
  useKey(key: string | undefined): void {
    const stored = key?.trim();
    const exported = process.env.ANTHROPIC_API_KEY?.trim();
    const resolved = stored || exported;

    // No key, no coach. Constructing the client anyway and discovering the
    // problem on the first call would put the failure in front of the operator
    // at the least useful moment.
    this.source = !resolved ? 'none' : stored ? 'profile' : 'environment';
    this.client = resolved && this.enabled ? new Anthropic({ apiKey: resolved }) : undefined;
  }

  /** Where the key came from, so the status line can name it. */
  keySource(): KeySource {
    return this.source;
  }

  available(): boolean {
    return this.client !== undefined;
  }

  /**
   * What the session looked like, once it is over or paused.
   *
   * The one place a model is worth the round trip: a debrief has to weigh a
   * dozen numbers against each other and say the two things that matter, which
   * is exactly what a template cannot do.
   */
  async debrief(snapshot: SessionSnapshot, findings: Finding[] = []): Promise<string | undefined> {
    if (!this.client) return undefined;

    if (snapshot.trades.length === 0 && findings.length === 0) {
      // Nothing happened. Spending a call to be told so is not a service.
      return undefined;
    }

    return this.ask(
      `Here is the session's journal.\n\n${facts(snapshot, findings)}\n\n` +
        `Write the debrief: at most 120 words. Lead with the one thing that most ` +
        `affected the outcome. If the guardrails fired and were overridden, say what ` +
        `happened next according to the journal, without implying causation the data ` +
        `does not show.`,
      600
    );
  }

  /**
   * One line to put in front of an order that is being held.
   *
   * Falls back to the catalogue's own wording whenever this is unavailable or
   * slow, which is why the caller must treat it as an improvement rather than
   * as the message. It is called before a confirmation is displayed, never
   * before an order is sent.
   */
  async speakTo(finding: Finding, snapshot: SessionSnapshot): Promise<string | undefined> {
    if (!this.client) return undefined;

    return this.ask(
      `A guardrail is holding an order. The measurement is fixed and correct; ` +
        `do not re-judge it.\n\n` +
        `Behaviour: ${finding.behaviour.id}\n` +
        `What was measured: ${finding.detail}\n` +
        `Why it matters: ${finding.behaviour.why}\n\n` +
        `Session so far:\n${facts(snapshot, [])}\n\n` +
        `Write one sentence, at most 25 words, for the confirmation panel. State the ` +
        `specific fact and stop. No question, no advice, no encouragement.`,
      200
    );
  }

  /**
   * A question the operator actually asked, with the thread behind it.
   *
   * The one place the coach is not reacting to a measurement. Everything else
   * in this file is triggered by the guardrails; this is triggered by someone
   * typing, which means the question can be about anything -- including things
   * the coach must refuse. The system prompt already forbids trading advice and
   * that rule is not restated here: repeating a prohibition in the turn tends to
   * produce a reply that argues with itself about whether it may answer, rather
   * than one that simply answers what it can.
   *
   * History is passed as plain turns with no facts attached. Only the newest
   * turn carries the session numbers, because the numbers move: a thread three
   * questions long would otherwise contain three contradictory equity figures
   * and invite the model to reconcile them.
   */
  async converse(
    question: string,
    history: ThreadTurn[],
    snapshot: SessionSnapshot,
    findings: Finding[] = []
  ): Promise<string | undefined> {
    if (!this.client) return undefined;

    const turns: Anthropic.MessageParam[] = history.map((turn) => ({
      role: turn.role === 'operator' ? ('user' as const) : ('assistant' as const),
      content: turn.text,
    }));

    return this.ask(
      `Here is the session as the journal has it.\n\n${facts(snapshot, findings)}\n\n` +
        `The operator asks: ${question}\n\n` +
        `Answer in at most 80 words, from these numbers. If the answer is not in ` +
        `them, say which number would settle it rather than guessing.`,
      800,
      turns
    );
  }

  /**
   * Something worth saying that nobody asked for.
   *
   * Used when a guardrail has just started or just got worse. Kept to one
   * sentence because it arrives uninvited: an unprompted paragraph in a panel
   * the operator was not reading is an interruption, and the second time it
   * happens they stop reading the panel.
   */
  async remark(finding: Finding, snapshot: SessionSnapshot): Promise<string | undefined> {
    if (!this.client) return undefined;

    return this.ask(
      `A guardrail has just started applying. The measurement is fixed and ` +
        `correct; do not re-judge it.\n\n` +
        `Behaviour: ${finding.behaviour.id}\n` +
        `What was measured: ${finding.detail}\n` +
        `Why it matters: ${finding.behaviour.why}\n\n` +
        `Session so far:\n${facts(snapshot, [])}\n\n` +
        `Write one sentence, at most 30 words, stating what changed and the ` +
        `number behind it. No advice, no question, no encouragement.`,
      200
    );
  }

  /**
   * The single call, with the failure modes all handled in one place.
   *
   * Every failure returns undefined. A coach that throws would turn a
   * network blip into a broken confirmation panel, and the panel's job -- to
   * show the operator an order before it is sent -- does not depend on it.
   */
  private async ask(
    question: string,
    maxTokens: number,
    history: Anthropic.MessageParam[] = []
  ): Promise<string | undefined> {
    if (!this.client) return undefined;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        // The brief is the cache prefix and nothing before this line varies, so
        // a thread of follow-ups re-reads it rather than re-paying for it.
        messages: [...history, { role: 'user', content: question }],
      });

      if (response.stop_reason === 'refusal') return undefined;

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      return text.length > 0 ? text : undefined;
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        // Worth distinguishing: a bad key is a configuration problem the
        // operator can fix, and silence would leave them wondering why the
        // coach never says anything.
        console.warn('[Coach] Anthropic credentials were rejected; coaching is off.');
        this.client = undefined;
        // Recorded rather than merely switched off, so the status line can say
        // 'rejected' instead of 'not configured'. They are different problems
        // and only one of them is fixed by entering a key.
        this.source = 'rejected';
        return undefined;
      }
      if (error instanceof Anthropic.APIError) {
        console.warn(`[Coach] ${error.status}: coaching unavailable this time.`);
        return undefined;
      }
      console.warn('[Coach] coaching unavailable this time.');
      return undefined;
    }
  }
}
