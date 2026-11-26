-- Core schema for the trucking dispatch lead platform.
-- All timestamps are ISO-8601 UTC strings.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- sha256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,               -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT NOT NULL DEFAULT 'US',
  equipment_types TEXT NOT NULL DEFAULT '[]',   -- JSON array
  prospect_category TEXT,
  fleet_size INTEGER,
  mc_number TEXT,
  usdot_number TEXT,
  operating_status TEXT,             -- e.g. 'authorized', 'not_authorized', 'operational', 'closed'
  authority_checked_at TEXT,
  authority_granted_at TEXT,         -- FMCSA add date (business start evidence)
  owner_name TEXT,
  intent_score INTEGER NOT NULL DEFAULT 0,
  intent_signals TEXT NOT NULL DEFAULT '[]',    -- JSON array of {signal, evidence, source_url, weight}
  intent_summary TEXT,
  intent_method TEXT,
  dispatch_need TEXT,
  lead_score INTEGER NOT NULL DEFAULT 0,
  lead_score_breakdown TEXT NOT NULL DEFAULT '{}',
  qualification_summary TEXT,
  freshness_score INTEGER NOT NULL DEFAULT 0,
  source_reliability REAL NOT NULL DEFAULT 0.5,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN
    ('new','qualified','disqualified','contacted','replied','interested','meeting','client','not_interested','do_not_contact')),
  lawful_basis TEXT,                 -- required for non-US outreach
  duplicate_of INTEGER REFERENCES companies(id),
  first_discovered_at TEXT NOT NULL,
  last_verified_at TEXT,
  last_website_activity_at TEXT,
  last_website_activity_evidence TEXT,
  last_info_update_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_companies_domain ON companies(domain);
CREATE INDEX idx_companies_dot ON companies(usdot_number);
CREATE INDEX idx_companies_phone ON companies(phone);
CREATE INDEX idx_companies_name_state ON companies(normalized_name, state);
CREATE INDEX idx_companies_scores ON companies(lead_score, intent_score);

CREATE TABLE lead_sources (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source TEXT NOT NULL,              -- fmcsa_census, google_places, google_cse, brave, reddit, website, manual
  source_url TEXT,
  query TEXT,
  title TEXT,
  snippet TEXT,
  published_at TEXT,
  search_run_id INTEGER,
  discovered_at TEXT NOT NULL,
  UNIQUE (company_id, source, source_url)
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  name TEXT,
  title TEXT,
  contact_type TEXT NOT NULL DEFAULT 'business',  -- owner, business, operations, fleet, dispatch, role
  source TEXT NOT NULL,
  source_url TEXT,
  discovered_at TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN
    ('unverified','verified','risky','invalid','disposable','duplicate','suppressed')),
  verification_detail TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,
  is_role INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER REFERENCES contacts(id),
  created_at TEXT NOT NULL,
  UNIQUE (company_id, email_normalized)
);
CREATE INDEX idx_contacts_email ON contacts(email_normalized);
CREATE INDEX idx_contacts_status ON contacts(verification_status);

CREATE TABLE suppressions (
  email_normalized TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe','bounce','complaint','manual','do_not_contact')),
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE search_runs (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  params TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_by TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE search_schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  params TEXT NOT NULL,              -- same shape as search_runs.params
  interval_minutes INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  run_at TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  dedupe_key TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_jobs_ready ON jobs(status, run_at);
-- Only one unfinished job per dedupe key, so the same work is never queued twice.
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,               -- user email or agent name
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TABLE sending_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL UNIQUE,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT NOT NULL,
  smtp_pass_enc TEXT NOT NULL,
  imap_host TEXT,
  imap_port INTEGER,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_user TEXT,
  imap_pass_enc TEXT,
  imap_last_uid INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 40,
  hourly_limit INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('intro','followup','benefits','final','reply_interested','reply_pricing','reply_info')),
  subject TEXT NOT NULL,             -- may contain {{placeholders}}
  body TEXT NOT NULL,
  ai_guidance TEXT,                  -- extra instructions for AI personalization
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  segment TEXT NOT NULL DEFAULT '{}',  -- lead filters
  require_approval INTEGER NOT NULL DEFAULT 1,
  sending_account_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE campaign_steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  day_offset INTEGER NOT NULL,
  template_id INTEGER REFERENCES templates(id),
  purpose TEXT NOT NULL,
  UNIQUE (campaign_id, step_number)
);

CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','completed')),
  stop_reason TEXT,
  current_step INTEGER NOT NULL DEFAULT 0,  -- last step sent
  next_send_at TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, contact_id)
);
-- A contact can be in at most one active sequence at a time, across all campaigns.
CREATE UNIQUE INDEX idx_enrollments_one_active ON enrollments(contact_id) WHERE status = 'active';

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER REFERENCES enrollments(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  reply_id INTEGER,                  -- set when this outbound answers an inbound reply
  step_number INTEGER,
  kind TEXT NOT NULL DEFAULT 'sequence' CHECK (kind IN ('sequence','reply')),
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','sending','sent','failed','bounced','rejected','cancelled')),
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  to_email TEXT NOT NULL,
  from_email TEXT,
  sending_account_id INTEGER REFERENCES sending_accounts(id),
  message_id_header TEXT UNIQUE,
  in_reply_to TEXT,
  generated_by TEXT NOT NULL,        -- 'ai' or 'template'
  personalization_facts TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Each sequence step is generated and sent at most once per enrollment.
CREATE UNIQUE INDEX idx_messages_step_once ON messages(enrollment_id, step_number) WHERE kind = 'sequence';
CREATE INDEX idx_messages_status ON messages(status);

CREATE TABLE replies (
  id INTEGER PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  enrollment_id INTEGER REFERENCES enrollments(id),
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  from_email TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  message_id_header TEXT UNIQUE,
  received_at TEXT NOT NULL,
  classification TEXT CHECK (classification IN ('interested','very_interested','wants_pricing','wants_more_info',
    'already_has_dispatcher','follow_up_later','not_interested','unsubscribe','out_of_office','invalid_response')),
  confidence REAL,
  classifier TEXT,
  reasoning TEXT,
  needs_admin INTEGER NOT NULL DEFAULT 0,
  admin_reason TEXT,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE email_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  contact_id INTEGER REFERENCES contacts(id),
  type TEXT NOT NULL CHECK (type IN ('sent','bounced','replied','unsubscribed','complaint','failed')),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_type ON email_events(type, created_at);

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  email TEXT,
  scheduled_for TEXT,
  source TEXT NOT NULL,              -- calendly, manual
  external_id TEXT UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info','warning','action')),
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE analytics_snapshots (
  id INTEGER PRIMARY KEY,
  metrics TEXT NOT NULL,
  insights TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE robots_cache (
  origin TEXT PRIMARY KEY,
  body TEXT,
  status INTEGER,
  fetched_at TEXT NOT NULL
);
