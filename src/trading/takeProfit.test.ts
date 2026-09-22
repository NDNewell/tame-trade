// Which side of the market a take profit is allowed to sit on.
import { chooseTakeProfits, takeProfitProblem } from './takeProfit.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

check('A  closing a long above the market is fine',
  takeProfitProblem('sell', 110, 100) === undefined, 'sell 110 @ 100');

check('B  closing a long below the market is refused, and points at stop',
  /not above/.test(takeProfitProblem('sell', 95, 100) ?? '') &&
    /stop <price>/.test(takeProfitProblem('sell', 95, 100) ?? ''),
  takeProfitProblem('sell', 95, 100) ?? 'undefined');

check('C  closing a short below the market is fine',
  takeProfitProblem('buy', 90, 100) === undefined, 'buy 90 @ 100');

check('D  closing a short above the market is refused',
  /not below/.test(takeProfitProblem('buy', 105, 100) ?? ''),
  takeProfitProblem('buy', 105, 100) ?? 'undefined');

check('E  at the market is refused either way: it would fire on arrival',
  takeProfitProblem('sell', 100, 100) !== undefined &&
    takeProfitProblem('buy', 100, 100) !== undefined,
  'price equal to market');

check('F  with no market price it is left to the exchange',
  takeProfitProblem('sell', 95, undefined) === undefined &&
    takeProfitProblem('sell', 95, 0) === undefined,
  'marketPrice undefined / 0');

// --- choosing which take profit to move ---------------------------------------

const ladder = [
  { id: 'a', trigger: 105 },
  { id: 'b', trigger: 110 },
  { id: 'c', trigger: 120 },
];

let choice = chooseTakeProfits(ladder, 110, 0.01);
check('G  the old price names the one to move',
  choice.matches?.length === 1 && choice.matches[0].id === 'b',
  JSON.stringify(choice));

choice = chooseTakeProfits(ladder, 111, 0.01);
check('H  a price nothing rests at is refused, and says what is there',
  /No take profit at 111/.test(choice.problem ?? '') && /105, 110, 120/.test(choice.problem ?? ''),
  JSON.stringify(choice));

choice = chooseTakeProfits(ladder, undefined, 0.01);
check('I  with several resting, no old price is a question, not a guess',
  /Say which/.test(choice.problem ?? ''),
  JSON.stringify(choice));

choice = chooseTakeProfits([ladder[0]], undefined, 0.01);
check('J  with one resting, the old price can be left out',
  choice.matches?.length === 1 && choice.matches[0].id === 'a',
  JSON.stringify(choice));

choice = chooseTakeProfits([{ id: 'x', trigger: 110 }], 110.2, 0.5);
check('K  the match allows for the exchange having rounded to the tick',
  choice.matches?.[0]?.id === 'x',
  JSON.stringify(choice));

choice = chooseTakeProfits([{ id: 'x', trigger: 110 }], 110.3, 0.5);
check('L  but no further than half a tick',
  choice.problem !== undefined,
  JSON.stringify(choice));

choice = chooseTakeProfits([{ id: 'p', trigger: 110 }, { id: 'q', trigger: 110 }, ladder[2]], 110, 0.01);
check('M  two orders at one level move together',
  choice.matches?.map((o) => o.id).join() === 'p,q',
  JSON.stringify(choice));

choice = chooseTakeProfits([], 110, 0.01);
check('N  nothing resting is said plainly',
  /No take profit found/.test(choice.problem ?? ''),
  JSON.stringify(choice));

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
