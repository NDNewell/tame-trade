// src/ui/coachBlocks.ts
//
// A coach response as a sequence of blocks, rather than as one string.
//
// The panel used to receive a paragraph and wrap it, which meant a five-sentence
// answer arrived as thirty unbroken rows in a narrow column. Splitting it in the
// renderer helped and was still guesswork: only the writer knows where one point
// ends and the next begins.
//
// So the coach is asked to say. It separates points with a blank line and may
// label a block when the answer genuinely covers distinct ground -- RISK,
// STRUCTURE, ACTION, CONTEXT and a few others. That is the whole of the
// protocol: no markup, no JSON, nothing that reads as machinery if it reaches a
// human eye.
//
// And it is a hint, never a dependency. A model that returns one dense
// paragraph -- because it was terse, or because the day is going badly at the
// other end of the API -- must still produce a readable panel, so everything
// here degrades: unlabelled text falls back to splitting by subject, and any
// block that outgrows its allowance is cut at a sentence. Spacing and colour are
// decided here and only here. What the model supplies is structure.

import { wrapText } from './wrap.js';

/**
 * What a block is.
 *
 * A closed set on purpose. An open one would let any capitalised word followed
 * by a colon become a heading -- 'Note:', 'Warning:', a market named at the
 * start of a sentence -- and the first time that happened the panel would show
 * a heading the coach never meant to write.
 *
 * 'answer' is the ordinary case and carries no heading: it is the coach
 * replying, and a two-sentence reply with a word stamped above it reads as a
 * report rather than an answer.
 */
export const COACH_BLOCK_TYPES = [
  'answer',
  'recommendation',
  'structure',
  'action',
  'risk',
  'context',
  'funding',
  'sizing',
  'session',
] as const;

export type CoachBlockType = (typeof COACH_BLOCK_TYPES)[number];

export interface CoachBlock {
  type: CoachBlockType;
  text: string;
}

/**
 * The heading a block shows, or nothing.
 *
 * A recommendation is the answer to what was asked, so it leads without a
 * heading like any other reply; the rest name themselves, because they are the
 * ground the answer covers rather than the answer.
 */
export function headingFor(type: CoachBlockType): string | undefined {
  if (type === 'answer' || type === 'recommendation') return undefined;
  return type.toUpperCase();
}

/**
 * A prose block runs to about this many wrapped rows before it is split.
 *
 * Counted in rendered rows rather than sentences, because sentences vary by a
 * factor of five and rows are what the eye actually meets.
 */
const MAX_BLOCK_LINES = 5;

/** A heading the coach wrote as text, for replies that arrive unstructured. */
const LABEL_PATTERN = new RegExp(
  `^(${COACH_BLOCK_TYPES.filter((type) => type !== 'answer').join('|')})\\s*:\\s*`,
  'i'
);

/** Sentence-ish boundaries: a full stop followed by a capital or a quote. */
const SENTENCE = /(?<=[.!?])\s+(?=["“]?[A-Z0-9])/;

/**
 * What a sentence is about, roughly.
 *
 * Only roughly, and that is the point: this decides where a break reads
 * naturally in text that arrived without any, and a break in almost the right
 * place costs nothing while no break at all costs the answer its readability.
 */
const COACH_TOPICS: Array<[string, RegExp]> = [
  ['structure', /\b(structure|support|resistance|range|high|low|breakout|trend|consolidat)/i],
  ['timeframe', /\b(\d+\s*(m|h|d|w)\b|minute|hourly|daily|weekly|timeframe|candle|bar)\b/i],
  ['leverage', /\b(leverage|levered|margin|notional|liquidat)/i],
  ['stop', /\b(stop|trail|arm(ed|ing)?|exit|invalidat)/i],
  ['funding', /\b(funding|carry|apr|per day|overnight)/i],
  ['size', /\b(siz(e|ing)|position size|risk per|R\b|add(ing)? to|scal(e|ing))/i],
  ['session', /\b(session|today|hours|so far|fatigue|pace|streak)/i],
];

const topicOf = (sentence: string): string | undefined =>
  COACH_TOPICS.find(([, pattern]) => pattern.test(sentence))?.[0];

/** A paragraph runs to at least this before a subject change may break it. */
const PARAGRAPH_MIN = 2;
/** And never runs past this, whatever it is about. */
const PARAGRAPH_MAX = 4;

/**
 * Anything that would read as machinery, removed.
 *
 * Models reach for markdown unprompted, and a stray '**' or a leading '-' in a
 * terminal panel is formatting metadata showing through to the operator. It is
 * stripped rather than rendered, and rather than being treated as a syntax --
 * supporting it would mean the panel's appearance depended on which conventions
 * a particular reply happened to use.
 */
function clean(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}[-*+]\s+/, '')
    .replace(/^\s{0,3}\d+[.)]\s+/, '')
    .trim();
}

/**
 * Splits text with no blank lines of its own, at changes of subject.
 *
 * The fallback, for a reply that arrived as one paragraph. A floor keeps a
 * break from landing after a single sentence, and the lookahead keeps the last
 * sentence of an answer from being stranded on its own -- a follow-up cut from
 * the figure it was explaining reads as a fragment rather than a paragraph.
 */
function splitBySubject(text: string): string[] {
  const sentences = text.trim().split(SENTENCE);
  if (sentences.length <= PARAGRAPH_MIN) return [text.trim()];

  const topics = sentences.map(topicOf);
  const out: string[] = [];
  let start = 0;

  for (let index = 1; index < sentences.length; index++) {
    const size = index - start;
    const remaining = sentences.length - index;

    // Measured against the last sentence in this paragraph that had a subject
    // at all, so an unclassified sentence in the middle does not reset it.
    let previous: string | undefined;
    for (let back = index - 1; back >= start; back--) {
      if (topics[back] !== undefined) {
        previous = topics[back];
        break;
      }
    }

    const changed =
      topics[index] !== undefined && previous !== undefined && topics[index] !== previous;
    const worthBreaking = changed && size >= PARAGRAPH_MIN && remaining >= PARAGRAPH_MIN;

    if (size >= PARAGRAPH_MAX || worthBreaking) {
      out.push(sentences.slice(start, index).join(' ').trim());
      start = index;
    }
  }

  out.push(sentences.slice(start).join(' ').trim());
  return out.filter(Boolean);
}

/**
 * Cuts a block that outgrew its allowance, at a sentence.
 *
 * Only where that is possible: a single sentence longer than the allowance is
 * left whole, because breaking mid-clause to satisfy a row count trades a
 * readable long paragraph for an unreadable short one. Only the first piece
 * keeps the heading -- repeating 'RISK' over three consecutive blocks would
 * read as three separate points about risk rather than one that ran long.
 */
function limitLength(block: CoachBlock, width: number, maxLines: number): CoachBlock[] {
  if (wrapText(block.text, width).length <= maxLines) return [block];

  const sentences = block.text.split(SENTENCE);
  if (sentences.length === 1) return [block];

  const out: CoachBlock[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    out.push({
      type: out.length === 0 ? block.type : 'answer',
      text: current.join(' ').trim(),
    });
    current = [];
  };

  for (const sentence of sentences) {
    const candidate = [...current, sentence].join(' ');
    if (current.length > 0 && wrapText(candidate, width).length > maxLines) flush();
    current.push(sentence);
  }
  flush();

  return out.length > 0 ? out : [block];
}

/**
 * Caps the length of blocks the coach itself divided, and nothing else.
 *
 * Model-supplied blocks used to go through `coachBlocks`, which was wrong in a
 * way that only showed up in the panel: that function's subject splitter is the
 * fallback for text that arrived with no divisions at all, and running it over
 * a block the coach had already divided cut coherent two-sentence points into
 * single-sentence fragments. The result read as a list of assertions rather
 * than an argument -- the opposite of the slab, and no easier to read.
 *
 * The writer decided where the points divide. The only thing left to enforce is
 * how long one may run.
 */
export function limitCoachBlocks(
  blocks: CoachBlock[],
  width: number,
  maxLines = MAX_BLOCK_LINES
): CoachBlock[] {
  return blocks.flatMap((block) => limitLength(block, width, maxLines));
}

/**
 * A coach response as blocks, ready to paint.
 *
 * `width` is the column the prose will be wrapped into, which is what makes the
 * length limit meaningful: four lines is four lines of the panel it is actually
 * going into, not four lines of some assumed width.
 */
export function coachBlocks(
  text: string,
  width: number,
  maxLines = MAX_BLOCK_LINES
): CoachBlock[] {
  const normalised = String(text ?? '')
    .split('\n')
    .map(clean)
    .join('\n');

  // What the coach separated, if it separated anything.
  const raw = normalised
    .split(/\n{2,}/)
    .map((part) => part.replace(/\n+/g, ' ').trim())
    .filter(Boolean);

  if (raw.length === 0) return [];

  const blocks: CoachBlock[] = [];

  for (const part of raw) {
    const match = LABEL_PATTERN.exec(part);
    const body = match ? part.slice(match[0].length).trim() : part;
    if (!body) continue;

    const type = match
      ? (match[1].toLowerCase() as CoachBlockType)
      : ('answer' as const);

    // Only an unheaded block that arrived alone gets split by subject. One that
    // named itself has been told what it is about, so cutting it in two on a
    // keyword would be second-guessing the writer with worse evidence.
    const pieces = type === 'answer' && raw.length === 1 ? splitBySubject(body) : [body];

    for (const piece of pieces) blocks.push({ type, text: piece });
  }

  return blocks.flatMap((block) => limitLength(block, width, maxLines));
}
