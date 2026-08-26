// Which key wins, and whether the coach can say why it is off.
//
// No network: constructing the client does not call anything, and nothing here
// asks it a question. These are the resolution rules only, which is the part
// that fails quietly -- a coach running against the wrong account looks exactly
// like one running against the right one.
import { Coach } from './coach.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const ENV = 'ANTHROPIC_API_KEY';
const original = process.env[ENV];

/** Runs `body` with the environment key set to `value`, then puts it back. */
const withEnv = <T>(value: string | undefined, body: () => T): T => {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  }
};

// --- nothing configured ----------------------------------------------------

withEnv(undefined, () => {
  const coach = new Coach();
  check('with no key anywhere the coach is off',
    !coach.available() && coach.keySource() === 'none',
    'and says so as "none" rather than pretending to be configured');
});

// --- one source at a time --------------------------------------------------

withEnv('sk-ant-from-the-shell', () => {
  const coach = new Coach();
  check('an exported key is picked up',
    coach.available() && coach.keySource() === 'environment',
    'the path that worked before the profile could hold one');
});

withEnv(undefined, () => {
  const coach = new Coach({ apiKey: 'sk-ant-from-the-profile' });
  check('a stored key is picked up',
    coach.available() && coach.keySource() === 'profile',
    'entered on the home menu, read out of ~/.tame/config.json');
});

// --- both, which is the case that matters ---------------------------------

withEnv('sk-ant-from-the-shell', () => {
  const coach = new Coach({ apiKey: 'sk-ant-from-the-profile' });
  check('the stored key beats the exported one',
    coach.keySource() === 'profile',
    'someone who just typed a key in is entitled to have that one used');
});

withEnv('sk-ant-from-the-shell', () => {
  const coach = new Coach({ apiKey: '   ' });
  check('   and whitespace does not count as a stored key',
    coach.keySource() === 'environment',
    'a profile field holding only spaces is an absent key, not an empty one');
});

// --- adopting a key after construction ------------------------------------

withEnv(undefined, () => {
  const coach = new Coach();
  check('a coach built before the profile was read can come to life',
    !coach.available() && (coach.useKey('sk-ant-later'), coach.available()),
    'the guard is constructed before anything is read from disk, so this is the normal path');

  check('   and can be switched off again',
    (coach.useKey(undefined), !coach.available() && coach.keySource() === 'none'),
    'removing the key on the menu takes effect on the next session');
});

withEnv('sk-ant-from-the-shell', () => {
  const coach = new Coach({ apiKey: 'sk-ant-from-the-profile' });
  coach.useKey(undefined);
  check('   removing a stored key falls back to the exported one',
    coach.available() && coach.keySource() === 'environment',
    'rather than leaving the coach off while a usable key is still exported');
});

// --- the off switch --------------------------------------------------------

withEnv('sk-ant-from-the-shell', () => {
  const coach = new Coach({ enabled: false });
  check('enabled:false beats any key',
    !coach.available(),
    'an off switch that a configured key could override would not be one');
});

console.log(`\n${failures === 0 ? 'PASS: all coach key cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
