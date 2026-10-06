// 'bid' and 'ask' as prices in order commands.
import { substituteTopOfBook, topOfBookWords } from './priceShorthand.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const book = { bid: 101.2, ask: 101.3 };
const market = 'SOL/USDT:USDT';

let result = substituteTopOfBook('limit buy 10 bid', book, market);
check('A  a limit buy at the bid joins the bid',
  'command' in result && result.command === 'limit buy 10 101.2',
  JSON.stringify(result));

result = substituteTopOfBook('tp ask', book, market);
check('B  a take profit at the ask',
  'command' in result && result.command === 'tp 101.3',
  JSON.stringify(result));

result = substituteTopOfBook('stop limit buy ask bid 10', book, market);
check('C  both words in one command, each to its own price',
  'command' in result && result.command === 'stop limit buy 101.3 101.2 10',
  JSON.stringify(result));

result = substituteTopOfBook('move tp 110 ask', book, market);
check('D  move tp takes the ask as its new price',
  'command' in result && result.command === 'move tp 110 101.3',
  JSON.stringify(result));

result = substituteTopOfBook('coach is the ask thin?', book, market);
check('E  a coach question is left alone',
  'command' in result && result.command === 'coach is the ask thin?',
  JSON.stringify(result));

result = substituteTopOfBook('buy ask', book, market);
check('F  a market order takes no price, so the word is not a price there',
  'command' in result && result.command === 'buy ask',
  JSON.stringify(result));

result = substituteTopOfBook('limit buy 10 bid', { ask: 101.3 }, market);
check('G  a missing bid refuses rather than guesses, and says so',
  'error' in result && /No bid price is available for SOL\/USDT:USDT/.test(result.error) &&
    /No order was placed/.test(result.error),
  JSON.stringify(result));

result = substituteTopOfBook('limit sell 10 ask', { bid: 101.2, ask: 0 }, market);
check('H  an ask of zero is as missing as no ask',
  'error' in result && /No ask price/.test(result.error),
  JSON.stringify(result));

result = substituteTopOfBook('limit buy 10 101.25', book, market);
check('I  a typed price is untouched',
  'command' in result && result.command === 'limit buy 10 101.25',
  JSON.stringify(result));

check('J  the words are found only in priced commands',
  topOfBookWords('limit sell 10 ask')?.ask === true &&
    topOfBookWords('limit sell 10 ask')?.bid === false &&
    topOfBookWords('chase buy 10') === undefined &&
    topOfBookWords('market bid/USDT') === undefined,
  'limit sell 10 ask / chase buy 10 / market bid/USDT');

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
