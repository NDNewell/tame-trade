// The clock watch, driven by two fake clocks.
//
// The thing being pinned is what the operator reads: one warning when the
// stepping starts, a reminder with a count while it continues, one line when
// it stops, and nothing at all while the clock behaves. The fault it reports
// is real and recurring (2026-09-01, 2026-09-13), so the wording is checked
// too: the fix is named in the same line as the symptom.

import { ClockWatch, CLOCK_FIX } from './clockWatch.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

/** Two clocks the test moves by hand, and everything the watch said. */
function rig() {
  let wall = 1_700_000_000_000;
  let steady = 5_000;
  const said: Array<{ severity: string; message: string }> = [];
  const watch = new ClockWatch({
    wall: () => wall,
    steady: () => steady,
    report: (severity, message) => said.push({ severity, message }),
    remindEveryMs: 5 * 60_000,
    settleAfterMs: 60_000,
  });
  /** A second passes on both clocks, then the watch looks. */
  const second = (wallStepMs = 0) => {
    wall += 1_000 + wallStepMs;
    steady += 1_000;
    watch.tick();
  };
  return { watch, said, second };
}

// --- a well-behaved clock ----------------------------------------------------

{
  const { watch, said, second } = rig();
  for (let i = 0; i < 120; i++) second(i % 2 === 0 ? 40 : -40);
  check('forty milliseconds of jitter is not a step',
    said.length === 0 && !watch.isStepping(),
    'a timer that fires a little late moves both clocks the same way; only a disagreement counts');
}

// --- the fault as it actually happens ----------------------------------------

{
  const { watch, said, second } = rig();
  second();
  second(-8_600);
  check('a backwards step is reported at once, with the size and the fix',
    said.length === 1 &&
      said[0].severity === 'WARNING' &&
      said[0].message.startsWith('The system clock just jumped back 8.6s.') &&
      said[0].message.endsWith(CLOCK_FIX) &&
      watch.isStepping(),
    said[0]?.message ?? 'nothing said');

  // The real pattern: +8.1s from the host, -8.6s from NTP, every five seconds.
  for (let i = 0; i < 240; i++) second(i % 5 === 0 ? (i % 10 === 0 ? 8_100 : -8_600) : 0);
  check('   four minutes of it adds nothing to the log',
    said.length === 1,
    `${said.length} line(s); a warning every five seconds would bury the activity log`);

  for (let i = 0; i < 120; i++) second(i % 5 === 0 ? (i % 10 === 0 ? 8_100 : -8_600) : 0);
  check('   the reminder arrives after five minutes with a count',
    said.length === 2 &&
      /still being stepped: \d+ jumps in the last 5 minutes/.test(said[1].message) &&
      said[1].message.endsWith(CLOCK_FIX),
    said[1]?.message ?? 'no reminder');
  const jumps = Number(/(\d+) jumps/.exec(said[1]?.message ?? '')?.[1]);
  check('   and the count is the steps since the last line, not since the start',
    jumps === 61,
    `${jumps} counted; one step per five seconds for the 300s between the warning and the reminder is 60, plus the step that triggered it`);
}

// --- it stops ----------------------------------------------------------------

{
  const { watch, said, second } = rig();
  second();
  second(-8_600);
  for (let i = 0; i < 59; i++) second();
  check('fifty-nine quiet seconds is not yet settled',
    said.length === 1 && watch.isStepping(),
    'a host that steps every five seconds needs more than a few quiet ticks to be trusted');
  second();
  check('   the sixtieth says so, once',
    said.length === 2 &&
      said[1].severity === 'SYSTEM' &&
      said[1].message === 'The system clock has held steady for 60s.' &&
      !watch.isStepping(),
    said[1]?.message ?? 'nothing said');
  for (let i = 0; i < 300; i++) second();
  check('   and stays quiet after',
    said.length === 2,
    `${said.length} line(s)`);

  second(2_000);
  check('   a fresh step after settling is a fresh first warning',
    said.length === 3 && said[2].message.startsWith('The system clock just jumped forward 2.0s.'),
    said[2]?.message ?? 'nothing said');
}

// --- the first tick ------------------------------------------------------------

{
  const { said, second } = rig();
  second();
  check('the first reading is a baseline, never a step',
    said.length === 0,
    'there is nothing to compare it with');
}

console.log(`\n${failures === 0 ? 'PASS: all clock watch cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
