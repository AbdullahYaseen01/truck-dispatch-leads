// End-to-end workflow: discovery -> dedup -> email discovery -> verification -> qualification ->
// campaign -> approval -> send -> follow-up -> reply classification -> conversion draft -> bounce -> dashboard.
// External services (FMCSA, Google Places, websites, DNS, ZeroBounce, SMTP) are replaced with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_SECRET = 'test-secret-'.padEnd(48, 'x');
// Free-only mode (the default): a paid key that is present must be ignored.
process.env.ZEROBOUNCE_API_KEY = 'paid-key-must-be-ignored';
process.env.PUBLIC_BASE_URL = 'https://leads.example.test';

const { openDb, one, all, run } = await import('../src/db/index.js');
const { runtime } = await import('../src/lib/runtime.js');
const { drain, enqueue } = await import('../src/queue/queue.js');
const { upsertLead } = await import('../src/agents/leads.js');
const { startSearchRun } = await import('../src/agents/pipeline.js');
const { seedDefaults, createCampaign, activateCampaign, outreachTick, approveMessage } = await import('../src/agents/outreach.js');
const { updateSettings } = await import('../src/lib/settings.js');
const { encrypt, unsubscribeToken } = await import('../src/lib/crypto.js');
const { handleRawMessage } = await import('../src/email/inbox.js');
const { overviewStats } = await import('../src/agents/analytics.js');
const { createUser } = await import('../src/http/auth.js');
const { createApp } = await import('../src/app.js');

openDb(':memory:');
seedDefaults();

const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
const CENSUS = [
  { add_date: day(3), status_code: 'A', dot_number: '7462657', carrier_operation: 'C', phone: '3465881388', company_officer_1: 'YONDER OJEDA SUAREZ',
    power_units: '2', classdef: 'AUTHORIZED FOR HIRE', legal_name: 'OJEDA TRANSPORT INC', phy_street: '11710 BRIAR FOREST DR', phy_city: 'HOUSTON',
    phy_country: 'US', phy_state: 'TX', phy_zip: '77077-5041', email_address: 'TRANSPORTOJEDA@GMAIL.COM', crgo_genfreight: 'X',
    docket1prefix: 'MC', docket1: '0712345' },
  { add_date: day(2), status_code: 'A', dot_number: '7993755', carrier_operation: 'A', phone: '7273320000', company_officer_1: 'MALOKHAT SHAKHALILOVA',
    power_units: '1', classdef: 'AUTHORIZED FOR HIRE', legal_name: 'EAST WEST CARGO INC', phy_street: '1000 PERSIMMON DR', phy_city: 'ANNA',
    phy_country: 'US', phy_state: 'TX', phy_zip: '75409', email_address: 'INFO@EW-CARGO.COM', crgo_genfreight: 'X' },
  // Large fleet: filtered out by maxFleet.
  { add_date: day(5), status_code: 'A', dot_number: '7000001', carrier_operation: 'A', power_units: '80', classdef: 'AUTHORIZED FOR HIRE',
    legal_name: 'BIG FLEET LLC', phy_city: 'DALLAS', phy_state: 'TX', email_address: 'ops@bigfleet.com' },
];

const AUTH_EVENTS = [
  { docket_number: 'MC1888001', usdot_number: '7993755', op_auth_type: 'Motor Carrier of Property (Except Household Goods)', op_auth_status: 'Active', reason: 'Granted', status_change_date: day(5) },
  // A broker authority must be ignored.
  { docket_number: 'MC1888002', usdot_number: '7000002', op_auth_type: 'Broker of Property', op_auth_status: 'Active', reason: 'Granted', status_change_date: day(4) },
];

const fetchLog = [];
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
runtime.fetch = async (url, opts = {}) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.startsWith('https://data.transportation.gov/resource/dm5j-zc6c.json')) {
    // FMCSA operating-authority events: East West Cargo was granted authority 5 days ago.
    const dot = new URL(u).searchParams.get('usdot_number');
    return Response.json(AUTH_EVENTS.filter((e) => !dot || e.usdot_number === dot));
  }
  if (u.startsWith('https://data.transportation.gov/resource/az4n-8mr2.json')) {
    const where = new URL(u).searchParams.get('$where') || '';
    const one_ = new URL(u).searchParams.get('dot_number');
    const dots = one_ ? [one_] : where.match(/dot_number in \(([^)]*)\)/)?.[1].match(/\d+/g);
    return Response.json(dots ? CENSUS.filter((r) => dots.includes(r.dot_number)) : CENSUS);
  }
  if (u.startsWith('https://api.zerobounce.net/')) throw new Error('paid verification API must not be called in free-only mode');
  if (u === 'https://www.ew-cargo.com/robots.txt') return new Response('User-agent: *\nDisallow: /private', { status: 200 });
  if (u === 'https://www.ew-cargo.com/') return html('<html><body><h1>East West Cargo</h1><a href="/contact">Contact us</a><a href="/private/x">contact private</a><p>&copy; 2026 East West Cargo</p></body></html>');
  if (u === 'https://www.ew-cargo.com/contact') return html('<p>Email dispatch [at] ew-cargo [dot] com or <a href="mailto:info@ew-cargo.com">us</a>. USDOT 7993755</p>');
  if (u.startsWith('https://www.ew-cargo.com/private')) throw new Error('robots.txt should have blocked this');
  return new Response('not found', { status: 404 });
};

// Free SMTP mailbox probe. ew-cargo.com confirms mailboxes; Gmail refuses this machine (no reverse DNS).
const probes = [];
runtime.smtpConversation = async (host, steps) => {
  probes.push({ host, steps });
  const rcpt = steps.filter((s) => s.startsWith('RCPT')).map((s) => s.match(/<(.+)>/)[1]);
  if (host === 'gmail-smtp-in.l.google.com') return { ok: true, early: true, replies: [{ code: 220, text: '220 ready' }, { code: 250, text: '250 hi' }, { code: 450, text: '450 4.7.25 Forward-confirmed reverse DNS failed' }] };
  const known = ['info@ew-cargo.com', 'dispatch@ew-cargo.com'];
  return { ok: true, replies: [{ code: 220, text: '220' }, { code: 250, text: '250' }, { code: 250, text: '250' },
    ...rcpt.map((r) => (known.includes(r) ? { code: 250, text: '250 ok' } : { code: 550, text: '550 5.1.1 no such user' })), { code: 221, text: '221' }] };
};
runtime.dns.resolveMx = async (d) => {
  if (d === 'ew-cargo.com') return [{ exchange: 'mx.ew-cargo.com', priority: 10 }];
  if (d === 'gmail.com') return [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }];
  throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
};
runtime.dns.resolve4 = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };

const sentMail = [];
runtime.createTransport = () => ({
  sendMail: async (m) => { sentMail.push(m); return { messageId: m.messageId }; },
  verify: async () => true,
});

async function settle() {
  for (let i = 0; i < 40; i++) {
    await drain({ concurrency: 6 });
    if (!one(`SELECT 1 FROM jobs WHERE status IN ('queued','running')`)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('pipeline did not settle');
}

let ew;
let ojeda;

test('discovery runs parallel sources, dedupes, discovers and verifies emails, and qualifies leads', async () => {
  const runId = startSearchRun({ sources: ['fmcsa_census', 'fmcsa_authority', 'google_places'], states: ['TX'], equipment: ['Dry Van'], maxFleet: 10 }, 'test');
  await settle();

  const r = one('SELECT * FROM search_runs WHERE id = ?', runId);
  assert.equal(r.status, 'done');
  assert.deepEqual(JSON.parse(r.params).sources, ['fmcsa_census', 'fmcsa_authority'], 'paid Google Places dropped in free-only mode');
  const stats = JSON.parse(r.stats);
  assert.equal(stats.total, 2, 'one census query + one authority query');
  assert.equal(stats.found, 3, '2 census rows within fleet limit + 1 new property-carrier authority (broker ignored)');
  assert.equal(stats.new, 2);
  assert.equal(stats.merged, 1, 'the authority event merged into the FMCSA census record');

  // The carrier's own website (e.g. added by hand) merges into the same business and gets crawled.
  const site = upsertLead({ name: 'East West Cargo', website: 'https://www.ew-cargo.com/', phone: '(727) 332-0000', state: 'TX', source: 'manual', source_url: 'manual:test' });
  enqueue('lead.enrich', { companyId: site.companyId }, { dedupeKey: `enrich:${site.companyId}` });
  await settle();
  assert.equal(site.created, false);

  assert.equal(one('SELECT COUNT(*) n FROM companies').n, 2, 'big fleet excluded, website listing deduped');
  ew = one(`SELECT * FROM companies WHERE usdot_number = '7993755'`);
  ojeda = one(`SELECT * FROM companies WHERE usdot_number = '7462657'`);
  assert.equal(ew.website, 'https://www.ew-cargo.com/');
  assert.equal(ew.operating_status, 'authorized', 'FMCSA authority status wins over the census and weaker sources');
  assert.equal(ew.mc_number, '1888001');
  assert.equal(ew.zip_code, '75409');
  assert.equal(ojeda.mc_number, '712345', 'MC docket read from the census when there is no authority event');
  assert.equal(ojeda.zip_code, '77077', 'ZIP+4 trimmed to the 5-digit ZIP');
  assert.match(ew.last_website_activity_evidence, /Copyright 2026/);

  // Email discovery: only addresses actually published on the site; robots.txt respected.
  const emails = all('SELECT email_normalized, source, verification_status, verification_provider, is_role FROM contacts WHERE company_id = ? ORDER BY email_normalized', ew.id);
  assert.deepEqual(emails.map((e) => e.email_normalized), ['dispatch@ew-cargo.com', 'info@ew-cargo.com']);
  assert.ok(emails.every((e) => e.verification_status === 'verified' && e.verification_provider === 'smtp_probe'), 'free SMTP probe confirmed both');
  assert.ok(!fetchLog.some((u) => u.includes('/private')), 'robots.txt disallowed path was not fetched');
  assert.ok(!fetchLog.some((u) => u.includes('zerobounce')), 'paid verification was never called');
  assert.ok(probes.every((p) => !p.steps.some((s) => /^DATA/i.test(s))), 'the probe never sends a message');

  // Gmail refuses to answer: MX exists but the mailbox is unconfirmed. Published by the carrier itself -> likely valid, never "verified".
  const oc = one('SELECT * FROM contacts WHERE company_id = ?', ojeda.id);
  assert.equal(oc.verification_status, 'likely_valid');
  assert.equal(oc.ownership_evidence, 'fmcsa_registration');
  assert.match(JSON.parse(oc.verification_detail).reason, /mailbox not confirmed/);
  assert.ok(one(`SELECT 1 FROM mx_probe_state WHERE host = 'gmail-smtp-in.l.google.com' AND blocked_until > ?`, new Date().toISOString()), 'probing paused for a host that refuses us');

  // Qualification with explanations, priority, confidence, eligibility and a research brief.
  assert.equal(ew.stage, 'qualified');
  assert.ok(ew.intent_score >= 40 && ew.intent_score < 70, `new authority + 1 truck is medium intent, got ${ew.intent_score}`);
  const breakdown = JSON.parse(ew.lead_score_breakdown);
  assert.equal(breakdown.lead.reduce((a, p) => a + p.points, 0), ew.lead_score);
  assert.ok(breakdown.lead.every((p) => p.why), 'every score component has a reason');
  assert.ok(JSON.parse(ew.intent_signals).some((s) => s.signal === 'new_authority' && /operating authority granted/.test(s.evidence)));
  assert.ok(['medium', 'high', 'very_high'].includes(ew.priority));
  assert.ok(ew.confidence_score >= 80, `registry + website + verified email, got ${ew.confidence_score}`);
  assert.equal(JSON.parse(ew.eligibility).eligible, true);
  assert.match(ew.research_summary, /Authority: Operating authority granted/);
  assert.match(ew.research_summary, /Not known \(do not assume\):.*decision-maker|Decision-maker: Malokhat/);
  assert.match(one('SELECT research_summary s FROM companies WHERE id = ?', ojeda.id).s, /Not known \(do not assume\): .*company website/);
});

test('a DNS resolver outage never marks an email invalid; the check is retried instead', async () => {
  const { verifyContact } = await import('../src/agents/verification.js');
  const { addContact } = await import('../src/agents/leads.js');
  const id = addContact(ojeda.id, { email: 'owner@flaky-dns.test', source: 'manual', source_url: 'https://x.test' });
  const original = runtime.dns.resolveMx;
  runtime.dns.resolveMx = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
  try {
    await assert.rejects(verifyContact(id), /DNS lookup failed/);
    assert.equal(one('SELECT verification_status FROM contacts WHERE id = ?', id).verification_status, 'unverified');
  } finally {
    runtime.dns.resolveMx = original;
    run('DELETE FROM contacts WHERE id = ?', id);
  }
});

test('campaign requires compliance settings, generates personalized emails, and sends only after approval', async () => {
  const accountId = Number(run(`INSERT INTO sending_accounts (name, from_name, from_email, smtp_host, smtp_port, smtp_user, smtp_pass_enc, daily_limit, hourly_limit, created_at, updated_at)
    VALUES ('Main', 'Sam Rivera', 'sam@mydispatch.test', 'smtp.test', 587, 'sam', ?, 40, 10, datetime('now'), datetime('now'))`, encrypt('pw')).lastInsertRowid);
  const campId = createCampaign({ name: 'TX new authorities', segment: { states: ['TX'] }, sending_account_ids: [accountId] }, 'test');

  const blocked = activateCampaign(campId, 'test');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.problems.some((p) => /postal address/i.test(p)));

  updateSettings({ sender_company_name: 'Rivera Dispatch LLC', sender_person_name: 'Sam Rivera', postal_address: '100 Main St, Austin, TX 78701', calendly_url: 'https://calendly.com/sam/intro' });
  const act = activateCampaign(campId, 'test');
  assert.equal(act.ok, true);
  assert.equal(act.enrolled, 1, 'only the verified lead is enrolled');
  assert.equal(act.skipped['verification status likely_valid'], 1, 'unconfirmed mailboxes are held back by default');

  await outreachTick({ ignoreWindow: true });
  const msg = one(`SELECT * FROM messages WHERE company_id = ?`, ew.id);
  assert.equal(msg.status, 'pending_approval');
  assert.equal(sentMail.length, 0, 'nothing sent before approval');
  assert.match(msg.body_text, /^Hi Malokhat,/);
  assert.match(msg.body_text, /Congrats on getting your authority/);
  assert.match(msg.body_text, /Anna, TX/);
  assert.ok(!/\{\{/.test(msg.subject + msg.body_text), 'no unrendered placeholders');

  assert.ok(approveMessage(msg.id, 'admin@test'));
  await outreachTick({ ignoreWindow: true });
  await outreachTick({ ignoreWindow: true });
  assert.equal(sentMail.length, 1, 'approved email sent exactly once');
  const mail = sentMail[0];
  assert.equal(mail.to, 'info@ew-cargo.com');
  assert.match(mail.text, /100 Main St, Austin, TX 78701/);
  assert.ok(mail.text.includes(`https://leads.example.test/u/${unsubscribeToken('info@ew-cargo.com')}`));
  assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/leads\.example\.test\/u\//);
  assert.equal(one('SELECT stage FROM companies WHERE id = ?', ew.id).stage, 'contacted');

  // Follow-up becomes due: it threads under the first email and waits for approval.
  run(`UPDATE enrollments SET next_send_at = ? WHERE company_id = ?`, new Date(Date.now() - 1000).toISOString(), ew.id);
  await outreachTick({ ignoreWindow: true });
  const fu = one(`SELECT * FROM messages WHERE company_id = ? AND step_number = 2`, ew.id);
  assert.equal(fu.status, 'pending_approval');
  assert.equal(fu.in_reply_to, mail.messageId);

  // Frequency limit: even approved, a follow-up waits while the business was emailed less than 2 days ago.
  approveMessage(fu.id, 'admin@test');
  await outreachTick({ ignoreWindow: true });
  assert.equal(sentMail.length, 1, 'follow-up held by the per-business gap');
  assert.equal(one('SELECT status FROM messages WHERE id = ?', fu.id).status, 'approved');
});

test('a reply stops the sequence, is classified, and gets a drafted conversion reply', async () => {
  const first = one(`SELECT * FROM messages WHERE company_id = ? AND step_number = 1`, ew.id);
  const raw = [
    'From: Malokhat <info@ew-cargo.com>', 'To: sam@mydispatch.test', `Subject: Re: ${first.subject}`,
    'Message-ID: <reply-1@ew-cargo.com>', `In-Reply-To: ${first.message_id_header}`, 'Date: Thu, 26 Nov 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8', '',
    'Hi Sam, maybe. How does it work and what lanes do you cover?', '',
    'On Wed, Nov 25, 2026 at 9:00 AM Sam Rivera <sam@mydispatch.test> wrote:', '> not interested in this quoted text',
  ].join('\r\n');
  const res = await handleRawMessage(Buffer.from(raw));
  assert.equal(res.type, 'reply');
  await settle();

  const reply = one('SELECT * FROM replies WHERE id = ?', res.replyId);
  assert.equal(reply.classification, 'wants_more_info', 'quoted "not interested" text is ignored');
  assert.equal(one('SELECT status FROM enrollments WHERE company_id = ?', ew.id).status, 'stopped');
  assert.equal(one(`SELECT status FROM messages WHERE company_id = ? AND step_number = 2`, ew.id).status, 'cancelled', 'pending follow-up cancelled');
  assert.equal(one('SELECT stage FROM companies WHERE id = ?', ew.id).stage, 'interested');

  const draft = one(`SELECT * FROM messages WHERE reply_id = ?`, reply.id);
  assert.equal(draft.status, 'pending_approval');
  assert.match(draft.body_text, /calendly\.com\/sam\/intro/);
  assert.equal(draft.in_reply_to, '<reply-1@ew-cargo.com>');

  // Same message delivered twice (e.g. IMAP + webhook) is ingested once.
  assert.equal((await handleRawMessage(Buffer.from(raw))).type, 'ignored');
});

test('hard bounce suppresses the address and an unsubscribe link blocks all future sends', async () => {
  updateSettings({ allow_likely_valid_sends: true });
  await outreachTick({ ignoreWindow: true });
  const m = one(`SELECT * FROM messages WHERE company_id = ? AND kind = 'sequence'`, ojeda.id);
  assert.ok(m, 'likely-valid lead enrolled once the admin allows it');
  approveMessage(m.id, 'admin@test');
  await outreachTick({ ignoreWindow: true });
  const sent = one('SELECT * FROM messages WHERE id = ?', m.id);
  assert.equal(sent.status, 'sent');

  const dsn = [
    'From: Mail Delivery System <MAILER-DAEMON@gmail.com>', 'To: sam@mydispatch.test', 'Subject: Undelivered Mail Returned to Sender',
    'Message-ID: <dsn-1@gmail.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="b"', '',
    '--b', 'Content-Type: text/plain', '', 'Delivery failed.', '--b', 'Content-Type: message/delivery-status', '',
    'Reporting-MTA: dns; gmail.com', '', 'Final-Recipient: rfc822; transportojeda@gmail.com', 'Action: failed', 'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 user unknown', '', '--b', 'Content-Type: text/rfc822-headers', '',
    `Message-ID: ${sent.message_id_header}`, 'Subject: x', '', '--b--',
  ].join('\r\n');
  const r = await handleRawMessage(Buffer.from(dsn));
  assert.equal(r.type, 'bounce');
  assert.equal(one('SELECT status FROM messages WHERE id = ?', m.id).status, 'bounced');
  assert.equal(one(`SELECT reason FROM suppressions WHERE email_normalized = 'transportojeda@gmail.com'`).reason, 'bounce');
  assert.equal(one(`SELECT status FROM enrollments WHERE company_id = ?`, ojeda.id).status, 'stopped');
});

test('dashboard API requires auth, enforces roles, and reports real counts', async () => {
  createUser({ email: 'admin@test.dev', name: 'Admin', password: 'correct-horse-1', role: 'admin' });
  createUser({ email: 'viewer@test.dev', name: 'Viewer', password: 'correct-horse-2', role: 'viewer' });
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  try {
    assert.equal((await realFetch(`${base}/api/overview`)).status, 401);
    const bad = await realFetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.dev', password: 'nope' }) });
    assert.equal(bad.status, 401);

    const signIn = async (email, password) => {
      const res = await realFetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.equal(res.status, 200);
      return res.headers.get('set-cookie').split(';')[0];
    };
    const adminCookie = await signIn('admin@test.dev', 'correct-horse-1');
    const viewerCookie = await signIn('viewer@test.dev', 'correct-horse-2');

    const ov = await (await realFetch(`${base}/api/overview`, { headers: { cookie: adminCookie } })).json();
    assert.deepEqual(ov.stats, overviewStats());
    assert.equal(ov.stats.total_leads, 2);
    assert.equal(ov.stats.emails_sent, 2);
    assert.equal(ov.stats.emails_bounced, 1);
    assert.equal(ov.stats.emails_delivered, 1);
    assert.equal(ov.stats.replies, 1);
    assert.equal(ov.stats.positive_replies, 1);
    assert.equal(ov.stats.verified_emails, 2);

    const leads = await (await realFetch(`${base}/api/leads?min_intent=40&equipment=Dry%20Van`, { headers: { cookie: viewerCookie } })).json();
    assert.equal(leads.total, 2);
    const byMc = await (await realFetch(`${base}/api/leads?q=MC712345`, { headers: { cookie: viewerCookie } })).json();
    assert.deepEqual(byMc.leads.map((l) => l.usdot_number), ['7462657']);
    const mcZip = await (await realFetch(`${base}/api/leads/export.csv?fields=mc_zip&has_mc=1&zip=774`, { headers: { cookie: viewerCookie } })).text();
    assert.equal(mcZip.split('\n')[0], 'name,mc_number,zip_code,state,city,usdot_number,authority_granted_at');
    assert.equal(mcZip.split('\n').length, 1, 'ZIP prefix 774 matches neither 77077 nor 75409');
    const all2 = await (await realFetch(`${base}/api/leads/export.csv?fields=mc_zip&has_mc=1`, { headers: { cookie: viewerCookie } })).text();
    assert.match(all2, /Ojeda Transport INC,MC712345,77077,TX,Houston,7462657,/);

    const accounts = await (await realFetch(`${base}/api/accounts`, { headers: { cookie: adminCookie } })).json();
    assert.ok(!JSON.stringify(accounts).includes('smtp_pass_enc'), 'credentials never leave the server');

    const denied = await realFetch(`${base}/api/settings`, { method: 'PUT', headers: { cookie: viewerCookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const csrf = await realFetch(`${base}/api/settings`, { method: 'PUT', headers: { cookie: adminCookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(csrf.status, 403);

    // One-click unsubscribe (RFC 8058) without signing in.
    const unsub = await realFetch(`${base}/u/${unsubscribeToken('dispatch@ew-cargo.com')}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(unsub.status, 200);
    assert.equal(one(`SELECT reason FROM suppressions WHERE email_normalized = 'dispatch@ew-cargo.com'`).reason, 'unsubscribe');
    assert.equal(one(`SELECT verification_status FROM contacts WHERE email_normalized = 'dispatch@ew-cargo.com'`).verification_status, 'suppressed');
    assert.equal((await realFetch(`${base}/u/forged.token`)).status, 400);
  } finally {
    server.close();
  }
});
