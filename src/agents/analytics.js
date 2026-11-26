import { one, all, run, nowIso } from '../db/index.js';
import { llmEnabled, llmJson } from '../lib/llm.js';
import { POSITIVE } from './constants.js';
import { wilsonLower, MIN_SAMPLE as LEARN_MIN } from './learning.js';

// Analytics Agent. Every number here is a COUNT over real rows; nothing is estimated or seeded.

const POS = POSITIVE.map((p) => `'${p}'`).join(',');
const n = (sql, ...p) => one(sql, ...p).n;

export function overviewStats() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = today.toISOString();
  return {
    total_leads: n('SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NULL'),
    qualified: n(`SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NULL AND stage = 'qualified'`),
    interested: n(`SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NULL AND stage IN ('interested','meeting')`),
    likely_valid_emails: n(`SELECT COUNT(*) n FROM contacts WHERE verification_status = 'likely_valid'`),
    needs_review: n(`SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NULL AND stage IN ('new','qualified') AND intent_score >= 70 AND eligibility LIKE '%\"eligible\":false%'`),
    suppressed_contacts: n('SELECT COUNT(*) n FROM suppressions'),
    active_campaigns: n(`SELECT COUNT(*) n FROM campaigns WHERE status = 'active'`),
    completed_campaigns: n(`SELECT COUNT(*) n FROM campaigns WHERE status = 'completed'`),
    scheduled_followups: n(`SELECT COUNT(*) n FROM enrollments WHERE status = 'active' AND current_step > 0`),
    new_today: n('SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NULL AND first_discovered_at >= ?', t),
    high_intent: n('SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NULL AND intent_score >= 70'),
    verified_emails: n(`SELECT COUNT(*) n FROM contacts WHERE verification_status = 'verified'`),
    risky_emails: n(`SELECT COUNT(*) n FROM contacts WHERE verification_status IN ('risky','unknown')`),
    invalid_emails: n(`SELECT COUNT(*) n FROM contacts WHERE verification_status IN ('invalid','disposable','previously_bounced')`),
    duplicate_leads: n('SELECT COUNT(*) n FROM companies WHERE duplicate_of IS NOT NULL') + n(`SELECT COUNT(*) n FROM contacts WHERE verification_status = 'duplicate'`),
    emails_sent: n(`SELECT COUNT(*) n FROM email_events WHERE type = 'sent'`),
    // Accepted by the receiving server and not bounced since. (Opens are not tracked: no tracking pixels.)
    emails_delivered: n(`SELECT COUNT(*) n FROM messages WHERE status = 'sent'`),
    emails_bounced: n(`SELECT COUNT(*) n FROM email_events WHERE type = 'bounced'`),
    followups_sent: n(`SELECT COUNT(*) n FROM messages m WHERE m.kind = 'sequence' AND m.step_number > 1 AND m.status IN ('sent','bounced')`),
    replies: n('SELECT COUNT(*) n FROM replies'),
    positive_replies: n(`SELECT COUNT(*) n FROM replies WHERE classification IN (${POS})`),
    unsubscribes: n(`SELECT COUNT(*) n FROM suppressions WHERE reason = 'unsubscribe'`),
    meetings: n('SELECT COUNT(*) n FROM meetings'),
    clients: n(`SELECT COUNT(*) n FROM companies WHERE stage = 'client'`),
    pending_approval: n(`SELECT COUNT(*) n FROM messages WHERE status = 'pending_approval'`),
    needs_admin: n('SELECT COUNT(*) n FROM replies WHERE needs_admin = 1 AND handled = 0'),
  };
}

export function timeseries(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const series = (sql) => Object.fromEntries(all(sql, since).map((r) => [r.d, r.n]));
  const leads = series(`SELECT substr(first_discovered_at,1,10) d, COUNT(*) n FROM companies WHERE first_discovered_at >= ? AND duplicate_of IS NULL GROUP BY d`);
  const sent = series(`SELECT substr(created_at,1,10) d, COUNT(*) n FROM email_events WHERE type = 'sent' AND created_at >= ? GROUP BY d`);
  const replies = series(`SELECT substr(received_at,1,10) d, COUNT(*) n FROM replies WHERE received_at >= ? GROUP BY d`);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, leads: leads[d] || 0, sent: sent[d] || 0, replies: replies[d] || 0 });
  }
  return out;
}

// Outcome funnel per dimension: how many leads -> contacted -> replied -> positive -> client.
function funnel(groupSql) {
  return all(`WITH base AS (${groupSql})
    SELECT k, COUNT(DISTINCT company_id) leads,
      COUNT(DISTINCT CASE WHEN (SELECT lead_score FROM companies c WHERE c.id = base.company_id) >= 50 THEN company_id END) qualified,
      COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.company_id = base.company_id AND m.kind = 'sequence' AND m.status IN ('sent','bounced')) THEN company_id END) contacted,
      COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.company_id = base.company_id) THEN company_id END) replied,
      COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.company_id = base.company_id AND r.classification IN (${POS})) THEN company_id END) positive,
      COUNT(DISTINCT CASE WHEN (SELECT stage FROM companies c WHERE c.id = base.company_id) = 'client' THEN company_id END) clients
    FROM base WHERE k IS NOT NULL GROUP BY k ORDER BY positive DESC, leads DESC LIMIT 20`);
}

export function breakdowns() {
  return {
    by_source: funnel(`SELECT DISTINCT s.source k, s.company_id FROM lead_sources s JOIN companies c ON c.id = s.company_id WHERE c.duplicate_of IS NULL`),
    by_category: funnel(`SELECT prospect_category k, id company_id FROM companies WHERE duplicate_of IS NULL`),
    by_equipment: funnel(`SELECT j.value k, c.id company_id FROM companies c, json_each(c.equipment_types) j WHERE c.duplicate_of IS NULL`),
    by_state: funnel(`SELECT state k, id company_id FROM companies WHERE duplicate_of IS NULL`),
    by_intent_band: funnel(`SELECT CASE WHEN intent_score >= 90 THEN '90-100' WHEN intent_score >= 70 THEN '70-89' WHEN intent_score >= 40 THEN '40-69' ELSE '0-39' END k, id company_id FROM companies WHERE duplicate_of IS NULL`),
    // Subject lines and writer: replies attributed to the message they answered.
    by_subject: all(`SELECT m.subject k, COUNT(*) sent,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.message_id = m.id) THEN 1 ELSE 0 END) replied,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.message_id = m.id AND r.classification IN (${POS})) THEN 1 ELSE 0 END) positive
      FROM messages m WHERE m.kind = 'sequence' AND m.status IN ('sent','bounced') GROUP BY m.subject ORDER BY positive DESC, replied DESC, sent DESC LIMIT 15`),
    by_step: all(`SELECT m.step_number k, m.generated_by writer, COUNT(*) sent,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.message_id = m.id) THEN 1 ELSE 0 END) replied,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.message_id = m.id AND r.classification IN (${POS})) THEN 1 ELSE 0 END) positive
      FROM messages m WHERE m.kind = 'sequence' AND m.status IN ('sent','bounced') GROUP BY m.step_number, m.generated_by ORDER BY k`),
    // A/B experiments: per campaign step and template variant, with a conservative (Wilson) lower bound.
    by_variant: all(`SELECT m.campaign_id, k.name campaign, m.step_number step, COALESCE(m.variant, '-') variant, t.name template, COUNT(*) sent,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.message_id = m.id) THEN 1 ELSE 0 END) replied,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.message_id = m.id AND r.classification IN (${POS})) THEN 1 ELSE 0 END) positive
      FROM messages m LEFT JOIN campaigns k ON k.id = m.campaign_id LEFT JOIN templates t ON t.id = m.template_id
      WHERE m.kind = 'sequence' AND m.status IN ('sent','bounced') AND m.variant IS NOT NULL
      GROUP BY m.campaign_id, m.step_number, m.variant ORDER BY m.campaign_id, m.step_number, m.variant`)
      .map((r) => ({ ...r, positive_lower: Math.round(1000 * wilsonLower(r.positive, r.sent)) / 10, enough_data: r.sent >= LEARN_MIN })),
    by_signal: funnel(`SELECT j.value ->> 'signal' k, c.id company_id FROM companies c, json_each(c.intent_signals) j
      WHERE c.duplicate_of IS NULL AND (j.value ->> 'weight') > 0`),
    replies_by_class: all('SELECT classification k, COUNT(*) n FROM replies GROUP BY classification ORDER BY n DESC'),
    verification: all('SELECT verification_status k, COUNT(*) n FROM contacts GROUP BY verification_status ORDER BY n DESC'),
    stages: all('SELECT stage k, COUNT(*) n FROM companies WHERE duplicate_of IS NULL GROUP BY stage ORDER BY n DESC'),
  };
}

const AGENT_OF = {
  'search.run': 'Discovery', 'search.query': 'Discovery', 'lead.enrich': 'Email Discovery', 'contact.verify': 'Verification',
  'dedupe.sweep': 'Deduplication', 'lead.qualify': 'Intent + Qualification', 'lead.research': 'Business Research',
  'outreach.tick': 'Outreach + Personalization', 'inbox.poll': 'Reply Management', 'reply.classify': 'Reply Management',
  'analytics.snapshot': 'Analytics', 'freshness.recheck': 'Verification', 'disposable.refresh': 'Verification', 'maintenance.daily': 'Maintenance',
};

// What each agent actually did in the last 24 hours, from the job table and the AI usage log.
export function agentActivity() {
  const since = new Date(Date.now() - 86400000).toISOString();
  const agents = {};
  for (const r of all(`SELECT type, status, COUNT(*) n, MAX(updated_at) last FROM jobs WHERE updated_at >= ? GROUP BY type, status`, since)) {
    const a = AGENT_OF[r.type] || r.type;
    agents[a] ||= { agent: a, done: 0, failed: 0, queued: 0, running: 0, last: null };
    agents[a][r.status] += r.n;
    if (!agents[a].last || r.last > agents[a].last) agents[a].last = r.last;
  }
  const extra = {
    'Conversion': n(`SELECT COUNT(*) n FROM messages WHERE kind = 'reply' AND created_at >= ?`, since),
    'Personalization (emails written)': n(`SELECT COUNT(*) n FROM messages WHERE kind = 'sequence' AND created_at >= ?`, since),
  };
  return {
    agents: Object.values(agents).sort((a, b) => a.agent.localeCompare(b.agent)),
    extra,
    ai_usage: all('SELECT agent, calls, failures, cache_hits FROM llm_usage WHERE day = ? ORDER BY agent', new Date().toISOString().slice(0, 10)),
    workers: { queued: n(`SELECT COUNT(*) n FROM jobs WHERE status = 'queued' AND run_at <= ?`, nowIso()), stuck: n(`SELECT COUNT(*) n FROM jobs WHERE status = 'running' AND locked_at < ?`, new Date(Date.now() - 15 * 60000).toISOString()) },
  };
}

const rate = (a, b) => (b ? a / b : 0);
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const MIN_SAMPLE = 20;

// Rule-based insights with minimum sample sizes, so small numbers are not over-interpreted.
export function ruleInsights(stats, b) {
  const out = [];
  const bestBy = (rows, label) => {
    const eligible = rows.filter((r) => r.contacted >= MIN_SAMPLE);
    if (eligible.length < 2) return;
    eligible.sort((x, y) => rate(y.positive, y.contacted) - rate(x.positive, x.contacted));
    const [top, low] = [eligible[0], eligible[eligible.length - 1]];
    if (rate(top.positive, top.contacted) > rate(low.positive, low.contacted)) {
      out.push(`${label} "${top.k}" has the best positive-reply rate (${pct(rate(top.positive, top.contacted))} of ${top.contacted} contacted) vs "${low.k}" (${pct(rate(low.positive, low.contacted))}). Shift discovery toward ${top.k}.`);
    }
  };
  bestBy(b.by_source, 'Source');
  bestBy(b.by_category, 'Category');
  bestBy(b.by_equipment, 'Equipment');
  bestBy(b.by_intent_band, 'Intent band');
  const subj = b.by_subject.filter((s) => s.sent >= MIN_SAMPLE);
  if (subj.length >= 2) out.push(`Best subject line so far: "${subj[0].k}" (${pct(rate(subj[0].replied, subj[0].sent))} reply rate over ${subj[0].sent} sends).`);
  if (stats.emails_sent >= MIN_SAMPLE && rate(stats.emails_bounced, stats.emails_sent) > 0.03) {
    out.push(`Bounce rate is ${pct(rate(stats.emails_bounced, stats.emails_sent))}, above the 3% safe limit. Turn off "allow risky sends" or add a verification provider key.`);
  }
  if (stats.risky_emails > stats.verified_emails && stats.risky_emails > 10) out.push(`${stats.risky_emails} emails are risky (mailbox not confirmed). A ZeroBounce/NeverBounce key would confirm many of them.`);
  if (stats.pending_approval > 0) out.push(`${stats.pending_approval} email(s) are waiting for your approval in Campaign Management.`);
  if (stats.needs_admin > 0) out.push(`${stats.needs_admin} reply/replies need your personal attention in AI Reply Management.`);
  if (!out.length) out.push(`Not enough outreach data yet for reliable comparisons (insights need at least ${MIN_SAMPLE} contacted leads per group).`);
  return out;
}

export async function analyticsSnapshot() {
  const stats = overviewStats();
  const b = breakdowns();
  let insights = ruleInsights(stats, b);
  if (llmEnabled() && stats.emails_sent >= MIN_SAMPLE) {
    try {
      const r = await llmJson('You are the Analytics Agent for a truck dispatching lead-generation system. Given real counts, give up to 5 short, specific, actionable recommendations. Do not invent numbers; cite only numbers given. Avoid conclusions from groups with fewer than 20 contacted leads. Return {"insights": [string]}.',
        { stats, breakdowns: b, rule_insights: insights }, { maxTokens: 500 });
      if (Array.isArray(r.insights) && r.insights.length) insights = r.insights.map(String).slice(0, 6);
    } catch { /* keep rule insights */ }
  }
  run('INSERT INTO analytics_snapshots (metrics, insights, created_at) VALUES (?, ?, ?)', JSON.stringify({ stats, breakdowns: b }), JSON.stringify(insights), nowIso());
  return { insights: insights.length };
}

export function latestInsights() {
  const r = one('SELECT insights, created_at FROM analytics_snapshots ORDER BY id DESC LIMIT 1');
  if (r) return { insights: JSON.parse(r.insights), created_at: r.created_at };
  return { insights: ruleInsights(overviewStats(), breakdowns()), created_at: nowIso() };
}
