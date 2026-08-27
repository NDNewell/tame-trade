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
import {
  COACH_BLOCK_TYPES,
  CoachBlock,
  coachBlocks,
  limitCoachBlocks,
} from '../ui/coachBlocks.js';
import { MarketContext, describeMarket } from './marketContext.js';
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
const SYSTEM = `You are the trading coach built into Tame, a terminal trading client. One operator, one screen, read between trades.

ROLE

Twenty years on the other side of this screen — futures and FX first, crypto perpetuals since they existed, several of them running risk over other people's books at a prop desk. You have seen every way an account dies and almost all of them are the same three. You coach from method that survived contact with real money: expectancy over win rate, R-multiples over currency amounts, size as the primary risk control, stops where the idea is wrong rather than where the loss feels tolerable, and the arithmetic of drawdown — down 50% needs 100% back.

WHAT YOU ARE SHOWN

- Today's journal: round trips, realized PnL, hold times, order and cancel counts, equity, and every guardrail that fired.
- Previous sessions: the last week as a timeline of what was typed, filled, moved, armed, flagged and overridden, with the conversations of those days; earlier days one line each.
- The market, when available: price, top of book, mark, index, funding, the high/low and ATR(14) of each trailing window, the open position, every working order described by what it will do, and OHLC at eight sizes — one-minute through monthly, covering roughly the last hour through the last three years.

All of it read at one moment and handed to you. No chart to scroll, no order-book depth, no positioning data, and no way to re-read any of it after the block was taken.

WEB SEARCH

You can search the web, and you decide when. Search when something outside the terminal would change your answer — what moved this instrument, an unlock or listing or protocol event, a macro print or a scheduled announcement, a story the operator raised. Do not search for anything the market block already answers: price, spread, funding, the position, the orders and everything visible in the candles are all in front of you and are more current than any article.

News is context and never the subject. The operator is asking about their own position, not for a briefing, and that stays true when the question itself mentions the news — "anything I should know before the weekend" is a question about the weekend risk on their position, and the honest answer to it is mostly about their stop. Answer the trading question first and from the data. Bring in what you found only where it changes that answer. At most one block carries news, and it is never the first.

When you do use it:
- Say where it came from and when it was published. A number without a date is not evidence.
- Separate what was reported from what was speculated. An analyst's target is not a fact about the market.
- The market block is authoritative on price. An article quoting a different level is stale, not a correction.
- A headline is not a reason to trade. If the question is really about size or stop placement, it stays about size or stop placement.
- Found nothing that bears on the question? A clause is enough. Do not spend a block reporting an absence, and never invent a catalyst to fill one.

HOW TO READ WHAT YOU ARE GIVEN

Use the whole candle ladder, not the recent end of it. The fine sizes say where price is now; the daily, weekly and monthly say whether a level has been respected for a day or for a year, and that is usually the question actually being asked.

Order descriptions are exact and repay close reading. "the whole position" is a stop sized to whatever is open, not a stop sized zero. A trail that "will trail once price reaches X" is not trailing and will not move until it does. A multiple and a timeframe — 3x ATR(15m) — is the distance the stop keeps once it is trailing. Do not flatten these to "a stop"; the differences are most of what stop placement is.

Arithmetic, stated once so you never invent a denominator:
- R is the planned risk in the position block — what the stops actually in place leave exposed. With no protective stop there is no R; say so rather than assuming one.
- Percent of equity uses current equity from the journal.
- Stop distance is judged against ATR(14) of a named timeframe. Name the timeframe whenever you quote a multiple.
- Funding is given per payment and per day; quote the daily figure against the intended hold.
Show the inputs to any number you assert. If an input is missing, name it and answer the part that survives without it.

WHAT TO SAY

Advise. Sizing, stop placement, stop distance against measured volatility, risk per trade, pace, trade management, funding on a held position, when to stop for the day, how to plan tomorrow. Give the actual answer — numbers, thresholds, rules of thumb — and say where it comes from.

Cite the operator's own figures. "Three entries in six minutes" beats "you traded too fast."

You have met this operator before. A pattern across days beats anything visible inside one, and something you said on Tuesday should be referred to rather than rebuilt from scratch.

A view is honest; certainty is not. Say what the evidence supports and how it would be wrong. Never state a target or a level as though it were known.

If the operator gives you context you cannot verify, take it as given, answer inside it, and name the assumption.

Do not pretend to more than you have. Where the answer needs something you were not shown and could not find, name what is missing and answer the rest. This is a limit on what you can see, not a policy you are enforcing: never lecture about it, and never let it swallow the answer you do have.

VOICE

An experienced colleague. Not a compliance function, not a therapist. No moralizing, no catastrophizing, no praise for its own sake, no "it's okay", no "be kind to yourself". A disciplined session gets one sentence saying so and nothing more — do not invent a problem in order to have something to report. Never assert the operator's state of mind: "the pattern is consistent with chasing" is honest, "you were tilted" is not something a journal can show.

Plain sentences, second person, American spelling. Brevity is the point.

OUTPUT

You return blocks. Each block is one point, usually two sentences and rarely more than three — the panel is a narrow column, and a block that runs past about five lines is split in half by the application, which breaks the point you were making. Two full sentences beat four fragments. The application draws everything — spacing, headings, color — so write prose only: no markdown, no bullet characters, no headings of your own, no blank-line tricks.

Most blocks are "answer": ordinary prose, no heading. A short reply is one such block and nothing more. The named kinds — structure, action, risk, context, funding, sizing, session — are for a reply that genuinely covers separate ground, and a block takes one only if it is about that and nothing else. Labelling a direct answer turns it into a report. Lead with the answer; the ground it rests on follows.`;

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
  /**
   * The days before today, as a block.
   *
   * Injected rather than read here, for the same reason the market is: this
   * file talks to the model and nothing else. It is called on every request and
   * is expected to return the same bytes all day -- it is a cache prefix, and a
   * prefix that changes is a prefix that is paid for again.
   */
  history?: () => string;
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

/**
 * The market block, or a line saying there isn't one.
 *
 * Silence would be worse than an absence: a coach shown a journal and nothing
 * else, with a system prompt that mentions a market block, will assume the
 * block was omitted because nothing was happening.
 */
function marketBlock(market: MarketContext | undefined, candles = true): string {
  if (!market) {
    return 'No market data is available this call. Answer from the journal alone and say so if it matters.';
  }
  return describeMarket(market, candles);
}

/**
 * The shape a spoken reply must take.
 *
 * Constrained by the API rather than requested in the brief. Asking for blank
 * lines between points worked perhaps half the time -- a model being terse, or
 * answering something short, would return one paragraph, and the panel went
 * back to being a slab. A schema is not a request.
 *
 * `type` carries meaning rather than presentation: the renderer decides whether
 * a type earns a heading, what colour it takes, and how much space sits around
 * it. Nothing here says how anything looks, and none of it is ever shown to the
 * operator as written.
 */
const REPLY_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        minItems: 1,
        // No maxItems: the API rejects it outright for arrays in an output
        // format ('property maxItems is not supported'), and it does so as a
        // 400 on every call rather than by ignoring the field -- so the ceiling
        // is stated in the description, where the model reads it, instead.
        description:
          'The reply, split into the points it makes. One point per block, ' +
          'usually two sentences and rarely more than three. A run of ' +
          'single-sentence blocks reads as a list rather than an argument; a ' +
          'block longer than about five short lines gets split and stops being ' +
          'one point. At most six blocks in a reply.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [...COACH_BLOCK_TYPES],
              description:
                "What the block is. 'answer' for ordinary prose, which is most " +
                'of them and the only one a short reply needs. The named kinds ' +
                'are for a reply that genuinely covers separate ground; use one ' +
                'only when the block really is about that and nothing else.',
            },
            text: {
              type: 'string',
              description:
                'The prose. Plain sentences, no markdown, no bullet characters, ' +
                'no heading of your own -- the application draws the heading from ' +
                'the type.',
            },
          },
          required: ['type', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['blocks'],
    additionalProperties: false,
  },
};

/**
 * The web search tool, offered on the two calls that can afford it.
 *
 * Offered rather than required. It is a tool the model may decline, and the
 * brief tells it when to: a question about stop distance is answered from the
 * candles in front of it and returns in a couple of seconds, while a question
 * about what moved the market goes and looks and takes twenty. Making the
 * search unconditional would put that twenty seconds on every question,
 * including the ones the data already answers.
 *
 * Capped at three. The cap is not really about money -- it is that a model
 * given an uncapped search will occasionally decide a question deserves six of
 * them, and the operator is waiting.
 */
const SEARCH_TOOL = {
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 3,
} as const;

/**
 * How long a call carrying a search may run before it is abandoned.
 *
 * The SDK's own default is ten minutes, which is not a timeout so much as a
 * promise that the panel will say 'thinking...' until the operator restarts the
 * application.
 *
 * Generous, because it now bounds the whole answer rather than one attempt at
 * it: the request is streamed, so the connection stays open while the model
 * works and there is no half-finished attempt to throw away and repeat.
 */
const SEARCH_TIMEOUT_MS = 180_000;

/**
 * The turn behind both one-line guard sentences.
 *
 * They were two near-identical templates differing in an occasion clause and a
 * destination, which meant every change to one was a change somebody had to
 * remember to make to the other. Neither carries candles and neither may
 * search: both are written while the operator is mid-keystroke.
 */
function guardTurn(
  finding: Finding,
  snapshot: SessionSnapshot,
  market: MarketContext | undefined,
  occasion: 'held' | 'started'
): string {
  const opening =
    occasion === 'held'
      ? 'A guardrail is holding an order.'
      : 'A guardrail has just started applying.';
  const destination = occasion === 'held' ? 'the confirmation panel' : 'the coach panel';

  return (
    `${opening} The measurement is fixed and correct; do not re-judge it.\n\n` +
    `Behavior: ${finding.behaviour.id}\n` +
    `Measured: ${finding.detail}\n` +
    `Why it matters: ${finding.behaviour.why}\n\n` +
    `Session so far:\n${facts(snapshot, [])}\n\n` +
    `Market:\n${marketBlock(market, false)}\n\n` +
    `One sentence, at most 30 words, for ${destination}: the specific number, ` +
    `and the corrective if the same sentence carries both. No question, no ` +
    `encouragement, no preamble.`
  );
}

/**
 * The whole blocks out of a reply that was cut off part-way through one.
 *
 * Deliberately a scan for complete objects rather than a JSON repair: guessing
 * where a truncated string was going to end means inventing the end of a
 * sentence about the operator's money. What survives intact is kept and the
 * rest is dropped.
 */
export function salvageBlocks(text: string): CoachBlock[] {
  if (!text.trimStart().startsWith('{') || !text.includes('"blocks"')) return [];

  const out: CoachBlock[] = [];
  const pattern = /\{\s*"type"\s*:\s*"([a-z]+)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const type = (COACH_BLOCK_TYPES as readonly string[]).includes(match[1])
      ? (match[1] as CoachBlock['type'])
      : ('answer' as const);
    try {
      const body = JSON.parse(`"${match[2]}"`) as string;
      if (body.trim()) out.push({ type, text: body.trim() });
    } catch {
      // One unreadable block costs one block, not the reply.
    }
  }

  return out;
}

/** Where the key in use came from, or why there isn't one. */
export type KeySource = 'profile' | 'environment' | 'none' | 'rejected';

export class Coach {
  private client: Anthropic | undefined;
  private model: string;
  private enabled: boolean;
  private source: KeySource = 'none';
  private history: () => string;

  constructor(options: CoachOptions = {}) {
    this.model = options.model ?? MODEL;
    this.enabled = options.enabled !== false;
    this.history = options.history ?? (() => '');
    this.useKey(options.apiKey);
  }

  /** Adopts a source of previous sessions, which is found after construction. */
  useHistory(history: () => string): void {
    this.history = history;
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
  async debrief(
    snapshot: SessionSnapshot,
    findings: Finding[] = [],
    market?: MarketContext,
    width = 40
  ): Promise<CoachBlock[] | undefined> {
    if (!this.client) return undefined;

    if (snapshot.trades.length === 0 && findings.length === 0) {
      // Nothing happened. Spending a call to be told so is not a service.
      return undefined;
    }

    return this.askBlocks(
      `Here is the session's journal.\n\n${facts(snapshot, findings)}\n\n` +
        `And the market it was traded in.\n\n${marketBlock(market)}\n\n` +
        // Budgeted in blocks rather than words. A word count and a block count
        // are two ceilings on the same thing, and 'at most 150 words' across
        // five blocks of two to four sentences is a contradiction the model has
        // to resolve by ignoring one of them.
        `Write the debrief in three to five blocks. Lead with the one thing that ` +
        `most affected the outcome. If guardrails fired and were overridden, say ` +
        `what the journal shows happened next, without implying causation it does ` +
        `not support. Close with the single change worth making tomorrow, stated ` +
        `as an instruction rather than a suggestion.`,
      6000,
      width,
      [],
      // The debrief already costs a pause, and 'what actually moved it today'
      // is half of what makes one worth reading.
      true
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
  async speakTo(
    finding: Finding,
    snapshot: SessionSnapshot,
    market?: MarketContext
  ): Promise<string | undefined> {
    if (!this.client) return undefined;

    return this.ask(guardTurn(finding, snapshot, market, 'held'), 200);
  }

  /**
   * A question the operator actually asked, with the thread behind it.
   *
   * The one place the coach is not reacting to a measurement. Everything else
   * in this file is triggered by the guardrails; this is triggered by someone
   * typing, which means the question can be about anything -- including things
   * nothing here was shown enough to answer. The brief already says what the
   * coach can and cannot see, and that is not restated in the turn: a limit
   * repeated twice produces a reply that argues with itself about whether it
   * may answer, rather than one that answers the part it can.
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
    findings: Finding[] = [],
    market?: MarketContext,
    width = 40
  ): Promise<CoachBlock[] | undefined> {
    if (!this.client) return undefined;

    const turns: Anthropic.MessageParam[] = history.map((turn) => ({
      role: turn.role === 'operator' ? ('user' as const) : ('assistant' as const),
      content: turn.text,
    }));

    return this.askBlocks(
      `Here is the session as the journal has it.\n\n${facts(snapshot, findings)}\n\n` +
        `And the market as it stands.\n\n${marketBlock(market)}\n\n` +
        `The operator asks: ${question}\n\n` +
        `Answer it. One or two blocks for a straightforward question; more only ` +
        `if it genuinely covers separate ground, and never more than six. Ground ` +
        `every claim in what you were shown or found; where the answer needs ` +
        `something you have neither, name what is missing and answer the part ` +
        `you can rather than guessing at the rest.`,
      // Generous, because it is a ceiling rather than a target and because
      // running out of it is what produced a panel full of raw JSON: a search
      // spends output tokens on its queries before the answer starts, and a
      // reply cut off mid-string is a reply that cannot be parsed at all.
      8000,
      width,
      turns,
      // A typed question is the one call where the operator is waiting on
      // purpose and where the answer may genuinely lie outside the terminal.
      true
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
  async remark(
    finding: Finding,
    snapshot: SessionSnapshot,
    market?: MarketContext
  ): Promise<string | undefined> {
    if (!this.client) return undefined;

    return this.ask(guardTurn(finding, snapshot, market, 'started'), 200);
  }

  /**
   * The single call, with the failure modes all handled in one place.
   *
   * Every failure returns undefined. A coach that throws would turn a
   * network blip into a broken confirmation panel, and the panel's job -- to
   * show the operator an order before it is sent -- does not depend on it.
   */
  /**
   * A spoken reply, as blocks.
   *
   * Constrained to the schema, then checked anyway. A response that comes back
   * unparseable, or as prose because the format was refused or unsupported, is
   * put through the same text splitter the panel has always had rather than
   * being dropped -- the operator asked a question and is owed the answer,
   * laid out as well as it can be.
   *
   * `width` is the column the prose will be wrapped into, so the length limit
   * is measured in rows of the panel it is actually going to.
   */
  private async askBlocks(
    question: string,
    maxTokens: number,
    width: number,
    history: Anthropic.MessageParam[] = [],
    search = false
  ): Promise<CoachBlock[] | undefined> {
    const written = await this.ask(question, maxTokens, history, REPLY_FORMAT, search);
    if (written === undefined) return undefined;

    try {
      const parsed = JSON.parse(written) as { blocks?: Array<{ type?: string; text?: string }> };
      const blocks = (parsed.blocks ?? [])
        .filter((block) => typeof block?.text === 'string' && block.text.trim().length > 0)
        .map((block) => ({
          // An unrecognised type is prose. It is a heading we would otherwise
          // invent, and an invented heading is worse than none.
          type: (COACH_BLOCK_TYPES as readonly string[]).includes(String(block.type))
            ? (block.type as CoachBlock['type'])
            : ('answer' as const),
          text: String(block.text).trim(),
        }));

      // The model decided where the points divide; the application decides only
      // how long one may run. Re-splitting them by subject here -- which is what
      // the fallback splitter does -- broke coherent blocks into fragments.
      if (blocks.length > 0) return limitCoachBlocks(blocks, width);
    } catch {
      // Not JSON, or not whole. Handled below.
    }

    // A reply cut off mid-string parses as nothing, and the raw text is the
    // schema's own JSON -- which is exactly the formatting metadata that must
    // never reach the operator. So the complete objects are recovered and the
    // truncated tail is dropped: a slightly short answer beats a panel full of
    // braces.
    const salvaged = salvageBlocks(written);
    if (salvaged.length > 0) return limitCoachBlocks(salvaged, width);

    return coachBlocks(written, width);
  }

  private async ask(
    question: string,
    maxTokens: number,
    history: Anthropic.MessageParam[] = [],
    format?: typeof REPLY_FORMAT,
    search = false
  ): Promise<string | undefined> {
    if (!this.client) return undefined;

    try {
      // Two blocks, both cached, in order of how often they change: the brief
      // never does, and the previous sessions change once a day. Everything
      // that moves -- today's numbers, the market, the question -- is in the
      // turn below and is the only part paid for at full rate.
      //
      // This is what makes the long memory affordable. A week of sessions is
      // several thousand tokens and would be indefensible on a sentence raced
      // against a keypress if it were re-read every time; as a cache prefix it
      // is written once and cheap for the rest of the day.
      const previously = this.history();
      const system: Anthropic.TextBlockParam[] = [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
      ];
      if (previously) {
        system.push({
          type: 'text',
          text: `PREVIOUS SESSIONS\n\n${previously}`,
          cache_control: { type: 'ephemeral' },
        });
      }

      const params = {
        model: this.model,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' as const },
        output_config: format ? { effort: 'medium' as const, format } : { effort: 'medium' as const },
        system,
        messages: [
          ...history,
          { role: 'user' as const, content: question },
        ] satisfies Anthropic.MessageParam[],
        ...(search ? { tools: [SEARCH_TOOL as unknown as Anthropic.ToolUnion] } : {}),
      };

      // Streamed when a search is in play, and only then.
      //
      // Not for the tokens -- nothing here renders them as they arrive -- but
      // because a long request against a fixed timeout is a request that gets
      // abandoned and retried, and the retry starts the clock again. One
      // observed answer took a hundred and eighteen seconds that way, which is
      // roughly ninety seconds of waiting followed by the same work done twice.
      // A stream keeps the connection alive for as long as the model is
      // actually working, so the ceiling below bounds the whole answer rather
      // than each attempt at it.
      const response = search
        ? await this.client.messages
            .stream(params, { timeout: SEARCH_TIMEOUT_MS })
            .finalMessage()
        : await this.client.messages.create(params);

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
        // The reason, not just the number. 'coaching unavailable this time'
        // read the same whether the service was busy or the account had run out
        // of credit, and only one of those is something the operator can fix --
        // so the one worth acting on was the one being hidden.
        const reason = (error as { error?: { error?: { message?: string } } }).error?.error
          ?.message;
        console.warn(`[Coach] ${error.status}: ${reason ?? 'coaching unavailable this time.'}`);
        return undefined;
      }
      console.warn('[Coach] coaching unavailable this time.');
      return undefined;
    }
  }
}
