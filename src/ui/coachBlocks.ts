// src/ui/coachBlocks.ts
//
// A coach reply as the coach wrote it.
//
// This file has been three things. It wrapped a paragraph, which produced
// thirty unbroken rows in a narrow column. Then it split that paragraph by
// subject, guessing where one point ended. Then it stopped guessing and made
// the model return typed blocks under a schema, which the panel drew with
// headings.
//
// The schema went too far, and it rested on a false diagnosis. Asking for
// paragraphs appeared not to work, and the real reason was a bug one layer
// down: the window that trims the thread to the visible rows dropped every
// blank line whenever the conversation outgrew the pane, which happens after
// about two exchanges. The blank lines were being written and then thrown away.
// With that fixed, prose separated by blank lines arrives and survives, and
// stamping RISK / ACTION / STRUCTURE onto every reply turned answers into
// reports.
//
// So this is a reader now, not a shaper. It takes what was written and
// recognises the small amount of structure that survives a terminal column:
// paragraphs, a list item, a short heading, a bolded phrase. Anything else --
// tables, code fences, rules -- is flattened rather than shown, because a
// half-rendered table is worse than a sentence.

import { wrapText } from './wrap.js';

/**
 * One piece of a reply.
 *
 * Deliberately a short list. These are the forms that read correctly in a
 * narrow monospaced column; the rest of what a model might reach for does not,
 * and pretending otherwise puts punctuation on screen instead of meaning.
 */
export type CoachNode =
  | { kind: 'paragraph'; text: string; emphasis: string[] }
  | { kind: 'bullet'; text: string; emphasis: string[] }
  | { kind: 'heading'; text: string };

/**
 * A reply with no paragraph breaks anywhere is split at this many rows.
 *
 * A safety net rather than a rule, and set high on purpose: a natural paragraph
 * of four or five sentences is six or seven rows and must pass through
 * untouched. This catches only the degenerate case -- one unbroken wall, which
 * is what comes back when a model is told to be brief and takes that to mean
 * 'do not press return'.
 */
const WALL_ROWS = 12;

/** Sentence-ish boundaries: a full stop followed by a capital or a quote. */
const SENTENCE = /(?<=[.!?])\s+(?=["“]?[A-Z0-9])/;

const BULLET = /^\s{0,4}(?:[-*+•]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
/** A line that is nothing but a bolded phrase is a heading in every prose style. */
const BOLD_LINE = /^\s*\*\*(.+?)\*\*:?\s*$/;

/**
 * Pulls the emphasised phrases out of a line and returns it unmarked.
 *
 * The markers have to go before the text is wrapped -- four asterisks are four
 * columns that do not exist on screen, and leaving them in makes every wrap
 * measurement wrong. What they enclosed is kept, so the painter can find it
 * again and give it the weight it was asking for.
 */
function unmark(text: string): { text: string; emphasis: string[] } {
  const emphasis: string[] = [];

  const plain = text
    .replace(/\*\*(.+?)\*\*/g, (_, inner: string) => {
      emphasis.push(inner);
      return inner;
    })
    .replace(/__(.+?)__/g, (_, inner: string) => {
      emphasis.push(inner);
      return inner;
    })
    // Single asterisks and backticks carry no weight worth rendering here, and
    // reach the panel as punctuation if they are left alone.
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

  return { text: plain, emphasis };
}

/** Everything a terminal column cannot show, reduced to something it can. */
function flatten(lines: string[]): string[] {
  return lines
    // A code fence in a coaching answer is either an accident or a table in
    // disguise. The fence goes; whatever was inside it stays as prose.
    .filter((line) => !/^\s*```/.test(line))
    .map((line) =>
      // A markdown table rendered into forty columns is a column of pipes.
      /^\s*\|.*\|\s*$/.test(line)
        ? line
            .replace(/^\s*\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(' — ')
        : line
    )
    // A horizontal rule between paragraphs is already a blank line here, and a
    // table's separator row survives the flattening above as a run of dashes.
    .filter((line) => !/^[\s\-*_—|:]+$/.test(line) || line.trim().length === 0);
}

/**
 * The reply, read.
 *
 * `width` is the column the prose will be wrapped into, which is what makes the
 * wall test meaningful: twelve rows is twelve rows of the panel it is actually
 * going into rather than of some assumed width.
 */
export function coachNodes(text: string, width: number): CoachNode[] {
  const raw = flatten(String(text ?? '').replace(/\r/g, '').split('\n'));

  const nodes: CoachNode[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    paragraph = [];
    if (joined) nodes.push({ kind: 'paragraph', ...unmark(joined) });
  };

  for (const line of raw) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    const boldOnly = BOLD_LINE.exec(trimmed);
    if (boldOnly) {
      flushParagraph();
      nodes.push({ kind: 'heading', text: boldOnly[1].trim() });
      continue;
    }

    if (HEADING.test(trimmed)) {
      flushParagraph();
      nodes.push({ kind: 'heading', text: unmark(trimmed.replace(HEADING, '')).text });
      continue;
    }

    if (BULLET.test(trimmed)) {
      flushParagraph();
      nodes.push({ kind: 'bullet', ...unmark(trimmed.replace(BULLET, '')) });
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();

  // The degenerate case, and only that: one paragraph, no breaks anywhere, long
  // enough to be a wall. Anything the coach divided itself is left alone.
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only && only.kind === 'paragraph' && wrapText(only.text, width).length > WALL_ROWS) {
    const sentences = only.text.split(SENTENCE);
    if (sentences.length >= 4) {
      const out: CoachNode[] = [];
      for (let index = 0; index < sentences.length; index += 3) {
        const chunk = sentences.slice(index, index + 3).join(' ').trim();
        if (chunk) out.push({ kind: 'paragraph', text: chunk, emphasis: only.emphasis });
      }
      return out;
    }
  }

  return nodes;
}
