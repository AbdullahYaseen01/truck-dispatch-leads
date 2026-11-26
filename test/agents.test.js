import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_SECRET = 'unit-secret-'.padEnd(48, 'y');
const { decideStatus } = await import('../src/agents/verification.js');
const { ruleIntent, intentBand } = await import('../src/agents/intent.js');
const { ruleClassify, latestReplyText } = await import('../src/agents/replies.js');
const { robotsAllows } = await import('../src/agents/crawler.js');
const { extractEmails, normalizeName } = await import('../src/lib/text.js');
const { checkGenerated } = await import('../src/agents/personalization.js');

const base = { syntax_ok: true, suppressed: null, duplicate_of: null, disposable: false, never_send_role: false, previously_bounced: false,
  dns: { domain_exists: true, mx: ['mx.a.com'], has_a: false, null_mx: false }, smtp: null, provider: null };

test('verification: an MX record alone is never treated as a verified mailbox', () => {
  assert.equal(decideStatus(base).status, 'unknown', 'MX only, no ownership evidence');
  assert.equal(decideStatus({ ...base, ownership: 'fmcsa_registration' }).status, 'likely_valid', 'published by the carrier, mailbox unconfirmed');
  assert.equal(decideStatus({ ...base, ownership: 'fmcsa_registration', smtp: { result: 'catch_all' } }).status, 'risky', 'catch-all beats ownership');
  assert.equal(decideStatus({ ...base, provider: { provider: 'zb', result: 'catch_all' } }).status, 'risky');
  assert.equal(decideStatus({ ...base, smtp: { result: 'unknown', detail: 'blocked' } }).status, 'unknown');
  assert.equal(decideStatus({ ...base, provider: { provider: 'zb', result: 'valid' } }).status, 'verified');
  assert.equal(decideStatus({ ...base, smtp: { result: 'accepted' } }).status, 'verified');
  assert.equal(decideStatus({ ...base, ownership: 'own_website', smtp: { result: 'rejected', detail: '550' } }).status, 'invalid');
});

test('verification: blocking states win over a positive provider result', () => {
  const valid = { provider: 'zb', result: 'valid' };
  assert.equal(decideStatus({ ...base, provider: valid, suppressed: 'unsubscribe' }).status, 'suppressed');
  assert.equal(decideStatus({ ...base, provider: valid, previously_bounced: true }).status, 'previously_bounced');
  assert.equal(decideStatus({ ...base, provider: valid, suppressed: 'bounce' }).status, 'previously_bounced');
  assert.equal(decideStatus({ ...base, provider: valid, duplicate_of: 4 }).status, 'duplicate');
  assert.equal(decideStatus({ ...base, disposable: true }).status, 'disposable');
  assert.equal(decideStatus({ ...base, dns: { domain_exists: true, mx: [], has_a: false, null_mx: false } }).status, 'invalid');
  assert.equal(decideStatus({ ...base, dns: { domain_exists: true, mx: ['.'], has_a: true, null_mx: true } }).status, 'invalid');
  assert.equal(decideStatus({ ...base, syntax_ok: false }).status, 'invalid');
});

test('smtp probe: accepted+random rejected = mailbox exists; accepts-everything = catch-all; refusals pause the host', async () => {
  const { openDb } = await import('../src/db/index.js');
  openDb(':memory:');
  const { runtime } = await import('../src/lib/runtime.js');
  const { smtpProbe } = await import('../src/agents/verification.js');
  const ok = [{ code: 220 }, { code: 250 }, { code: 250 }];
  const answer = (target, control) => async () => ({ ok: true, replies: [...ok, { code: target, text: `${target}` }, { code: control, text: `${control}` }, { code: 221 }] });
  runtime.smtpConversation = answer(250, 550);
  assert.equal((await smtpProbe('a@x.test', 'mx1.test')).result, 'accepted');
  runtime.smtpConversation = answer(250, 250);
  assert.equal((await smtpProbe('a@x.test', 'mx2.test')).result, 'catch_all');
  runtime.smtpConversation = answer(550, 550);
  assert.equal((await smtpProbe('a@x.test', 'mx3.test')).result, 'rejected');
  runtime.smtpConversation = answer(451, 550);
  assert.equal((await smtpProbe('a@x.test', 'mx4.test')).result, 'unknown', 'greylisting is not a rejection');
  let calls = 0;
  runtime.smtpConversation = async () => { calls++; return { ok: true, early: true, replies: [{ code: 554, text: '554 5.7.1 blocked using Spamhaus' }] }; };
  assert.equal((await smtpProbe('a@x.test', 'mx5.test')).result, 'unknown');
  assert.equal((await smtpProbe('b@x.test', 'mx5.test')).result, 'unknown');
  assert.equal(calls, 1, 'a host that blocks us is not probed again for a day');
  // Outlook refuses our IP at RCPT time: a policy block, not a missing mailbox.
  const blocked = '550 5.7.1 Service unavailable, Client host [203.0.113.9] blocked using Spamhaus';
  runtime.smtpConversation = async () => ({ ok: true, replies: [...ok, { code: 550, text: blocked }, { code: 550, text: blocked }, { code: 221 }] });
  assert.equal((await smtpProbe('a@outlook.test', 'mx6.test')).result, 'unknown');
  runtime.smtpConversation = async () => ({ ok: true, replies: [...ok, { code: 550, text: '550 5.1.1 The email account that you tried to reach does not exist' }, { code: 550, text: '550 5.1.1' }, { code: 221 }] });
  assert.equal((await smtpProbe('gone@x.test', 'mx7.test')).result, 'rejected');
});

test('intent: a driver asking for a dispatcher scores high; a dispatch company saying the same words does not', () => {
  const seeker = ruleIntent({}, [{ url: 'https://reddit.com/r/Truckers/1', is_post: true, published_at: new Date().toISOString(),
    text: 'Just got my authority last month. Looking for a reliable dispatcher, rates are so low and I can\'t find good loads.' }]);
  assert.ok(seeker.score >= 70, `seeker scored ${seeker.score}`);
  assert.ok(seeker.signals.find((s) => s.signal === 'seeking_dispatcher').evidence.includes('Looking for a reliable dispatcher'));

  const provider = ruleIntent({}, [{ url: 'https://dispatchco.com', is_post: false,
    text: 'We are a truck dispatching company. Need a dispatcher? We help owner operators find loads.' }]);
  assert.ok(provider.is_provider);
  assert.ok(provider.score <= 5);

  const generic = ruleIntent({ fleet_size: 40 }, [{ url: 'https://acme.com', text: 'Acme Trucking hauls dry van freight across Texas since 1998.' }]);
  assert.equal(generic.score, 0);
  assert.equal(intentBand(90), 'very_high');
  assert.equal(intentBand(89), 'high');
  assert.equal(intentBand(40), 'medium');
  assert.equal(intentBand(39), 'low');
});

test('intent: older posts count for less than fresh ones', () => {
  const text = 'Need a truck dispatcher for my box truck.';
  const fresh = ruleIntent({}, [{ text, is_post: true, published_at: new Date().toISOString() }]);
  const old = ruleIntent({}, [{ text, is_post: true, published_at: new Date(Date.now() - 200 * 86400000).toISOString() }]);
  assert.ok(fresh.score > old.score);
});

test('reply classification reads meaning of the latest message, not quoted history', () => {
  const cases = [
    ['Please remove me from your list.', 'unsubscribe'],
    ['Not interested, thanks.', 'not_interested'],
    ['We already have a dispatcher.', 'already_has_dispatcher'],
    ['How much do you charge?', 'wants_pricing'],
    ['Call me tomorrow at 713-555-0199.', 'wants_call'],
    ['Let\'s get started, when can you start?', 'very_interested'],
    ['Reach out again after the holidays.', 'follow_up_later'],
    ['Sounds good.', 'interested'],
  ];
  for (const [text, want] of cases) assert.equal(ruleClassify(text).classification, want, text);
  assert.equal(ruleClassify('I am out of the office until Monday.', { autoSubmitted: true }).classification, 'out_of_office');
  const withQuote = 'Sounds good, send details.\n\nOn Tue, Nov 24, 2026, Sam wrote:\n> reply unsubscribe to stop';
  assert.equal(latestReplyText(withQuote), 'Sounds good, send details.');
  assert.notEqual(ruleClassify(withQuote).classification, 'unsubscribe');
});

test('robots.txt: longest matching rule wins and our user agent group takes precedence', () => {
  const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: DispatchLeadBot\nDisallow: /admin\nAllow: /admin/contact';
  assert.equal(robotsAllows(robots, 'DispatchLeadBot/1.0', '/contact'), true);
  assert.equal(robotsAllows(robots, 'DispatchLeadBot/1.0', '/admin/x'), false);
  assert.equal(robotsAllows(robots, 'DispatchLeadBot/1.0', '/admin/contact'), true);
  assert.equal(robotsAllows(robots, 'OtherBot/1.0', '/contact'), false);
  assert.equal(robotsAllows('', 'DispatchLeadBot/1.0', '/anything'), true);
});

test('email extraction only returns addresses published on the page', () => {
  const found = extractEmails('<a href="mailto:Owner@Acme-Trucking.com?subject=hi">x</a> ops [at] acme-trucking [dot] com <img src="logo@2x.png"> user@example.com');
  assert.deepEqual(found.sort(), ['ops@acme-trucking.com', 'owner@acme-trucking.com']);
  assert.equal(normalizeName('ACME Trucking, LLC'), normalizeName('Acme Trucking Inc.'));
});

test('generated emails with invented guarantees, numbers, or links are rejected', () => {
  const settings = { pricing_enabled: false, pricing_text: '', calendly_url: 'https://calendly.com/me' };
  assert.equal(checkGenerated('We can help you find loads. Book here https://calendly.com/me/15', [], settings).length, 0);
  assert.ok(checkGenerated('We guarantee more revenue', [], settings).length);
  assert.ok(checkGenerated('Our drivers earn 30% more', [], settings).length);
  assert.ok(checkGenerated('See https://evil.example', [], settings).length);
});

test('send window uses the recipient state time zone and skips weekends', async () => {
  const { inSendWindow } = await import('../src/agents/outreach.js');
  const s = { send_window_start_hour: 8, send_window_end_hour: 17, send_weekends: false };
  const wed1530utc = new Date('2026-11-25T15:30:00Z'); // 10:30 New York, 07:30 Los Angeles
  assert.equal(inSendWindow(s, 'NY', wed1530utc), true);
  assert.equal(inSendWindow(s, 'CA', wed1530utc), false);
  const sat = new Date('2026-11-28T17:00:00Z');
  assert.equal(inSendWindow(s, 'TX', sat), false);
  assert.equal(inSendWindow({ ...s, send_weekends: true }, 'TX', sat), true);
});

test('learning: small samples never move scores; a clear difference moves them a capped amount', async () => {
  const { learnedAdjustment, wilsonLower, MIN_SAMPLE } = await import('../src/agents/learning.js');
  assert.ok(wilsonLower(3, 3) < 0.5, '3 of 3 is weak evidence');
  const tiny = { total: MIN_SAMPLE - 1, positive: 5, base: 0.26, traits: {} };
  assert.equal(learnedAdjustment(['source:fmcsa_authority'], tiny).points, 0);
  const model = { total: 200, positive: 10, base: 0.05, traits: {
    'source:fmcsa_authority': { n: 60, positive: 15, rate: 0.25, lower: wilsonLower(15, 60) },
    'source:fmcsa_census': { n: 140, positive: 1, rate: 1 / 140, lower: wilsonLower(1, 140) },
  } };
  const up = learnedAdjustment(['source:fmcsa_authority'], model);
  assert.ok(up.points > 0 && up.points <= 8, `lift capped: ${up.points}`);
  assert.ok(learnedAdjustment(['source:fmcsa_census'], model).points < 0);
  assert.equal(learnedAdjustment(['equipment:reefer'], model).points, 0, 'traits without enough data are ignored');
});
