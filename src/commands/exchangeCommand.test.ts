// How a typed take profit is read. The stop it is modelled on has the same
// shape, so the two are checked side by side.
import { OrderType } from './exchangeCommand.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const refused = async (command: string): Promise<string | undefined> => {
  try {
    await OrderType.parseCommand(command);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

let parsed = await OrderType.parseCommand('tp 110');
check('A  tp with a price alone covers whatever is open',
  parsed?.type === OrderType.TAKE_PROFIT && parsed.price === 110 && parsed.quantity === undefined,
  JSON.stringify(parsed));

parsed = await OrderType.parseCommand('tp 110 500');
check('B  the price comes first, then the size, as for a stop',
  parsed?.type === OrderType.TAKE_PROFIT && parsed.price === 110 && parsed.quantity === 500,
  JSON.stringify(parsed));

parsed = await OrderType.parseCommand('stop 95 500');
check('C  stop is read exactly as before',
  parsed?.type === OrderType.STOP && parsed.price === 95 && parsed.quantity === 500,
  JSON.stringify(parsed));

check('D  tp with no price is refused, with the usage',
  /tp <price> \[size\]/.test((await refused('tp')) ?? ''),
  (await refused('tp')) ?? 'accepted');

check('E  too many words are refused',
  (await refused('tp 110 500 now')) !== undefined,
  (await refused('tp 110 500 now')) ?? 'accepted');

check('F  a size that is not a number is refused',
  /tp <price> \[size\]/.test((await refused('tp 110 lots')) ?? ''),
  (await refused('tp 110 lots')) ?? 'accepted');

check('G  a price of zero or less is refused',
  (await refused('tp 0')) !== undefined && (await refused('tp -5')) !== undefined,
  `${await refused('tp 0')} / ${await refused('tp -5')}`);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
