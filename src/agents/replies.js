import { one, all, run, tx, nowIso } from '../db/index.js';
import { getSettings } from '../lib/settings.js';
import { audit, notify } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { llmEnabled, llmJson } from '../lib/llm.js';
import { enqueue } from '../queue/queue.js';
import { normalizeEmail } from './verification.js';
import { suppress, stopEnrollments, checkBounceHealth } from './outreach.js';
import { draftConversionReply } from './conversion.js';

// Reply Management Agent: ingests inbound mail (IMAP or webhook), detects bounces, matches replies to
// the outreach they answer, classifies intent, stops sequences, and hands interested prospects to Conversion.

export { REPLY_CATEGORIES, POSITIVE } from './constants.js';
import { REPLY_CATEGORIES } from './constants.js';

// Strip quoted history and signatures so only what the prospect wrote is classified.
export function latestReplyText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^On .{5,200}wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From:\s.+/i.test(l) || /^_{5,}/.test(l)) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const RULES = [
  ['unsubscribe', /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (email|contact)|don'?t (email|contact) me|opt[ -]?out)\b/i],
  ['out_of_office', /\b(out of (the )?office|auto(matic)?[ -]?reply|on vacation|away (from|until)|limited access to (my )?email|currently out)\b/i],
  ['already_has_dispatcher', /\b(already (have|got|use|work with) (a |an |my own |our own )?(dispatch|dispatcher)|we (have|use) (a |an )?(dispatch|dispatcher)|in[- ]house dispatch|i dispatch (myself|my own)|self[- ]dispatch|leased (on|to))\b/i],
  ['not_interested', /\b(not interested|no thanks|no thank you|not for (me|us)|we'?re good|i'?m good|don'?t need|not looking|pass on this)\b/i],
  ['follow_up_later', /\b(next (week|month|year|quarter|season)|after the (holidays|new year)|reach out (again )?(in|later|after)|check back|not right now|maybe later|in a (few|couple) (weeks|months)|circle back)\b/i],
  ['wants_pricing', /\b(how much|price|pricing|your rate|your fee|fees?\b|percent(age)?|what do you charge|cost)\b/i],
  ['wants_call', /\b(call me|give me a call|phone call|my (cell|number|phone) is|reach me at|text me|can we (talk|hop on a call)|(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}))\b/i],
  ['very_interested', /\b(let'?s (talk|do it|set (it|this) up|get started)|sign me up|ready to (start|go)|when can (we|you) start|book (a|the) call|start (asap|right away|monday|this week))\b/i],
  ['wants_more_info', /\b(more info|more information|tell me more|how does (it|this|that) work|what (do|would) you|details|explain|send (me )?(info|details))\b|\?/i],
  ['interested', /\b(interested|sounds good|sounds great|yes|sure|ok(ay)?|let me know|maybe)\b/i],
];
const COMPLAINT = /\b(spam|report(ed)? you|lawyer|attorney|sue|harass|illegal|how did you get (my|this) (email|address|info))\b/i;

export function ruleClassify(text, { autoSubmitted = false } = {}) {
  const t = latestReplyText(text);
  if (autoSubmitted && RULES[1][1].test(t)) return { classification: 'out_of_office', confidence: 0.95, reasoning: 'Auto-submitted out-of-office reply' };
  if (!t || t.length < 2) return { classification: 'invalid_response', confidence: 0.6, reasoning: 'Empty reply' };
  for (const [cat, re] of RULES) {
    const m = t.match(re);
    if (m) return { classification: cat, confidence: cat === 'interested' ? 0.55 : 0.75, reasoning: `Matched "${m[0]}"` };
  }
  return { classification: 'invalid_response', confidence: 0.4, reasoning: 'No recognizable intent' };
}

export async function classifyReply(text, meta = {}) {
  const rules = ruleClassify(text, meta);
  const complaint = COMPLAINT.test(latestReplyText(text));
  if (!llmEnabled()) return { ...rules, classifier: 'rules', needs_admin: complaint || rules.classification === 'invalid_response', admin_reason: complaint ? 'Possible complaint' : rules.classification === 'invalid_response' ? 'Could not classify' : null };
  try {
    const r = await llmJson(
      `You are the Reply Management Agent for a truck dispatching service. Classify the prospect's latest reply by MEANING, not keywords.
Categories: ${REPLY_CATEGORIES.join(', ')}.
- wants_call: asks for a phone call or gives a phone number. very_interested: wants to start now. interested: positive but vague. wants_pricing: asks about cost/fees. wants_more_info: asks how it works or for details.
- already_has_dispatcher: has a dispatcher, dispatches themselves, or is leased on. follow_up_later: interested but not now.
- not_interested: declines. unsubscribe: asks not to be emailed again. out_of_office: automatic away message. invalid_response: unrelated/unclear.
Set needs_admin true for complaints, legal threats, anger, or questions too specific to answer from a generic service description (contracts, insurance, factoring, specific lanes/rates).
Return {"classification": string, "confidence": 0..1, "reasoning": string, "needs_admin": bool, "admin_reason": string|null, "questions": [string]}`,
      { reply: latestReplyText(text).slice(0, 4000), auto_submitted: !!meta.autoSubmitted, rule_guess: rules.classification },
      { temperature: 0, maxTokens: 400, agent: 'reply' },
    );
    if (!r) return { ...rules, classifier: 'rules', needs_admin: complaint || rules.classification === 'invalid_response', admin_reason: complaint ? 'Possible complaint' : null };
    if (!REPLY_CATEGORIES.includes(r.classification)) return { ...rules, classifier: 'rules', needs_admin: true, admin_reason: 'AI returned unknown category' };
    // Never downgrade an explicit unsubscribe request.
    const classification = rules.classification === 'unsubscribe' ? 'unsubscribe' : r.classification;
    return {
      classification, confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)), reasoning: String(r.reasoning || '').slice(0, 500),
      classifier: 'ai', needs_admin: !!r.needs_admin || complaint || (Number(r.confidence) || 0) < 0.5,
      admin_reason: complaint ? 'Possible complaint' : r.admin_reason || ((Number(r.confidence) || 0) < 0.5 ? 'Low confidence' : null),
      questions: Array.isArray(r.questions) ? r.questions.slice(0, 5) : [],
    };
  } catch {
    return { ...rules, classifier: 'rules', needs_admin: complaint || rules.classification === 'invalid_response', admin_reason: complaint ? 'Possible complaint' : null };
  }
}

// ---------- ingestion ----------
function findOriginal({ inReplyTo, references = [], fromEmail }) {
  for (const id of [inReplyTo, ...references].filter(Boolean)) {
    const m = one('SELECT * FROM messages WHERE message_id_header = ?', id.trim());
    if (m) return m;
  }
  return one(`SELECT * FROM messages WHERE to_email = ? AND status IN ('sent','bounced') ORDER BY sent_at DESC LIMIT 1`, normalizeEmail(fromEmail));
}

export function recordBounce({ recipient, originalMessageId, detail }) {
  const m = (originalMessageId && one('SELECT * FROM messages WHERE message_id_header = ?', originalMessageId))
    || (recipient && one(`SELECT * FROM messages WHERE to_email = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, normalizeEmail(recipient)));
  if (!m) return null;
  if (m.status === 'bounced') return m.id;
  tx(() => {
    const now = nowIso();
    run(`UPDATE messages SET status = 'bounced', error = ?, updated_at = ? WHERE id = ?`, String(detail || 'bounce').slice(0, 500), now, m.id);
    run(`INSERT INTO email_events (message_id, contact_id, type, detail, created_at) VALUES (?, ?, 'bounced', ?, ?)`, m.id, m.contact_id, String(detail || '').slice(0, 500), now);
    suppress(m.to_email, 'bounce', 'dsn');
  });
  checkBounceHealth({ campaignId: m.campaign_id, accountId: m.sending_account_id });
  emit('bounce', { messageId: m.id });
  return m.id;
}

// Returns the new reply id, or null when the mail is not a reply to our outreach (or was already ingested).
export function ingestInbound({ fromEmail, subject = '', text = '', messageId = null, inReplyTo = null, references = [], date = null, autoSubmitted = false }) {
  if (messageId && one('SELECT 1 FROM replies WHERE message_id_header = ?', messageId)) return null;
  const orig = findOriginal({ inReplyTo, references, fromEmail });
  if (!orig) return null;
  const now = nowIso();
  const id = tx(() => {
    const r = run(`INSERT INTO replies (message_id, enrollment_id, company_id, contact_id, from_email, subject, body_text, message_id_header, received_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orig.id, orig.enrollment_id, orig.company_id, orig.contact_id, normalizeEmail(fromEmail), subject, String(text).slice(0, 50000), messageId, date || now, now);
    const rid = Number(r.lastInsertRowid);
    run(`INSERT INTO email_events (message_id, contact_id, type, detail, created_at) VALUES (?, ?, 'replied', ?, ?)`, orig.id, orig.contact_id, `reply #${rid}`, now);
    // Any reply stops the sequence immediately; classification decides what happens next.
    stopEnrollments({ companyId: orig.company_id }, 'replied');
    run(`UPDATE companies SET stage = CASE WHEN stage IN ('new','qualified','contacted') THEN 'replied' ELSE stage END, updated_at = ? WHERE id = ?`, now, orig.company_id);
    return rid;
  });
  enqueue('reply.classify', { replyId: id, autoSubmitted }, { dedupeKey: `classify:${id}` });
  emit('reply', { id });
  return id;
}

// ---------- actions after classification ----------
export async function processReply(replyId, { autoSubmitted = false, actor = 'reply_agent' } = {}) {
  const r = one('SELECT * FROM replies WHERE id = ?', replyId);
  if (!r) return null;
  const c = await classifyReply(`${r.subject ? '' : ''}${r.body_text}`, { autoSubmitted });
  run(`UPDATE replies SET classification = ?, confidence = ?, classifier = ?, reasoning = ?, needs_admin = ?, admin_reason = ? WHERE id = ?`,
    c.classification, c.confidence, c.classifier, c.reasoning, c.needs_admin ? 1 : 0, c.admin_reason ?? null, replyId);
  await applyClassification(replyId, c, actor);
  return c;
}

export async function applyClassification(replyId, c, actor) {
  const r = one('SELECT * FROM replies WHERE id = ?', replyId);
  const company = r.company_id ? one('SELECT * FROM companies WHERE id = ?', r.company_id) : null;
  const setStage = (stage) => company && run('UPDATE companies SET stage = ?, updated_at = ? WHERE id = ? AND stage NOT IN (\'client\',\'meeting\')', stage, nowIso(), company.id);
  switch (c.classification) {
    case 'unsubscribe':
      suppress(r.from_email, 'unsubscribe', 'reply');
      setStage('do_not_contact');
      run(`INSERT INTO email_events (message_id, contact_id, type, detail, created_at) VALUES (?, ?, 'unsubscribed', 'reply', ?)`, r.message_id, r.contact_id, nowIso());
      run('UPDATE replies SET handled = 1 WHERE id = ?', replyId);
      break;
    case 'not_interested':
      suppress(r.from_email, 'do_not_contact', 'reply');
      setStage('not_interested');
      run('UPDATE replies SET handled = 1 WHERE id = ?', replyId);
      break;
    case 'already_has_dispatcher':
      setStage('not_interested');
      run('UPDATE replies SET handled = 1 WHERE id = ?', replyId);
      break;
    case 'out_of_office': {
      // An auto-reply is not a human response: resume the sequence where it stopped.
      if (r.enrollment_id) {
        const e = one('SELECT * FROM enrollments WHERE id = ?', r.enrollment_id);
        if (e?.status === 'stopped' && e.stop_reason === 'replied' && !one(`SELECT 1 FROM enrollments WHERE contact_id = ? AND status = 'active'`, e.contact_id)) {
          run(`UPDATE enrollments SET status = 'active', stop_reason = NULL, next_send_at = ?, updated_at = ? WHERE id = ?`,
            new Date(Date.now() + 3 * 86400000).toISOString(), nowIso(), e.id);
          if (company?.stage === 'replied') run(`UPDATE companies SET stage = 'contacted' WHERE id = ?`, company.id);
        }
      }
      run('UPDATE replies SET handled = 1 WHERE id = ?', replyId);
      break;
    }
    case 'follow_up_later':
      notify('info', `${company?.name || r.from_email} asked to follow up later`, latestReplyText(r.body_text).slice(0, 300), 'reply', replyId);
      break;
    case 'invalid_response':
      break;
    default: // positive categories -> Conversion Agent
      setStage('interested');
      await draftConversionReply(replyId, c, actor);
      notify('action', `${c.classification === 'very_interested' ? 'Hot lead' : 'Positive reply'}: ${company?.name || r.from_email}`,
        latestReplyText(r.body_text).slice(0, 300), 'reply', replyId);
  }
  if (c.needs_admin) notify('action', `Reply needs review: ${company?.name || r.from_email}`, c.admin_reason || 'Complex question', 'reply', replyId);
  audit(actor, 'reply.classified', 'reply', replyId, { classification: c.classification, confidence: c.confidence, classifier: c.classifier });
  emit('reply', { id: replyId, classification: c.classification });
}

export function replyStats() {
  return all('SELECT classification, COUNT(*) n FROM replies GROUP BY classification');
}
