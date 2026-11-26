-- Upgrade: richer verification statuses, research agent, experiments, learning, reliability.

-- contacts: new statuses (likely_valid, unknown, previously_bounced) + verification provenance.
CREATE TABLE contacts_new (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  name TEXT,
  title TEXT,
  contact_type TEXT NOT NULL DEFAULT 'business',
  source TEXT NOT NULL,
  source_url TEXT,
  discovered_at TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN
    ('unverified','verified','likely_valid','risky','unknown','invalid','disposable','duplicate','previously_bounced','suppressed')),
  verification_detail TEXT NOT NULL DEFAULT '{}',
  verification_provider TEXT,        -- zerobounce, neverbounce, smtp_probe, dns, rules
  verified_at TEXT,
  ownership_evidence TEXT,           -- fmcsa_registration, own_website, manual_listing
  is_role INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER REFERENCES contacts(id),
  created_at TEXT NOT NULL,
  UNIQUE (company_id, email_normalized)
);
INSERT INTO contacts_new (id, company_id, email, email_normalized, name, title, contact_type, source, source_url, discovered_at,
  verification_status, verification_detail, verified_at, is_role, duplicate_of, created_at)
SELECT id, company_id, email, email_normalized, name, title, contact_type, source, source_url, discovered_at,
  verification_status, verification_detail, verified_at, is_role, duplicate_of, created_at FROM contacts;
DROP TABLE contacts;
ALTER TABLE contacts_new RENAME TO contacts;
CREATE INDEX idx_contacts_email ON contacts(email_normalized);
CREATE INDEX idx_contacts_status ON contacts(verification_status);
CREATE INDEX idx_contacts_company ON contacts(company_id);
UPDATE contacts SET verification_status = 'previously_bounced'
  WHERE email_normalized IN (SELECT email_normalized FROM suppressions WHERE reason = 'bounce');

-- replies: add "wants_call".
CREATE TABLE replies_new (
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
  classification TEXT CHECK (classification IN ('interested','very_interested','wants_pricing','wants_more_info','wants_call',
    'already_has_dispatcher','follow_up_later','not_interested','unsubscribe','out_of_office','invalid_response')),
  confidence REAL,
  classifier TEXT,
  reasoning TEXT,
  needs_admin INTEGER NOT NULL DEFAULT 0,
  admin_reason TEXT,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO replies_new SELECT * FROM replies;
DROP TABLE replies;
ALTER TABLE replies_new RENAME TO replies;
CREATE INDEX idx_replies_company ON replies(company_id);
CREATE INDEX idx_replies_message ON replies(message_id);

-- companies: research, priority/confidence, authority events, fleet history, cached AI inputs.
ALTER TABLE companies ADD COLUMN research_summary TEXT;
ALTER TABLE companies ADD COLUMN researched_at TEXT;
ALTER TABLE companies ADD COLUMN research_hash TEXT;
ALTER TABLE companies ADD COLUMN intent_hash TEXT;
ALTER TABLE companies ADD COLUMN priority TEXT;
ALTER TABLE companies ADD COLUMN confidence_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN eligibility TEXT NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN authority_event TEXT;          -- JSON {type, at, docket}
ALTER TABLE companies ADD COLUMN operating_region TEXT;
ALTER TABLE companies ADD COLUMN fleet_history TEXT NOT NULL DEFAULT '[]';

-- experiments: per-step template variants; which variant each message used.
ALTER TABLE campaign_steps ADD COLUMN variant_template_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN template_id INTEGER REFERENCES templates(id);
ALTER TABLE messages ADD COLUMN variant TEXT;
ALTER TABLE messages ADD COLUMN subject_candidates TEXT;

-- free-tier AI usage accounting per agent per day.
CREATE TABLE llm_usage (
  day TEXT NOT NULL,
  agent TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent)
);

-- SMTP probe etiquette: back off from mail hosts that refuse our probes.
CREATE TABLE mx_probe_state (
  host TEXT PRIMARY KEY,
  blocked_until TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);

-- Disposable domains refreshed weekly from the public disposable-email-domains list.
CREATE TABLE disposable_domains (domain TEXT PRIMARY KEY);

CREATE INDEX idx_enrollments_company ON enrollments(company_id);
CREATE INDEX idx_messages_company ON messages(company_id, sent_at);
CREATE INDEX idx_messages_campaign ON messages(campaign_id, status);
CREATE INDEX idx_companies_stage ON companies(stage);
CREATE INDEX idx_companies_discovered ON companies(first_discovered_at);

-- Truthful subject line for the final step (no implied existing relationship).
UPDATE templates SET subject = 'last note about dispatch help for {{company}}' WHERE purpose = 'final' AND subject = 'should I close your file?';
