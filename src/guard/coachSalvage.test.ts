// Recovering a reply the model was cut off part-way through.
//
// The failure this guards against reached the screen once: a search-enabled
// answer ran out of output tokens mid-string, the JSON would not parse, and the
// fallback rendered the schema's own braces into the panel as prose. What must
// never happen again is formatting metadata reaching the operator.
import { salvageBlocks } from './coach.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const whole =
  '{"blocks":[{"type":"answer","text":"Your stop is 8.14 away."},' +
  '{"type":"risk","text":"That is 71% of equity on the table."}]}';

let got = salvageBlocks(whole);
check('A  a complete reply yields every block',
  got.length === 2 && got[0].type === 'answer' && got[1].type === 'risk',
  got.map((b) => b.type).join(', '));

// The real shape of the failure: cut off inside the last string.
const cut =
  '{"blocks":[{"type":"answer","text":"Your stop is 8.14 away."},' +
  '{"type":"risk","text":"That is 71% of equity and a weekend gap take';

got = salvageBlocks(cut);
check('B  a truncated reply keeps the whole blocks and drops the cut one',
  got.length === 1 && got[0].text === 'Your stop is 8.14 away.',
  JSON.stringify(got));

check('C  nothing recovered carries JSON punctuation into the panel',
  got.every((b) => !/[{}]|"blocks"|"type"/.test(b.text)),
  got.map((b) => b.text).join(' | '));

got = salvageBlocks('{"blocks":[{"type":"answer","text":"He said \\"no\\" and left."}]}');
check('D  escaped quotes inside a block survive',
  got.length === 1 && got[0].text === 'He said "no" and left.',
  got[0]?.text ?? '-');

got = salvageBlocks('{"blocks":[{"type":"nonsense","text":"Still worth showing."}]}');
check('E  an unrecognised type becomes prose rather than an invented heading',
  got.length === 1 && got[0].type === 'answer',
  got[0]?.type ?? '-');

// Ordinary prose must not be mistaken for a truncated reply.
check('F  prose is left to the text splitter',
  salvageBlocks('Your stop is too far away. Move it up.').length === 0 &&
    salvageBlocks('').length === 0,
  'prose and empty both yield nothing');

// A reply cut off before any block completed has nothing to salvage, and must
// say so rather than handing back half an object.
check('G  a reply cut before the first block closes yields nothing',
  salvageBlocks('{"blocks":[{"type":"answer","text":"half a sen').length === 0,
  'no partial block recovered');

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
