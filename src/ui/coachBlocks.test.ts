// Reading a coach reply as the coach wrote it.
import { coachNodes } from './coachBlocks.js';
import { wrapText } from './wrap.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const W = 45;
const shape = (nodes: ReturnType<typeof coachNodes>) =>
  nodes.map((n) => `${n.kind[0]}:${n.text.slice(0, 26)}`).join(' | ');

// The ordinary case: prose, untouched.
let nodes = coachNodes('Your stop is at entry. Move it under 96.20.', W);
check('A  a short reply is one paragraph and nothing else',
  nodes.length === 1 && nodes[0].kind === 'paragraph',
  shape(nodes));

// Where the coach pressed return is where the break falls.
nodes = coachNodes('Price holds above 96.20.\n\nYour stop has not armed.\n\nFunding is 28.89 a day.', W);
check('B  blank lines the coach wrote are the paragraph breaks',
  nodes.length === 3 && nodes.every((n) => n.kind === 'paragraph'),
  shape(nodes));

// A list stays a list rather than being flattened into a sentence.
nodes = coachNodes('Two things:\n\n- Move the stop to 100.\n- Cut the size by a third.', W);
check('C  list items are kept as items',
  nodes.length === 3 && nodes[1].kind === 'bullet' && nodes[2].kind === 'bullet',
  shape(nodes));

check('D  the bullet marker itself is not part of the text',
  !nodes[1].text.startsWith('-') && nodes[1].text.startsWith('Move'),
  nodes[1].text);

// Numbered lists too.
nodes = coachNodes('1. First thing.\n2. Second thing.', W);
check('E  a numbered list is a list',
  nodes.length === 2 && nodes.every((n) => n.kind === 'bullet') && nodes[0].text === 'First thing.',
  shape(nodes));

// Headings only when the coach writes one.
nodes = coachNodes('## Risk\n\nYou are carrying 71% of equity.', W);
check('F  a heading the coach wrote is a heading',
  nodes.length === 2 && nodes[0].kind === 'heading' && nodes[0].text === 'Risk',
  shape(nodes));

nodes = coachNodes('**Weekend risk**\n\nYour stop is at entry.', W);
check('G  a line that is only a bolded phrase reads as a heading',
  nodes.length === 2 && nodes[0].kind === 'heading' && nodes[0].text === 'Weekend risk',
  shape(nodes));

// Emphasis is lifted off the text so wrapping measures real columns.
nodes = coachNodes('Move it to **100.1** before the weekend.', W);
check('H  bold markers are removed and the phrase remembered',
  nodes[0].kind === 'paragraph' &&
    !nodes[0].text.includes('*') &&
    (nodes[0] as { emphasis: string[] }).emphasis.includes('100.1'),
  `${nodes[0].text} :: ${JSON.stringify((nodes[0] as { emphasis: string[] }).emphasis)}`);

// Nothing a terminal cannot draw should reach it as punctuation.
nodes = coachNodes('| Level | Note |\n| --- | --- |\n| 100.1 | 2x ATR |', W);
const flat = nodes.map((n) => n.text).join(' ');
check('I  a table is flattened rather than shown as pipes',
  !flat.includes('|') && flat.includes('100.1'),
  shape(nodes));

nodes = coachNodes('```\nsome code\n```', W);
check('J  a code fence loses its fence and keeps its contents',
  nodes.every((n) => !n.text.includes('`')) && nodes.map((n) => n.text).join(' ').includes('some code'),
  shape(nodes));

// A natural multi-sentence paragraph must pass through whole.
const natural =
  'Your stop sits at entry, which protects the principal and none of the gain. ' +
  'That is 8.14 below mark, about 3.8x the daily ATR. On 11,480 of equity it leaves 71% exposed.';
nodes = coachNodes(natural, W);
check('K  a natural paragraph is not split',
  nodes.length === 1 && wrapText(nodes[0].text, W).length <= 12,
  `${nodes.length} node(s), ${wrapText(nodes[0].text, W).length} rows`);

// Only a genuine wall is broken up.
const wall = Array.from({ length: 9 }, (_, i) =>
  `Sentence number ${i + 1} runs on for a while about stops and volatility and size.`
).join(' ');
nodes = coachNodes(wall, W);
check('L  one unbroken wall is split as a last resort',
  nodes.length > 1 && nodes.every((n) => n.kind === 'paragraph'),
  `${nodes.length} paragraphs from ${wrapText(wall, W).length} rows`);

check('M  empty input yields nothing',
  coachNodes('', W).length === 0 && coachNodes('   \n\n ', W).length === 0,
  'empty and whitespace-only');

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
