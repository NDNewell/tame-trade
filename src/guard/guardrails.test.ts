// The decisions, as opposed to the measurements. Most of these exist to hold
// the three rules the module claims: exits are never obstructed, only limits
// the operator set can refuse, and nothing closes a position unasked.
import { DEFAULT_POLICY, GuardPolicy, resolvePolicy } from './guardPolicy.js';
import { Guardrails } from './guardrails.js';
import { PositionContext } from './detectors.js';
import { deriveSnapshot, JournalEvent, SessionSnapshot } from './sessionJournal.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}\n        ${detail}`);
  if (!ok) failures++;
};

const NOW = 10_000_000;
const MARKET = 'BTC/USDT:USDT';

/** A session that is three losses down, the most recent one a minute ago. */
const losingSession = (): SessionSnapshot => {
  const events: JournalEvent[] = [];
  for (let i = 0; i < 3; i++) {
    const at = NOW - (5 - i) * 60_000;
    events.push({ type: 'fill', at, market: MARKET, side: 'buy', size: 1, price: 100 });
    events.push({ type: 'fill', at: at + 1000, market: MARKET, side: 'sell', size: 1, price: 90 });
  }
  return deriveSnapshot(events, NOW, 'USDT');
};

const policy = (over: Partial<GuardPolicy> = {}): GuardPolicy =>
  resolvePolicy({ ...DEFAULT_POLICY, ...over });

const proposal = (intent: 'entry' | 'exit' | 'protective') => ({
  market: MARKET,
  side: 'buy' as const,
  intent,
  size: 1,
});

// --- rule one: exits and protection are never obstructed -------------------
const hostile = policy({
  dailyLossLimit: 1,
  severity: { 'revenge-entry': 'block', 'loss-streak': 'block' },
});
const locked = deriveSnapshot(
  [{ type: 'lockout', at: NOW - 1000, until: NOW + 600_000, behaviour: 'loss-streak', reason: 'x' }],
  NOW,
  'USDT'
);

for (const intent of ['exit', 'protective'] as const) {
  const verdict = new Guardrails(hostile).review({
    now: NOW,
    snapshot: losingSession(),
    proposal: proposal(intent),
  });
  check(`   a ${intent} order is allowed even under the harshest policy`,
    verdict.action === 'allow', `action=${verdict.action}`);

  const underLockout = new Guardrails(hostile).review({
    now: NOW,
    snapshot: locked,
    proposal: proposal(intent),
  });
  check(`   a ${intent} order is allowed even during a lockout`,
    underLockout.action === 'allow', `action=${underLockout.action}`);
}

// --- rule two: shipped defaults never refuse -------------------------------
const defaults = new Guardrails(policy());
const onDefaults = defaults.review({
  now: NOW,
  snapshot: losingSession(),
  proposal: proposal('entry'),
});
check('   the shipped defaults hold an order but never refuse one',
  onDefaults.action === 'confirm' && onDefaults.findings.length > 0,
  `action=${onDefaults.action} findings=${onDefaults.findings.map((f) => f.behaviour.id).join(', ')}`);

check('   an operator-set loss limit is what turns a hold into a refusal',
  new Guardrails(policy({ dailyLossLimit: 10 })).review({
    now: NOW,
    snapshot: losingSession(),
    proposal: proposal('entry'),
  }).action === 'refuse',
  'down 30 against a limit of 10');

// --- lockouts --------------------------------------------------------------
const lockedVerdict = defaults.review({
  now: NOW,
  snapshot: locked,
  proposal: proposal('entry'),
});
check('   a lockout refuses entries and says how long is left',
  lockedVerdict.action === 'refuse' && lockedVerdict.lockedUntil === NOW + 600_000,
  `action=${lockedVerdict.action} headline="${lockedVerdict.headline}"`);

// --- muting and severity ---------------------------------------------------
const muted = new Guardrails(
  policy({ muted: ['revenge-entry', 'loss-streak', 'rapid-fire', 'size-escalation'] })
).review({ now: NOW, snapshot: losingSession(), proposal: proposal('entry') });
check('   a muted behaviour cannot be raised back into a decision',
  muted.findings.every((f) => f.behaviour.id !== 'revenge-entry'),
  `findings=[${muted.findings.map((f) => f.behaviour.id).join(', ')}]`);

const softened = new Guardrails(
  policy({
    severity: {
      'revenge-entry': 'notice',
      'loss-streak': 'notice',
      'rapid-fire': 'notice',
      'size-escalation': 'notice',
    },
  })
).review({ now: NOW, snapshot: losingSession(), proposal: proposal('entry') });
check('   turning everything down to a notice never stops an order',
  softened.action === 'allow' && softened.findings.length > 0,
  `action=${softened.action} findings=${softened.findings.length}`);

// --- guardrails off --------------------------------------------------------
check('   a disabled guard finds nothing and allows everything',
  new Guardrails(policy({ enabled: false })).review({
    now: NOW,
    snapshot: losingSession(),
    proposal: proposal('entry'),
  }).action === 'allow',
  'guard off');

// --- rule three: nothing closes a position unasked -------------------------
const unprotected: PositionContext = {
  market: MARKET,
  side: 'long',
  size: 1,
  entryPrice: 100,
  hasProtectiveStop: false,
  openedAt: NOW - 60 * 60_000,
  unrealizedPnl: -500,
};

const blocking = policy({ severity: { 'no-stop': 'block' } });
const unauthorised = new Guardrails(blocking).sweep({
  now: NOW,
  snapshot: losingSession(),
  positions: [unprotected],
});
const exits = unauthorised.interventions.filter((i) => i.type === 'assisted-exit');
check('   a blocking risk finding proposes an exit rather than performing one',
  exits.length === 1 && exits[0].type === 'assisted-exit' && exits[0].authorised === false,
  `interventions=${unauthorised.interventions.map((i) => i.type).join(', ')} authorised=${
    exits[0]?.type === 'assisted-exit' ? exits[0].authorised : 'n/a'
  }`);

const authorised = new Guardrails(
  policy({ severity: { 'no-stop': 'block' }, autoExit: ['no-stop'] })
).sweep({ now: NOW, snapshot: losingSession(), positions: [unprotected] });
const authorisedExit = authorised.interventions.find((i) => i.type === 'assisted-exit');
check('   naming the behaviour in autoExit is what authorises it',
  authorisedExit?.type === 'assisted-exit' && authorisedExit.authorised === true,
  `authorised=${authorisedExit?.type === 'assisted-exit' ? authorisedExit.authorised : 'n/a'}`);

check('   an unprotected position that is losing is worked out firmly, not patiently',
  authorisedExit?.type === 'assisted-exit' && authorisedExit.urgency === 'firm',
  `urgency=${authorisedExit?.type === 'assisted-exit' ? authorisedExit.urgency : 'n/a'}`);

check('   a hold-severity finding never produces an intervention',
  new Guardrails(policy()).sweep({
    now: NOW,
    snapshot: losingSession(),
    positions: [unprotected],
  }).interventions.length === 0,
  'defaults reach hold, and hold does not act');

// --- a session-wide finding still reaches the open positions ---------------
const bleeding = new Guardrails(
  policy({ dailyLossLimit: 10, severity: { 'daily-loss-limit': 'block' } })
).sweep({ now: NOW, snapshot: losingSession(), positions: [unprotected] });
const bleedExit = bleeding.interventions.find((i) => i.type === 'assisted-exit');
check('   past the day\'s limit with a position open, an exit is offered too',
  bleedExit?.type === 'assisted-exit' && bleedExit.market === MARKET,
  `interventions=[${bleeding.interventions.map((i) => i.type).join(', ')}]`);
check('   an unprotected position past the limit is worked out immediately',
  bleedExit?.type === 'assisted-exit' && bleedExit.urgency === 'immediate',
  `urgency=${bleedExit?.type === 'assisted-exit' ? bleedExit.urgency : 'n/a'}`);

check('   a trade count is a reason to stop trading, not to close a position',
  new Guardrails(
    policy({ severity: { overtrading: 'block' }, maxTradesPerSession: 1 })
  )
    .sweep({ now: NOW, snapshot: losingSession(), positions: [unprotected] })
    .interventions.every((i) => i.type !== 'assisted-exit'),
  'overtrading never closes a position');

// --- lockouts do not stack -------------------------------------------------
const alreadyLocked = new Guardrails(
  policy({ dailyLossLimit: 10, severity: { 'daily-loss-limit': 'block' } })
).sweep({ now: NOW, snapshot: locked, positions: [] });
check('   a lockout already in force is not extended by every sweep',
  alreadyLocked.interventions.every((i) => i.type !== 'lockout'),
  `interventions=[${alreadyLocked.interventions.map((i) => i.type).join(', ')}]`);

// --- two positions are two problems ----------------------------------------
const second: PositionContext = { ...unprotected, market: 'ETH/USDT:USDT' };
const both = new Guardrails(policy()).sweep({
  now: NOW,
  snapshot: losingSession(),
  positions: [unprotected, second],
});
check('   two unprotected positions are both reported',
  both.findings.filter((f) => f.behaviour.id === 'no-stop').length === 2,
  `no-stop findings=${both.findings.filter((f) => f.behaviour.id === 'no-stop').length}`);

// --- session-wide findings are reported once -------------------------------
check('   a session-wide finding is not repeated once per position',
  both.findings.filter((f) => f.behaviour.id === 'loss-streak').length === 1,
  `loss-streak findings=${both.findings.filter((f) => f.behaviour.id === 'loss-streak').length}`);

// --- a corrupt stored policy cannot disable the guard ----------------------
const corrupt = resolvePolicy({
  revengeWindowMs: 'soon' as unknown as number,
  muted: 'everything' as unknown as [],
  dailyLossLimit: -5,
});
check('   a threshold stored as nonsense falls back to its default',
  corrupt.revengeWindowMs === DEFAULT_POLICY.revengeWindowMs && Array.isArray(corrupt.muted),
  `window=${corrupt.revengeWindowMs} muted=${JSON.stringify(corrupt.muted)}`);
check('   a negative loss limit reads as no limit rather than an instant refusal',
  corrupt.dailyLossLimit === undefined, `limit=${corrupt.dailyLossLimit}`);

console.log(`\n${failures === 0 ? 'PASS: all guardrail cases' : `FAIL: ${failures} case(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
