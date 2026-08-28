// Reading a working order the way the panel and the coach both have to read it.
import { describeOrder, orderSentence } from './orderView.js';
import { buildTrailTag } from './trailTag.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const fixed = () => 0.5;

// A conditional stop covering whatever is open. The exchange sizes it zero.
let view = describeOrder({
  id: '1',
  side: 'sell',
  amount: 0,
  remaining: 0,
  triggerPrice: 94.5,
  info: { closeOnTrigger: true },
});
check('A  a zero-sized trigger order is the whole position, not nothing',
  view.wholePosition === true && view.quantity === undefined && view.type === 'STOP',
  orderSentence(view));

check('B  and it says so in words',
  orderSentence(view).includes('the whole position') && !orderSentence(view).includes(' 0'),
  orderSentence(view));

// A zero-sized limit order is a different matter and keeps its zero.
view = describeOrder({ id: '2', side: 'buy', amount: 0, remaining: 0, price: 100, type: 'limit' });
check('C  a zero-sized limit order is not treated as the whole position',
  view.wholePosition === false && view.quantity === 0,
  orderSentence(view));

// A delayed ATR trail that has not armed. It carries no peg, so nothing on the
// order itself distinguishes it from a stop that will never move.
const delayed = buildTrailTag({ kind: 'atr', value: 3, timeframe: '15m', armPrice: 96.2 }, fixed);
view = describeOrder(
  { id: '3', side: 'sell', amount: 0, remaining: 0, triggerPrice: 94.5, clientOrderId: delayed },
  { isTrailArmed: () => false }
);
check('D  an unarmed delayed trail is ARM, not TRAIL',
  view.managed === 'ARM' && view.trail?.armed === false && view.trail?.armPrice === 96.2,
  `${view.managed} ${JSON.stringify(view.trail)}`);

check('E  and the sentence says it is not moving yet',
  orderSentence(view).includes('96.2') && orderSentence(view).includes('does not move'),
  orderSentence(view));

// The same order once price has reached the arming price.
view = describeOrder(
  { id: '3', side: 'sell', amount: 0, remaining: 0, triggerPrice: 94.5, clientOrderId: delayed },
  { isTrailArmed: (id) => id === '3' }
);
check('F  once armed it is an ATR trail',
  view.managed === 'ATR' && view.trail?.armed === true,
  orderSentence(view));

check('G  the sentence carries the multiple and the timeframe',
  orderSentence(view).includes('3x ATR(15m)'),
  orderSentence(view));

// An immediate trail has no arming price, so it is armed by definition.
const immediate = buildTrailTag({ kind: 'atr', value: 2, timeframe: '1h' }, fixed);
view = describeOrder(
  { id: '4', side: 'sell', remaining: 1, triggerPrice: 90, clientOrderId: immediate },
  { isTrailArmed: () => false }
);
check('H  an immediate trail does not wait to be armed',
  view.managed === 'ATR' && view.trail?.armed === true,
  orderSentence(view));

// A trail the exchange runs itself, via a peg.
view = describeOrder({
  id: '5',
  side: 'sell',
  remaining: 2,
  triggerPrice: 88,
  info: { pegOffsetValueRp: -50, pegPriceType: 'TrailingStopPeg' },
});
check('I  an exchange peg reads as a trail with no terms of ours',
  view.managed === 'TRAIL' && view.exchangeTrailing === true && view.trail === undefined,
  orderSentence(view));

// A chase outranks everything: it means this process is working the order now.
view = describeOrder(
  { id: '6', side: 'buy', remaining: 1, price: 100, type: 'limit' },
  { chaseOrderId: '6' }
);
check('J  a chased order is CHASE',
  view.managed === 'CHASE' && orderSentence(view).includes('chased'),
  orderSentence(view));

// A plain resting stop, which is what all of the above would look like if the
// tag were not read.
view = describeOrder({ id: '7', side: 'sell', remaining: 3, triggerPrice: 92 });
check('K  a plain stop claims nothing',
  view.managed === undefined && view.trail === undefined && view.type === 'STOP',
  orderSentence(view));

// Partial fills survive, since a half-filled entry is a different situation.
view = describeOrder({
  id: '8',
  side: 'buy',
  amount: 10,
  remaining: 4,
  filled: 6,
  price: 99,
  type: 'limit',
  status: 'open',
});
check('L  a partially filled order says how much is done',
  view.status === 'PARTIAL' && orderSentence(view).includes('6'),
  orderSentence(view));

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
