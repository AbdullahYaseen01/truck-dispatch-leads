import { one, run, tx, nowIso } from '../db/index.js';
import { getSettings } from '../lib/settings.js';
import { audit, notify } from '../lib/audit.js';
import { llmEnabled, llmJson } from '../lib/llm.js';
import { emit } from '../lib/events.js';
import { templateVars, checkGenerated } from './personalization.js';
import { templateFor, stopEnrollments } from './outreach.js';
import { latestReplyText } from './replies.js';

// Conversion Agent: answers interested prospects (with Calendly link, pricing only when configured),
// records booked meetings, and marks companies as clients.

function render(tpl, vars) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

export async function draftConversionReply(replyId, classification, actor = 'conversion_agent') {
  const r = one('SELECT * FROM replies WHERE id = ?', replyId);
  if (!r || one(`SELECT 1 FROM messages WHERE reply_id = ? AND status NOT IN ('rejected','cancelled')`, replyId)) return null;
  const orig = r.message_id ? one('SELECT * FROM messages WHERE id = ?', r.message_id) : null;
  const company = r.company_id ? one('SELECT * FROM companies WHERE id = ?', r.company_id) : null;
  const contact = r.contact_id ? one('SELECT * FROM contacts WHERE id = ?', r.contact_id) : null;
  const settings = getSettings();
  const purpose = classification.classification === 'wants_pricing' && settings.pricing_enabled && settings.pricing_text ? 'reply_pricing'
    : classification.classification === 'wants_more_info' ? 'reply_info' : 'reply_interested';
  const tpl = templateFor(purpose);
  const vars = { ...templateVars(company || { name: '' }, contact, settings), original_subject: (orig?.subject || r.subject || '').replace(/^(re:\s*)+/i, '') };
  if (!settings.pricing_enabled || !settings.pricing_text) vars.pricing = classification.classification === 'wants_pricing' ? 'Pricing depends on your equipment and lanes, so I\'d like to go over it on a quick call.' : '';
  let subject = render(tpl.subject, vars);
  let body = render(tpl.body, vars);
  let generatedBy = 'template';
  if (llmEnabled()) {
    try {
      const ai = await llmJson(
        `You are the Conversion Agent for a small US truck dispatching service. Write a short, warm reply (50-130 words) to a prospect who answered our outreach.
Answer their basic questions using ONLY "our_services" and, if provided, "pricing". If pricing is null, do not state any price, percentage or fee.
Never promise results or invent clients/testimonials. Suggest the next onboarding step: a short call${settings.calendly_url ? ' via the Calendly link' : ''}. Sign with the sender name. No unsubscribe footer.
Return {"subject": string, "body": string}.`,
        { prospect_reply: latestReplyText(r.body_text).slice(0, 3000), classification: classification.classification, questions: classification.questions || [],
          company: company?.name, contact_first_name: vars.first_name || null, our_services: settings.services_description,
          pricing: settings.pricing_enabled && settings.pricing_text ? settings.pricing_text : null, calendly_url: settings.calendly_url || null,
          sender: settings.sender_person_name, original_subject: vars.original_subject },
        { temperature: 0.5, maxTokens: 500 },
      );
      const aiBody = String(ai.body || '').trim();
      if (aiBody.length > 30 && !checkGenerated(aiBody, [], settings).length) { body = aiBody; subject = `Re: ${vars.original_subject}`; generatedBy = 'ai'; }
    } catch { /* keep template */ }
  }
  const auto = settings.auto_reply_enabled && !classification.needs_admin;
  const now = nowIso();
  const res = run(`INSERT INTO messages (campaign_id, company_id, contact_id, reply_id, kind, status, subject, body_text, to_email, in_reply_to,
      sending_account_id, generated_by, personalization_facts, scheduled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'reply', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
  orig?.campaign_id ?? null, r.company_id, r.contact_id, replyId, auto ? 'approved' : 'pending_approval', subject, body, r.from_email,
  r.message_id_header ?? null, orig?.sending_account_id ?? null, generatedBy, now, now, now);
  const id = Number(res.lastInsertRowid);
  audit(actor, 'reply.drafted', 'message', id, { replyId, auto });
  emit('message', { id, status: auto ? 'approved' : 'pending_approval' });
  return id;
}

export function recordMeeting({ email, scheduledFor = null, source = 'manual', externalId = null, notes = null }, actor = 'conversion_agent') {
  const contact = email ? one('SELECT * FROM contacts WHERE email_normalized = ? ORDER BY id LIMIT 1', String(email).toLowerCase()) : null;
  if (externalId && one('SELECT 1 FROM meetings WHERE external_id = ?', externalId)) return null;
  return tx(() => {
    const r = run(`INSERT INTO meetings (company_id, contact_id, email, scheduled_for, source, external_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      contact?.company_id ?? null, contact?.id ?? null, email ?? null, scheduledFor, source, externalId, notes, nowIso());
    if (contact) {
      run(`UPDATE companies SET stage = 'meeting', updated_at = ? WHERE id = ? AND stage != 'client'`, nowIso(), contact.company_id);
      stopEnrollments({ companyId: contact.company_id }, 'meeting booked');
    }
    const id = Number(r.lastInsertRowid);
    audit(actor, 'meeting.recorded', 'meeting', id, { email, source });
    notify('action', `Meeting booked${contact ? '' : ' (unknown contact)'}: ${email}`, scheduledFor ? `Scheduled for ${scheduledFor}` : '', 'meeting', id);
    return id;
  });
}

export function markClient(companyId, actor) {
  const c = one('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return false;
  run(`UPDATE companies SET stage = 'client', updated_at = ? WHERE id = ?`, nowIso(), companyId);
  stopEnrollments({ companyId }, 'became client');
  audit(actor, 'company.client', 'company', companyId);
  emit('lead', { id: companyId, stage: 'client' });
  return true;
}
