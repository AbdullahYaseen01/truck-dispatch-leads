import { all, run, nowIso } from '../db/index.js';

// Non-secret business settings, editable in the dashboard. API keys live in env (see config.js).
export const DEFAULT_SETTINGS = {
  sender_company_name: '',
  sender_person_name: '',
  postal_address: '',              // CAN-SPAM requires a valid physical postal address
  reply_to_email: '',
  admin_notify_email: '',
  calendly_url: '',
  pricing_enabled: false,
  pricing_text: '',                // e.g. "Our fee is 5% of the gross load rate"
  services_description:
    'We help owner-operators and small fleets find good-paying loads, negotiate rates with brokers, plan routes to cut deadhead, and handle rate confirmations, invoices and other dispatch paperwork.',
  allowed_outreach_countries: ['US'],
  allow_likely_valid_sends: false, // send to addresses the business published itself but whose mailbox is unconfirmed?
  allow_risky_sends: false,        // send to catch-all / unknown addresses?
  allow_role_addresses: true,      // info@, dispatch@ etc. are normal for small carriers
  recheck_after_days: 30,          // re-verify contacts older than this before sending
  min_lead_score_to_enroll: 50,
  auto_reply_enabled: false,       // send AI replies to clearly interested prospects without approval
  send_window_start_hour: 8,       // in the RECIPIENT's local time (from the business state)
  send_window_end_hour: 17,
  send_weekends: false,
  min_days_between_company_emails: 2, // never email the same business more often than this
  max_company_emails_30d: 5,       // hard cap per business per 30 days, across all campaigns
  reenroll_after_days: 180,        // a business that finished/stopped a sequence is not re-enrolled before this
  bounce_pause_percent: 5,         // auto-pause a campaign or sending account above this bounce rate (after 20 sends)
  ai_research_summaries: false,    // rewrite research briefs with AI (uses free AI quota; the rule-based brief is always built)
  respect_robots_txt: true,
  max_pages_per_site: 5,
  retention_job_days: 30,          // finished background jobs are deleted after this
  retention_audit_days: 365,
  backup_keep: 7,                  // daily database backups kept in data/backups
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) {
    if (r.key in DEFAULT_SETTINGS) {
      try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ }
    }
  }
  return out;
}

export function updateSettings(patch) {
  const changed = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    let val = v;
    if (typeof def === 'boolean') val = v === true || v === 'true' || v === 1;
    else if (typeof def === 'number') { val = Number(v); if (!Number.isFinite(val)) continue; }
    else if (Array.isArray(def)) val = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    else val = String(v ?? '').trim();
    run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      k, JSON.stringify(val), nowIso());
    changed[k] = val;
  }
  return changed;
}

// Outreach must not start until sender identity and postal address are present (CAN-SPAM).
export function complianceProblems(s = getSettings()) {
  const p = [];
  if (!s.sender_company_name) p.push('Sender company name is not set (Settings).');
  if (!s.sender_person_name) p.push('Sender person name is not set (Settings).');
  if (!s.postal_address) p.push('Physical postal address is not set (required by CAN-SPAM).');
  return p;
}
