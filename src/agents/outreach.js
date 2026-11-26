import { one, all, run, tx, nowIso, json } from '../db/index.js';
import { getSettings, complianceProblems } from '../lib/settings.js';
import { audit, notify, log } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { sendable } from './verification.js';
import { bestContact } from './qualification.js';
import { writeEmail } from './personalization.js';
import { buildMail, sendMail, newMessageId, isHardBounce } from '../email/mailer.js';
import { normalizeEmail } from './verification.js';
import { enqueue } from '../queue/queue.js';

// Outreach Agent: campaigns, enrollment, sequence scheduling, approval, compliant sending, suppression.

export const DEFAULT_SEQUENCE = [
  { step_number: 1, day_offset: 0, purpose: 'intro' },
  { step_number: 2, day_offset: 2, purpose: 'followup' },
  { step_number: 3, day_offset: 5, purpose: 'benefits' },
  { step_number: 4, day_offset: 9, purpose: 'final' },
];
const STOP_STAGES = ['replied', 'interested', 'meeting', 'client', 'not_interested', 'do_not_contact', 'disqualified'];

// ---------- suppression & stopping ----------
export function suppress(email, reason, source = null) {
  const n = normalizeEmail(email);
  run(`INSERT INTO suppressions (email_normalized, reason, source, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email_normalized) DO UPDATE SET reason = CASE WHEN suppressions.reason = 'unsubscribe' THEN suppressions.reason ELSE excluded.reason END`,
  n, reason, source, nowIso());
  run(`UPDATE contacts SET verification_status = ? WHERE email_normalized = ?`, reason === 'bounce' ? 'previously_bounced' : 'suppressed', n);
  // Cancel anything queued to this address.
  run(`UPDATE messages SET status = 'cancelled', updated_at = ? WHERE to_email = ? AND status IN ('pending_approval','approved')`, nowIso(), n);
  for (const c of all('SELECT id FROM contacts WHERE email_normalized = ?', n)) stopEnrollments({ contactId: c.id }, reason);
}

export function stopEnrollments({ contactId = null, companyId = null }, reason) {
  const rows = all(`SELECT id FROM enrollments WHERE status = 'active' AND (contact_id = ? OR company_id = ?)`, contactId ?? -1, companyId ?? -1);
  for (const r of rows) {
    run(`UPDATE enrollments SET status = 'stopped', stop_reason = ?, next_send_at = NULL, updated_at = ? WHERE id = ?`, reason, nowIso(), r.id);
    run(`UPDATE messages SET status = 'cancelled', updated_at = ? WHERE enrollment_id = ? AND status IN ('pending_approval','approved')`, nowIso(), r.id);
  }
  if (rows.length) emit('enrollment', { stopped: rows.length, reason });
  return rows.length;
}

// ---------- templates ----------
export const DEFAULT_TEMPLATES = [
  { name: 'Intro', purpose: 'intro', subject: 'dispatch help for {{company}}',
    body: `{{greeting}}

{{authority_line}} {{intent_line}} I run a small dispatch service and work with owner-operators and small fleets running {{equipment}} out of {{location}}.

We find and book loads that fit your lanes, negotiate rates with brokers, and handle the rate cons and paperwork, so you can focus on driving.

Would a quick 10-minute call this week make sense?

{{calendly_line}}

Thanks,
{{sender_name}}
{{sender_company}}` },
  { name: 'Friendly follow-up', purpose: 'followup', subject: 're: dispatch help for {{company}}',
    body: `{{greeting}}

Just following up on my note from a couple of days ago. If finding steady {{equipment}} loads or dealing with brokers is taking up your time, I'd be glad to help.

Is this something you'd want to talk about?

{{sender_name}}` },
  { name: 'Dispatch benefits', purpose: 'benefits', subject: 'fewer empty miles for {{company}}',
    body: `{{greeting}}

A few ways a dispatcher can help with {{fleet_phrase}}:

- Booking loads that fit where you want to go, so you drive fewer empty miles
- Negotiating rates with brokers on your behalf
- Handling broker calls, rate confirmations and invoices
- Planning the next load before you deliver the current one

If any of that would help, just reply and we can talk.

{{calendly_line}}

{{sender_name}}` },
  { name: 'Final follow-up', purpose: 'final', subject: 'should I close your file?',
    body: `{{greeting}}

I haven't heard back, so I'll assume the timing isn't right and this will be my last email.

If you ever want help finding loads or handling the broker side, just reply here and I'll get back to you.

All the best on the road,
{{sender_name}}` },
  { name: 'Reply: interested', purpose: 'reply_interested', subject: 're: {{original_subject}}',
    body: `{{greeting}}

Thanks for getting back to me. {{services}}

The easiest next step is a short call so I can learn your lanes, equipment and how you like to run. {{calendly_line}}

{{pricing}}

Talk soon,
{{sender_name}}` },
  { name: 'Reply: pricing', purpose: 'reply_pricing', subject: 're: {{original_subject}}',
    body: `{{greeting}}

Good question. {{pricing}}

Happy to walk you through how it works on a quick call. {{calendly_line}}

{{sender_name}}` },
  { name: 'Reply: more info', purpose: 'reply_info', subject: 're: {{original_subject}}',
    body: `{{greeting}}

Sure. {{services}}

We work around your preferred lanes and home time, and you always approve a load before it's booked. {{calendly_line}}

{{sender_name}}` },
];

export function seedDefaults() {
  if (one('SELECT COUNT(*) n FROM templates').n === 0) {
    const now = nowIso();
    for (const t of DEFAULT_TEMPLATES) {
      run('INSERT INTO templates (name, purpose, subject, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', t.name, t.purpose, t.subject, t.body, now, now);
    }
  }
}

export function templateFor(purpose, id = null) {
  return (id && one('SELECT * FROM templates WHERE id = ?', id)) || one('SELECT * FROM templates WHERE purpose = ? ORDER BY id LIMIT 1', purpose);
}

// ---------- campaigns ----------
export function createCampaign({ name, segment = {}, require_approval = true, sending_account_ids = [], steps = DEFAULT_SEQUENCE }, actor) {
  return tx(() => {
    const now = nowIso();
    const r = run(`INSERT INTO campaigns (name, segment, require_approval, sending_account_ids, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      name, JSON.stringify(segment), require_approval ? 1 : 0, JSON.stringify(sending_account_ids), actor, now, now);
    const id = Number(r.lastInsertRowid);
    setSteps(id, steps);
    audit(actor, 'campaign.create', 'campaign', id, { name });
    return id;
  });
}

export function setSteps(campaignId, steps) {
  run('DELETE FROM campaign_steps WHERE campaign_id = ?', campaignId);
  steps.forEach((s, i) => run('INSERT INTO campaign_steps (campaign_id, step_number, day_offset, template_id, purpose, variant_template_ids) VALUES (?, ?, ?, ?, ?, ?)',
    campaignId, i + 1, Number(s.day_offset) || 0, s.template_id ?? templateFor(s.purpose)?.id ?? null, s.purpose,
    JSON.stringify((s.variant_template_ids || []).map(Number).filter(Boolean))));
}

// Leads matching a campaign segment (filters shared with the Lead Database page).
export function segmentWhere(seg, params) {
  const w = ['c.duplicate_of IS NULL'];
  const inList = (col, vals) => { w.push(`${col} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); };
  if (seg.states?.length) inList('c.state', seg.states);
  if (seg.stages?.length) inList('c.stage', seg.stages);
  if (seg.categories?.length) inList('c.prospect_category', seg.categories);
  if (seg.equipment?.length) { w.push(`(${seg.equipment.map(() => 'c.equipment_types LIKE ?').join(' OR ')})`); params.push(...seg.equipment.map((e) => `%"${e}"%`)); }
  if (seg.min_lead_score != null && seg.min_lead_score !== '') { w.push('c.lead_score >= ?'); params.push(Number(seg.min_lead_score)); }
  if (seg.min_intent != null && seg.min_intent !== '') { w.push('c.intent_score >= ?'); params.push(Number(seg.min_intent)); }
  if (seg.max_fleet) { w.push('c.fleet_size <= ?'); params.push(Number(seg.max_fleet)); }
  if (seg.min_fleet) { w.push('c.fleet_size >= ?'); params.push(Number(seg.min_fleet)); }
  if (seg.city) { w.push('c.city LIKE ?'); params.push(`%${seg.city}%`); }
  if (seg.source) { w.push('EXISTS (SELECT 1 FROM lead_sources s WHERE s.company_id = c.id AND s.source = ?)'); params.push(seg.source); }
  if (seg.verification) { w.push('EXISTS (SELECT 1 FROM contacts x WHERE x.company_id = c.id AND x.verification_status = ?)'); params.push(seg.verification); }
  if (seg.from) { w.push('c.first_discovered_at >= ?'); params.push(seg.from); }
  if (seg.to) { w.push('c.first_discovered_at <= ?'); params.push(`${seg.to}T23:59:59.999Z`); }
  if (seg.q) {
    w.push('(c.name LIKE ? OR c.usdot_number = ? OR c.mc_number = ? OR c.zip_code = ? OR c.domain LIKE ?)');
    params.push(`%${seg.q}%`, seg.q, String(seg.q).replace(/^mc\s*-?/i, ''), seg.q, `%${seg.q}%`);
  }
  if (seg.has_mc === '1') w.push(`c.mc_number IS NOT NULL AND c.mc_number != ''`);
  if (seg.zip) { w.push('c.zip_code LIKE ?'); params.push(`${String(seg.zip).replace(/\D/g, '')}%`); }
  if (seg.campaign_status === 'not_enrolled') w.push('NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.company_id = c.id)');
  else if (['active', 'stopped', 'completed'].includes(seg.campaign_status)) { w.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.company_id = c.id AND e.status = ?)'); params.push(seg.campaign_status); }
  if (seg.priority) { w.push('c.priority = ?'); params.push(seg.priority); }
  if (seg.eligible === '1') w.push(`c.eligibility LIKE '%"eligible":true%'`);
  else if (seg.eligible === '0') w.push(`c.eligibility LIKE '%"eligible":false%'`);
  if (seg.recent_days) { w.push('c.first_discovered_at >= ?'); params.push(new Date(Date.now() - Number(seg.recent_days) * 86400000).toISOString()); }
  if (seg.campaign_id) { w.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.company_id = c.id AND e.campaign_id = ?)'); params.push(Number(seg.campaign_id)); }
  return w.join(' AND ');
}

export function campaignCandidates(campaignId, { limit = 500 } = {}) {
  const camp = one('SELECT * FROM campaigns WHERE id = ?', campaignId);
  const seg = json(camp.segment, {});
  const settings = getSettings();
  const params = [];
  const where = segmentWhere({ ...seg, min_lead_score: seg.min_lead_score ?? settings.min_lead_score_to_enroll }, params);
  const companies = all(`SELECT c.* FROM companies c WHERE ${where} AND c.stage NOT IN (${STOP_STAGES.map(() => '?').join(',')})
    ORDER BY c.intent_score DESC, c.lead_score DESC LIMIT ?`, ...params, ...STOP_STAGES, Number(seg.limit) || limit);
  const out = [];
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const c of companies) {
    if (!(settings.allowed_outreach_countries || ['US']).includes(c.country) && !c.lawful_basis) { skip('country not allowed / no lawful basis'); continue; }
    const contact = bestContact(all('SELECT * FROM contacts WHERE company_id = ?', c.id));
    if (!contact) { skip('no usable email'); continue; }
    const s = sendable(contact, settings);
    if (!s.ok) { skip(s.why); if (s.recheck) enqueue('contact.verify', { contactId: contact.id }, { dedupeKey: `verify:${contact.id}` }); continue; }
    if (one(`SELECT 1 FROM enrollments WHERE status = 'active' AND (contact_id = ? OR company_id = ?)`, contact.id, c.id)) { skip('already in a sequence'); continue; }
    if (one('SELECT 1 FROM replies WHERE company_id = ?', c.id)) { skip('already replied'); continue; }
    const cooldown = new Date(Date.now() - settings.reenroll_after_days * 86400000).toISOString();
    if (one('SELECT 1 FROM enrollments WHERE company_id = ? AND updated_at > ?', c.id, cooldown)) { skip('contacted recently (re-contact cooldown)'); continue; }
    out.push({ company: c, contact });
  }
  return { candidates: out, skipped };
}

export function enrollCampaign(campaignId, actor = 'outreach_agent') {
  const { candidates, skipped } = campaignCandidates(campaignId);
  let enrolled = 0;
  const now = nowIso();
  for (const { company, contact } of candidates) {
    const r = run(`INSERT INTO enrollments (campaign_id, company_id, contact_id, next_send_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`, campaignId, company.id, contact.id, now, now, now);
    if (r.changes) enrolled++;
  }
  if (enrolled) audit(actor, 'campaign.enroll', 'campaign', campaignId, { enrolled, skipped });
  return { enrolled, skipped };
}

export function activateCampaign(id, actor) {
  const problems = complianceProblems();
  const camp = one('SELECT * FROM campaigns WHERE id = ?', id);
  if (!camp) problems.push('Campaign not found');
  else {
    if (!one('SELECT 1 FROM campaign_steps WHERE campaign_id = ?', id)) problems.push('Campaign has no steps');
    const ids = json(camp.sending_account_ids, []);
    const acc = all('SELECT id FROM sending_accounts WHERE enabled = 1').filter((a) => !ids.length || ids.includes(a.id));
    if (!acc.length) problems.push('No enabled sending account');
  }
  if (problems.length) return { ok: false, problems };
  run(`UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?`, nowIso(), id);
  const res = enrollCampaign(id, actor);
  audit(actor, 'campaign.activate', 'campaign', id, res);
  return { ok: true, ...res };
}

// ---------- sequence: generate due messages ----------
async function generateDue(settings) {
  const due = all(`SELECT e.* FROM enrollments e JOIN campaigns k ON k.id = e.campaign_id
    WHERE e.status = 'active' AND k.status = 'active' AND e.next_send_at <= ?
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.enrollment_id = e.id AND m.step_number = e.current_step + 1)
    ORDER BY e.next_send_at LIMIT 50`, nowIso());
  let generated = 0;
  for (const e of due) {
    const step = one('SELECT * FROM campaign_steps WHERE campaign_id = ? AND step_number = ?', e.campaign_id, e.current_step + 1);
    if (!step) { run(`UPDATE enrollments SET status = 'completed', next_send_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), e.id); continue; }
    const company = one('SELECT * FROM companies WHERE id = ?', e.company_id);
    const contact = one('SELECT * FROM contacts WHERE id = ?', e.contact_id);
    if (STOP_STAGES.includes(company.stage) && company.stage !== 'disqualified') { stopEnrollments({ contactId: contact.id }, `stage ${company.stage}`); continue; }
    const s = sendable(contact, settings);
    if (!s.ok) {
      if (s.recheck) { enqueue('contact.verify', { contactId: contact.id }, { dedupeKey: `verify:${contact.id}` }); continue; }
      stopEnrollments({ contactId: contact.id }, s.why);
      continue;
    }
    const camp = one('SELECT * FROM campaigns WHERE id = ?', e.campaign_id);
    // Experiments: a step may list variant templates; each enrollment gets one, split evenly and stably.
    const options = [step.template_id || templateFor(step.purpose)?.id, ...json(step.variant_template_ids, [])].filter(Boolean);
    const pickedId = options.length ? options[e.id % options.length] : null;
    const template = templateFor(step.purpose, pickedId);
    const variant = options.length > 1 ? String.fromCharCode(65 + (e.id % options.length)) : null;
    const prev = all('SELECT subject FROM messages WHERE enrollment_id = ? ORDER BY step_number', e.id).map((m) => m.subject);
    const mail = await writeEmail({ company, contact, template, step: step.step_number, previousSubjects: prev, settings });
    // Follow-ups thread under the first email.
    const first = one(`SELECT message_id_header FROM messages WHERE enrollment_id = ? AND status = 'sent' ORDER BY step_number LIMIT 1`, e.id);
    const now = nowIso();
    const r = run(`INSERT INTO messages (enrollment_id, campaign_id, company_id, contact_id, step_number, kind, status, subject, body_text, to_email,
        in_reply_to, generated_by, personalization_facts, template_id, variant, subject_candidates, scheduled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'sequence', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    e.id, e.campaign_id, company.id, contact.id, step.step_number, camp.require_approval ? 'pending_approval' : 'approved',
    mail.subject, mail.body, contact.email_normalized, first?.message_id_header ?? null, mail.generated_by, JSON.stringify(mail.facts),
    template?.id ?? null, variant, JSON.stringify(mail.subject_candidates || []), now, now, now);
    if (r.changes) {
      generated++;
      emit('message', { id: Number(r.lastInsertRowid), status: camp.require_approval ? 'pending_approval' : 'approved' });
    }
  }
  if (generated && one(`SELECT COUNT(*) n FROM messages WHERE status = 'pending_approval'`).n === generated) {
    notify('action', `${generated} email(s) waiting for approval`, 'Review them in Campaign Management.', 'messages', null);
  }
  return generated;
}

// ---------- sending ----------
// Main time zone per US state, so emails arrive during the RECIPIENT's business hours.
const STATE_TZ = {
  'America/New_York': 'CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV',
  'America/Chicago': 'AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI',
  'America/Denver': 'CO MT NM UT WY ID', 'America/Phoenix': 'AZ', 'America/Los_Angeles': 'CA NV OR WA',
  'America/Anchorage': 'AK', 'Pacific/Honolulu': 'HI',
};
const TZ_OF = Object.fromEntries(Object.entries(STATE_TZ).flatMap(([tz, s]) => s.split(' ').map((st) => [st, tz])));

export function recipientLocal(state, d = new Date()) {
  const tz = TZ_OF[String(state || '').toUpperCase()] || 'America/Chicago';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return { tz, hour: Number(parts.hour), weekday: parts.weekday };
}

export function inSendWindow(settings, state, d = new Date()) {
  const { hour, weekday } = recipientLocal(state, d);
  if (!settings.send_weekends && ['Sat', 'Sun'].includes(weekday)) return false;
  return hour >= settings.send_window_start_hour && hour < settings.send_window_end_hour;
}

// Contact-level frequency limits, across all campaigns. Returns null when sending is allowed.
export function frequencyBlock(companyId, settings) {
  const sent = `status IN ('sent','sending','bounced')`;
  const gap = new Date(Date.now() - settings.min_days_between_company_emails * 86400000).toISOString();
  if (one(`SELECT 1 FROM messages WHERE company_id = ? AND kind = 'sequence' AND ${sent} AND sent_at > ?`, companyId, gap)) return { wait: true, why: 'emailed this business too recently' };
  const month = new Date(Date.now() - 30 * 86400000).toISOString();
  const n = one(`SELECT COUNT(*) n FROM messages WHERE company_id = ? AND kind = 'sequence' AND ${sent} AND sent_at > ?`, companyId, month).n;
  if (n >= settings.max_company_emails_30d) return { wait: false, why: `30-day cap of ${settings.max_company_emails_30d} emails reached` };
  return null;
}

// Reputation protection: pause a campaign or sending account whose hard-bounce rate is too high.
export function checkBounceHealth({ campaignId = null, accountId = null }, settings = getSettings()) {
  const limit = settings.bounce_pause_percent / 100;
  const paused = [];
  const rate = (where, id) => one(`SELECT COUNT(*) n, SUM(status = 'bounced') b FROM messages WHERE ${where} = ? AND kind = 'sequence' AND status IN ('sent','bounced')`, id);
  if (campaignId) {
    const r = rate('campaign_id', campaignId);
    if (r.n >= 20 && r.b / r.n > limit && run(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`, nowIso(), campaignId).changes) {
      notify('warning', `Campaign #${campaignId} paused: bounce rate ${Math.round((100 * r.b) / r.n)}%`, 'Check the list quality before resuming.', 'campaign', campaignId);
      audit('outreach_agent', 'campaign.auto_pause', 'campaign', campaignId, { bounced: r.b, sent: r.n });
      paused.push(`campaign ${campaignId}`);
    }
  }
  if (accountId) {
    const r = rate('sending_account_id', accountId);
    if (r.n >= 20 && r.b / r.n > limit && run(`UPDATE sending_accounts SET enabled = 0, health_status = 'failing', last_error = ?, updated_at = ? WHERE id = ? AND enabled = 1`,
      `auto-disabled: bounce rate ${Math.round((100 * r.b) / r.n)}%`, nowIso(), accountId).changes) {
      notify('warning', `Sending account #${accountId} disabled: high bounce rate`, 'Protects the mailbox reputation. Re-enable it in Sending Accounts.', 'sending_account', accountId);
      paused.push(`account ${accountId}`);
    }
  }
  return paused;
}

export function accountUsage(accountId) {
  const day = new Date(Date.now() - 86400000).toISOString();
  const hour = new Date(Date.now() - 3600000).toISOString();
  return {
    day: one(`SELECT COUNT(*) n FROM messages WHERE sending_account_id = ? AND status IN ('sent','sending','bounced') AND sent_at >= ?`, accountId, day).n,
    hour: one(`SELECT COUNT(*) n FROM messages WHERE sending_account_id = ? AND status IN ('sent','sending','bounced') AND sent_at >= ?`, accountId, hour).n,
  };
}

// Rotation only spreads volume across the owner's real accounts, each within its own configured limits.
function pickAccount(allowedIds) {
  const accounts = all(`SELECT * FROM sending_accounts WHERE enabled = 1 AND health_status != 'failing'`)
    .filter((a) => !allowedIds.length || allowedIds.includes(a.id))
    .map((a) => ({ a, u: accountUsage(a.id) }))
    .filter(({ a, u }) => u.day < a.daily_limit && u.hour < a.hourly_limit)
    .sort((x, y) => x.u.day - y.u.day);
  return accounts[0]?.a || null;
}

function nextSendAt(enrollment, nextStep) {
  const planned = new Date(enrollment.started_at).getTime() + nextStep.day_offset * 86400000;
  return new Date(Math.max(planned, Date.now() + 20 * 3600000)).toISOString();
}

export async function sendApproved(settings, { ignoreWindow = false } = {}) {
  const queued = all(`SELECT m.*, c.state company_state FROM messages m LEFT JOIN companies c ON c.id = m.company_id
    WHERE m.status = 'approved' AND (m.scheduled_at IS NULL OR m.scheduled_at <= ?) ORDER BY m.id LIMIT 50`, nowIso());
  let sent = 0;
  let held = 0;
  for (const m of queued) {
    // Replies to people who wrote to us are not marketing sends; sequence emails wait for the recipient's business hours.
    if (m.kind === 'sequence' && !ignoreWindow && !inSendWindow(settings, m.company_state)) { held++; continue; }
    if (m.kind === 'sequence') {
      const block = frequencyBlock(m.company_id, settings);
      if (block?.wait) { held++; continue; }
      if (block) {
        run(`UPDATE messages SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?`, block.why, nowIso(), m.id);
        if (m.enrollment_id) stopEnrollments({ contactId: m.contact_id }, block.why);
        continue;
      }
    }
    if (one('SELECT 1 FROM suppressions WHERE email_normalized = ?', normalizeEmail(m.to_email))) {
      run(`UPDATE messages SET status = 'cancelled', error = 'suppressed', updated_at = ? WHERE id = ?`, nowIso(), m.id); continue;
    }
    if (m.enrollment_id && one(`SELECT status FROM enrollments WHERE id = ?`, m.enrollment_id)?.status !== 'active') {
      run(`UPDATE messages SET status = 'cancelled', error = 'sequence stopped', updated_at = ? WHERE id = ?`, nowIso(), m.id); continue;
    }
    const camp = m.campaign_id ? one('SELECT * FROM campaigns WHERE id = ?', m.campaign_id) : null;
    // Paused campaigns hold their sequence emails; replies to prospects still go out.
    if (camp && m.kind === 'sequence' && camp.status !== 'active') continue;
    const account = m.sending_account_id && m.kind === 'reply'
      ? one('SELECT * FROM sending_accounts WHERE id = ? AND enabled = 1', m.sending_account_id) || pickAccount([])
      : pickAccount(camp ? json(camp.sending_account_ids, []) : []);
    if (!account) return { sent, reason: 'all sending accounts are at their limits or failing' };
    // Atomic claim: only one worker can move approved -> sending, so a message is never sent twice.
    const msgId = m.message_id_header || newMessageId(account.from_email);
    const claim = run(`UPDATE messages SET status = 'sending', sending_account_id = ?, from_email = ?, message_id_header = ?, attempts = attempts + 1, sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'approved'`, account.id, account.from_email, msgId, nowIso(), nowIso(), m.id);
    if (!claim.changes) continue;
    const msg = one('SELECT * FROM messages WHERE id = ?', m.id);
    try {
      await sendMail(account, buildMail(msg, account, settings));
      tx(() => {
        const now = nowIso();
        run(`UPDATE messages SET status = 'sent', sent_at = ?, error = NULL, updated_at = ? WHERE id = ?`, now, now, m.id);
        run(`INSERT INTO email_events (message_id, contact_id, type, created_at) VALUES (?, ?, 'sent', ?)`, m.id, m.contact_id, now);
        run(`UPDATE sending_accounts SET health_status = 'ok', last_error = NULL, last_checked_at = ? WHERE id = ?`, now, account.id);
        if (m.enrollment_id) {
          const e = one('SELECT * FROM enrollments WHERE id = ?', m.enrollment_id);
          const next = one('SELECT * FROM campaign_steps WHERE campaign_id = ? AND step_number = ?', e.campaign_id, m.step_number + 1);
          run(`UPDATE enrollments SET current_step = ?, status = ?, next_send_at = ?, updated_at = ? WHERE id = ?`,
            m.step_number, next ? 'active' : 'completed', next ? nextSendAt(e, next) : null, now, e.id);
          run(`UPDATE companies SET stage = CASE WHEN stage IN ('new','qualified') THEN 'contacted' ELSE stage END, updated_at = ? WHERE id = ?`, now, m.company_id);
        }
      });
      sent++;
      emit('message', { id: m.id, status: 'sent' });
    } catch (err) {
      const now = nowIso();
      if (isHardBounce(err)) {
        run(`UPDATE messages SET status = 'bounced', error = ?, updated_at = ? WHERE id = ?`, String(err.response || err.message).slice(0, 500), now, m.id);
        run(`INSERT INTO email_events (message_id, contact_id, type, detail, created_at) VALUES (?, ?, 'bounced', ?, ?)`, m.id, m.contact_id, String(err.response || err.message).slice(0, 500), now);
        suppress(m.to_email, 'bounce', 'smtp');
        checkBounceHealth({ campaignId: m.campaign_id, accountId: account.id }, settings);
      } else {
        const failed = msg.attempts >= 3;
        run(`UPDATE messages SET status = ?, error = ?, sent_at = NULL, scheduled_at = ?, updated_at = ? WHERE id = ?`,
          failed ? 'failed' : 'approved', String(err.message).slice(0, 500), new Date(Date.now() + 15 * 60000).toISOString(), now, m.id);
        if (failed) run(`INSERT INTO email_events (message_id, contact_id, type, detail, created_at) VALUES (?, ?, 'failed', ?, ?)`, m.id, m.contact_id, String(err.message).slice(0, 500), now);
        // Connection/auth problems mark the account unhealthy so rotation skips it.
        if (!err.responseCode || err.code === 'EAUTH' || err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT') {
          run(`UPDATE sending_accounts SET health_status = 'failing', last_error = ?, last_checked_at = ? WHERE id = ?`, String(err.message).slice(0, 300), now, account.id);
          notify('warning', `Sending account ${account.from_email} is failing`, String(err.message).slice(0, 300), 'sending_account', account.id);
        }
        log.warn(`send failed for message ${m.id}: ${err.message}`);
      }
      emit('message', { id: m.id, status: 'error' });
    }
  }
  return { sent, held };
}

export async function outreachTick({ ignoreWindow = false } = {}) {
  const settings = getSettings();
  if (complianceProblems(settings).length) return { skipped: 'compliance settings incomplete' };
  for (const c of all(`SELECT id FROM campaigns WHERE status = 'active'`)) enrollCampaign(c.id);
  const generated = await generateDue(settings);
  const send = await sendApproved(settings, { ignoreWindow });
  return { generated, ...send };
}

export function approveMessage(id, actor) {
  const r = run(`UPDATE messages SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'`, actor, nowIso(), id);
  if (r.changes) audit(actor, 'message.approve', 'message', id);
  return r.changes > 0;
}

export function rejectMessage(id, actor) {
  const m = one('SELECT * FROM messages WHERE id = ?', id);
  if (!m || m.status !== 'pending_approval') return false;
  run(`UPDATE messages SET status = 'rejected', updated_at = ? WHERE id = ?`, nowIso(), id);
  // Rejecting a sequence email stops that prospect's sequence, so it is not regenerated.
  if (m.enrollment_id) stopEnrollments({ contactId: m.contact_id }, 'rejected by reviewer');
  audit(actor, 'message.reject', 'message', id);
  return true;
}
