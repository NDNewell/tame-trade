// The tracker exists for one reason: a standing condition must not be able to
// fill the log. Most of these cases are that claim from different angles.
import { BEHAVIOURS, Severity } from './behaviours.js';
import { FindingTracker } from './findingTracker.js';
import { Finding } from './guardrails.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const NOW = 10_000_000;

const finding = (
  id: 'risk-per-trade' | 'profit-giveback' | 'loss-streak',
  severity: Severity,
  detail = 'detail'
): Finding => ({
  behaviour: BEHAVIOURS[id],
  severity,
  detail,
  evidence: {},
});

// --- the case the module was written for ----------------------------------

const standing = new FindingTracker();
const first = standing.update([finding('risk-per-trade', 'hold')], NOW);

check('a new finding is announced once',
  first.length === 1 && first[0].kind === 'appeared',
  'the first sweep on which it is true is news');

let repeats = 0;
for (let sweep = 1; sweep <= 120; sweep++) {
  // An hour of sweeps at thirty seconds apiece, with the detail line moving
  // the way a live percentage does.
  repeats += standing.update(
    [finding('risk-per-trade', 'hold', `${8 + (sweep % 3) * 0.01}% of equity`)],
    NOW + sweep * 30_000
  ).length;
}

check('   an hour of the same condition says nothing further',
  repeats === 0,
  `120 further sweeps produced ${repeats} transitions -- this is the whole point of the file`);

check('   and it is still reported as active',
  standing.active().length === 1 && standing.any(),
  'silent is not the same as gone; the status line still has it');

check('   with the newest wording, not the wording it first appeared with',
  standing.active()[0].finding.detail.includes('% of equity'),
  'the status line is rewritten in place, so it shows current numbers');

check('   and the time it has been standing',
  standing.active()[0].since === NOW,
  'since is when it became true, not when it was last seen');

// --- edges that must still be reported ------------------------------------

const escalating = new FindingTracker();
escalating.update([finding('loss-streak', 'notice')], NOW);
const worse = escalating.update([finding('loss-streak', 'hold')], NOW + 30_000);

check('getting worse is news',
  worse.length === 1 && worse[0].kind === 'escalated' && worse[0].from === 'notice',
  'a condition that has climbed is a different fact from the one already reported');

const easing = new FindingTracker();
easing.update([finding('loss-streak', 'block')], NOW);
const softer = easing.update([finding('loss-streak', 'notice')], NOW + 30_000);

check('   getting better quietly is not',
  softer.length === 0,
  'nothing to act on, and a line saying so would be noise');

check('   but the status line follows it down',
  easing.active()[0].finding.severity === 'notice',
  'the displayed severity is current even when the drop went unannounced');

const clearing = new FindingTracker();
clearing.update([finding('profit-giveback', 'notice')], NOW);
const gone = clearing.update([], NOW + 30_000);

check('a condition ending is news',
  gone.length === 1 && gone[0].kind === 'cleared' && gone[0].behaviour === 'profit-giveback',
  'the operator was told it started; they are owed the end of it');

check('   and it stops being active',
  !clearing.any(),
  'cleared means gone from the status line too');

check('   and it does not clear twice',
  clearing.update([], NOW + 60_000).length === 0,
  'a second empty sweep has nothing left to report');

// A condition measured against a threshold sits either side of it as the mark
// moves. This used to be announced every time it crossed back, on the reasoning
// that it had genuinely re-started -- which is true, and still made six log
// lines in six minutes saying the same thing about the same afternoon.
const returning = new FindingTracker();
returning.update([finding('profit-giveback', 'notice')], NOW);
returning.update([], NOW + 30_000);
const back = returning.update([finding('profit-giveback', 'notice')], NOW + 60_000);

check('   a condition that flaps back within the quiet period says nothing',
  back.length === 0,
  'it is on the status line, which is rewritten in place; the log is for news');

check('   but it is active again, and its clock restarts',
  returning.any() && returning.active()[0].since === NOW + 60_000,
  'silence is about what is said, never about what is measured');

check('   and it is announced again once the quiet period has passed',
  returning.update([], NOW + 20 * 60_000).length === 0 &&
    returning.update([finding('profit-giveback', 'notice')], NOW + 21 * 60_000)[0]?.kind ===
      'appeared',
  'a condition returning much later is news again');

// Getting worse always breaks through, however recently it was mentioned.
const worsening = new FindingTracker();
worsening.update([finding('profit-giveback', 'notice')], NOW);
worsening.update([], NOW + 30_000);
const louder = worsening.update([finding('profit-giveback', 'hold')], NOW + 60_000);

check('   a condition that comes back worse is announced whatever the quiet period',
  louder.length === 1 && louder[0].kind === 'appeared',
  'the quiet period suppresses repetition, never escalation');

// Nothing was said when it appeared, so there is nothing to say has stopped.
const quiet = new FindingTracker();
quiet.update([finding('profit-giveback', 'notice')], NOW);
quiet.update([], NOW + 30_000);
quiet.update([finding('profit-giveback', 'notice')], NOW + 60_000);

check('   and a suppressed condition does not announce its own clearing',
  quiet.update([], NOW + 90_000).length === 0,
  'a bare "cleared" for something never announced reads as a fault in the guard');

// --- several at once -------------------------------------------------------

const several = new FindingTracker();
several.update(
  [finding('risk-per-trade', 'hold'), finding('profit-giveback', 'notice')],
  NOW
);
const mixed = several.update(
  [finding('profit-giveback', 'notice'), finding('loss-streak', 'block')],
  NOW + 30_000
);

check('one sweep can clear one finding and raise another',
  mixed.length === 2 &&
    mixed[0].kind === 'cleared' &&
    mixed[0].behaviour === 'risk-per-trade' &&
    mixed[1].kind === 'appeared' &&
    mixed[1].behaviour === 'loss-streak',
  'clearances lead, so the log reads as one thing ending before the next begins');

check('   active is ordered worst first',
  several.active()[0].finding.severity === 'block',
  `the status line leads with the thing most worth acting on`);

// --- reset -----------------------------------------------------------------

const stopping = new FindingTracker();
stopping.update([finding('risk-per-trade', 'hold')], NOW);
stopping.reset();

check('reset reports nothing',
  !stopping.any(),
  'guardrails switched off did not resolve the condition, so it must not claim it cleared');

check('   and the next sweep re-announces what is still true',
  stopping.update([finding('risk-per-trade', 'hold')], NOW + 30_000)[0].kind === 'appeared',
  'we stopped looking and started again; announcing it is the honest story');

console.log(`\n${failures === 0 ? 'PASS: all finding-tracker cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
