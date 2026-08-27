// Turning a coach reply into blocks, however it happens to arrive.
import { coachBlocks, headingFor, limitCoachBlocks } from './coachBlocks.js';
import { wrapText } from './wrap.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const W = 40;
const shape = (blocks: ReturnType<typeof coachBlocks>) =>
  blocks.map((b) => `${b.type}:${b.text.slice(0, 24)}`).join(' | ');

// A short answer stays one block. Structure is for answers that need it.
let blocks = coachBlocks('Your stop is inside one ATR. Move it under 96.20.', W);
check('A  a short reply stays a single unlabelled block',
  blocks.length === 1 && blocks[0].type === 'answer',
  shape(blocks));

// Blank lines the coach wrote are boundaries and are kept exactly.
blocks = coachBlocks(
  'Price is holding above 96.20.\n\nYour stop has not armed yet.\n\nFunding costs 28.89 a day.',
  W
);
check('B  blank lines the coach wrote become blocks',
  blocks.length === 3 && blocks.every((b) => b.type === 'answer'),
  shape(blocks));

// Labels are lifted off the text, never shown as written.
blocks = coachBlocks(
  'RISK: Effective leverage is 32.19x.\n\nSTRUCTURE: Price holds above the 4h low.',
  W
);
check('C  labels are recognised and stripped from the prose',
  blocks.length === 2 &&
    blocks[0].type === 'risk' &&
    blocks[1].type === 'structure' &&
    !blocks[0].text.includes('RISK') &&
    !blocks[0].text.includes(':'),
  shape(blocks));

// A word that is not in the vocabulary is prose, not a heading.
blocks = coachBlocks('NOTE: this is not a section label.', W);
check('D  a word outside the vocabulary is left as prose',
  blocks.length === 1 && blocks[0].type === 'answer' && blocks[0].text.startsWith('NOTE:'),
  shape(blocks));

// The fallback: one dense paragraph still has to read as a panel.
const dense =
  'Price is holding above the 4h structure at 96.20 and the last three daily closes are higher. ' +
  'That is a trend you can hold. Your stop sits at entry and does not move until 109.76. ' +
  'Put it under 96.20 instead. Funding is costing you 28.89 USDT a day at this size. ' +
  'Effective leverage of 32.19x should worry you, with liquidation at 88.14.';
blocks = coachBlocks(dense, W);
check('E  an unstructured reply is still broken up',
  blocks.length >= 2,
  `${blocks.length} blocks: ${shape(blocks)}`);

// Nothing may run past the allowance, whatever route it arrived by.
const overlong =
  'RISK: ' +
  'Effective leverage of 32.19x is well past anything defensible on this account. ' +
  'Liquidation sits at 88.14, which is eleven percent away. ' +
  'One bad daily bar covers that distance without trying. ' +
  'You are also carrying funding of nearly thirty a day. ' +
  'Cut the size before you think about anything else.';
blocks = coachBlocks(overlong, W);
const longest = Math.max(...blocks.map((b) => wrapText(b.text, W).length));
check('F  a block longer than five wrapped rows is split',
  blocks.length > 1 && longest <= 5,
  `${blocks.length} blocks, longest ${longest} rows`);

check('G  only the first piece of a split block keeps the heading',
  blocks[0].type === 'risk' && blocks.slice(1).every((b) => b.type === 'answer'),
  shape(blocks));

// A single sentence that cannot be split is left whole rather than cut mid-clause.
const unsplittable = 'a'.repeat(200);
blocks = coachBlocks(unsplittable, W);
check('H  a single over-long sentence is kept whole rather than cut',
  blocks.length === 1,
  `${blocks.length} block(s), ${wrapText(blocks[0].text, W).length} rows`);

// Markdown must never reach the panel as characters.
blocks = coachBlocks('**RISK**: your size is too large.\n\n- and a bullet\n\n# a heading', W);
const text = blocks.map((b) => b.text).join(' ');
check('I  markdown is stripped rather than rendered',
  !/[*#`]/.test(text) && !text.includes('- and'),
  shape(blocks));

check('J  a label wrapped in markdown is still recognised',
  blocks[0].type === 'risk',
  shape(blocks));

// Degenerate input must not throw or produce phantom blocks.
check('K  empty input produces no blocks',
  coachBlocks('', W).length === 0 && coachBlocks('   \n\n  ', W).length === 0,
  'empty and whitespace-only');

// A labelled block is trusted, not re-split by subject.
blocks = coachBlocks('CONTEXT: You are long. The trend is up.', W);
check('L  a labelled block is not second-guessed by the subject splitter',
  blocks.length === 1 && blocks[0].type === 'context',
  shape(blocks));

// Headings are drawn from the type, and the ordinary kinds carry none.
check('M  only the named kinds take a heading',
  headingFor('answer') === undefined &&
    headingFor('recommendation') === undefined &&
    headingFor('risk') === 'RISK' &&
    headingFor('structure') === 'STRUCTURE',
  `answer=${headingFor('answer')} risk=${headingFor('risk')}`);

// Blocks the coach divided itself are capped in length and nothing else. The
// subject splitter is for text that arrived undivided, and running it over a
// block the writer had already drawn cut coherent points into fragments.
const authored = [
  { type: 'answer' as const, text: 'Your stop is 8.14 away. That is 26x the 1h ATR of 0.31.' },
  { type: 'risk' as const, text: 'It protects none of the gain. On 11,480 equity that is 71% on the table.' },
];
let kept = limitCoachBlocks(authored, W);
check('N  blocks the coach divided are not re-split by subject',
  kept.length === 2 && kept[0].text === authored[0].text && kept[1].type === 'risk',
  shape(kept));

// But an authored block that runs long is still cut.
kept = limitCoachBlocks(
  [{ type: 'risk' as const, text: overlong.replace(/^RISK: /, '') }],
  W
);
check('O  an authored block that runs long is still capped',
  kept.length > 1 && Math.max(...kept.map((b) => wrapText(b.text, W).length)) <= 5,
  `${kept.length} blocks`);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
