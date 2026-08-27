// The thread's job is to be interruptible without being intrusive: questions
// always answered, remarks strictly rationed. Both halves are checked here
// against a coach that never touches the network.
import { BEHAVIOURS, Severity } from './behaviours.js';
import { Coach } from './coach.js';
import { CoachThread } from './coachThread.js';
import { Finding } from './guardrails.js';
import { deriveSnapshot } from './sessionJournal.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const NOW = 10_000_000;
const snapshot = () => deriveSnapshot([], NOW, 'USDT');

const finding = (severity: Severity): Finding => ({
  behaviour: BEHAVIOURS['risk-per-trade'],
  severity,
  detail: '242.50 USDT, 8% of equity',
  evidence: {},
});

/** A coach that answers instantly and records what it was asked. */
const fakeCoach = (
  over: Partial<{
    available: boolean;
    reply: string | undefined;
    remark: string | undefined;
  }> = {}
) => {
  const calls: Array<{ kind: string; question: string; history: number }> = [];
  const coach = {
    available: () => over.available !== false,
    converse: async (question: string, history: unknown[]) => {
      calls.push({ kind: 'converse', question, history: history.length });
      // The coach answers in blocks now; undefined still means it could not.
      const reply = 'reply' in over ? over.reply : 'A written answer.';
      return reply === undefined ? undefined : [{ type: 'answer', text: reply }];
    },
    remark: async () => {
      calls.push({ kind: 'remark', question: '', history: 0 });
      return 'remark' in over ? over.remark : 'An unprompted line.';
    },
  } as unknown as Coach;
  return { coach, calls };
};

const threadWith = (coach: Coach, clock: () => number = () => NOW) =>
  new CoachThread({ coach, snapshot, clock, nudgeIntervalMs: 5 * 60_000 });

// --- questions -------------------------------------------------------------

const asked = fakeCoach();
const thread = threadWith(asked.coach);
await thread.ask('why is my risk so high?');

check('a question and its answer both land in the thread',
  thread.all().length === 2 &&
    thread.all()[0].kind === 'operator' &&
    thread.all()[1].kind === 'coach' &&
    thread.all()[1].text === 'A written answer.',
  'the panel shows what was asked as well as what came back');

await thread.ask('and the give-back?');

check('   a follow-up carries the thread behind it',
  asked.calls[1].history === 2,
  `the second call saw ${asked.calls[1].history} prior turns, so context survives`);

check('   and the newest question is not duplicated into that history',
  asked.calls[1].question === 'and the give-back?',
  'the question is passed once, as the question');

const blank = fakeCoach();
const ignoring = threadWith(blank.coach);
await ignoring.ask('   ');

check('   an empty question is not a call',
  blank.calls.length === 0 && ignoring.all().length === 0,
  'a stray return key must not cost a round trip');

const failing = fakeCoach({ reply: undefined });
const survived = threadWith(failing.coach);
await survived.ask('anything');

check('   a coach that cannot answer says so in its own voice',
  survived.all()[1].kind === 'system',
  'a failed call is the panel speaking, not the coach, and must not read as advice');

const off = fakeCoach({ available: false });
const unconfigured = threadWith(off.coach);
await unconfigured.ask('anything');

check('   with no coach configured the question is still shown',
  unconfigured.all().length === 2 &&
    unconfigured.all()[1].kind === 'system' &&
    off.calls.length === 0,
  'the operator sees what they typed and why nothing answered it');

// --- unprompted remarks ----------------------------------------------------

const nudging = fakeCoach();
let clock = NOW;
const nudged = threadWith(nudging.coach, () => clock);

check('a hold-level finding earns one remark',
  (await nudged.nudge(finding('hold'))) === true,
  'a guardrail that has just started applying is worth a sentence');

clock += 60_000;
check('   a second inside the window is dropped',
  (await nudged.nudge(finding('block'))) === false,
  'one minute after the last one; the interval is five');

clock += 5 * 60_000;
check('   one after the window is allowed',
  (await nudged.nudge(finding('block'))) === true,
  'the rate limit is a rate, not a mute');

clock += 10 * 60_000;
check('   but the same behaviour is capped for the session',
  (await nudged.nudge(finding('block'))) === false,
  'twice is heard; a third time is nagging, and the status line still shows it');

const quiet = fakeCoach();
const noticing = threadWith(quiet.coach);

check('   a notice never speaks unprompted',
  (await noticing.nudge(finding('notice'))) === false && quiet.calls.length === 0,
  'it is already on the status line and in the log; a third copy is noise');

const silent = fakeCoach({ available: false });
const unset = threadWith(silent.coach);

check('   and with no coach configured nothing is attempted',
  (await unset.nudge(finding('block'))) === false && unset.all().length === 0,
  'an unconfigured coach leaves no trace in the panel');

// --- the two paths together ------------------------------------------------

const both = fakeCoach();
const busy = threadWith(both.coach);
const question = busy.ask('what is my pace?');
const remark = busy.nudge(finding('block'));

check('a remark does not talk over a question',
  (await remark) === false,
  'the operator asked; the panel answers that first rather than both at once');
await question;

check('   and the question still completes',
  busy.all().length === 2 && busy.all()[1].kind === 'coach',
  'the dropped remark cost the answer nothing');

check('   busy is false once the thread is idle',
  !busy.busy(),
  'the panel stops showing a waiting line when nothing is outstanding');

console.log(`\n${failures === 0 ? 'PASS: all coach-thread cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
