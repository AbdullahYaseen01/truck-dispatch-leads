import fs from 'node:fs';
import path from 'node:path';

// Load .env (KEY=VALUE lines) without overriding variables already set in the environment.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Secrets live only here (server side). They are never sent to the browser or written to logs.
export const config = {
  port: num(env.PORT, 3000),
  dataDir: env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  appSecret: env.APP_SECRET || '',
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ''),
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  workerConcurrency: num(env.WORKER_CONCURRENCY, 6),
  secureCookies: env.SECURE_COOKIES === '1',
  // FREE_ONLY (default on): integrations that need a paid plan or billing account stay off even if a key is set.
  freeOnly: env.FREE_ONLY !== '0',
  llm: {
    apiKey: env.LLM_API_KEY || '',
    // OpenAI-compatible endpoint. Free options: a local Ollama server (http://localhost:11434/v1, no key),
    // or a provider's free tier (e.g. Groq, Google Gemini OpenAI-compatible endpoint) with its free key.
    baseUrl: (env.LLM_BASE_URL || (env.LLM_API_KEY ? 'https://api.openai.com/v1' : '')).replace(/\/$/, ''),
    model: env.LLM_MODEL || 'llama3.1:8b',
    dailyLimit: num(env.LLM_DAILY_LIMIT, 300), // calls/day across all agents; keeps usage inside free quotas
    timeoutMs: num(env.LLM_TIMEOUT_MS, 120000),
  },
  sources: {
    googleCseKey: env.GOOGLE_CSE_KEY || '',
    googleCseCx: env.GOOGLE_CSE_CX || '',
    googlePlacesKey: env.GOOGLE_PLACES_KEY || '',
    braveKey: env.BRAVE_SEARCH_KEY || '',
    fmcsaWebKey: env.FMCSA_WEBKEY || '',
    socrataAppToken: env.SOCRATA_APP_TOKEN || '',
    redditClientId: env.REDDIT_CLIENT_ID || '',
    redditClientSecret: env.REDDIT_CLIENT_SECRET || '',
    userAgent: env.CRAWLER_USER_AGENT || 'DispatchLeadBot/1.0 (+contact: set CRAWLER_USER_AGENT)',
  },
  verification: {
    zeroBounceKey: env.ZEROBOUNCE_API_KEY || '',
    neverBounceKey: env.NEVERBOUNCE_API_KEY || '',
    // Free mailbox check over SMTP (RCPT TO, never sends mail). Needs outbound port 25.
    smtpProbe: env.SMTP_PROBE !== '0',
    smtpProbeHelo: env.SMTP_PROBE_HELO || 'mail-verifier.local',
    smtpProbeFrom: env.SMTP_PROBE_FROM || `verify@${env.SMTP_PROBE_HELO || 'mail-verifier.local'}`,
    probeGapMs: num(env.SMTP_PROBE_GAP_MS, 1500), // minimum gap between probes to the same mail server
  },
  inboundWebhookSecret: env.INBOUND_WEBHOOK_SECRET || '',
  calendlyWebhookSigningKey: env.CALENDLY_WEBHOOK_SIGNING_KEY || '',
};

export function assertProductionConfig() {
  const problems = [];
  if (!config.appSecret || config.appSecret.length < 32) problems.push('APP_SECRET must be set to at least 32 random characters');
  return problems;
}

const PAID_LLM_HOSTS = /api\.openai\.com|api\.anthropic\.com|openai\.azure\.com/i;

export function llmIsPaid() {
  return PAID_LLM_HOSTS.test(config.llm.baseUrl);
}

export function llmConfigured() {
  return !!config.llm.baseUrl && !(config.freeOnly && llmIsPaid());
}

// Paid integrations are switched off in free-only mode.
export const PAID = { googlePlaces: true, zeroBounce: true, neverBounce: true };
const allowed = (key, configured) => configured && !(config.freeOnly && PAID[key]);

// Which integrations are active, for the Settings page. Booleans only, never values.
export function integrationStatus() {
  const s = config.sources;
  return {
    freeOnly: config.freeOnly,
    llm: llmConfigured(),
    llmBlockedPaid: !!config.llm.baseUrl && config.freeOnly && llmIsPaid(),
    llmModel: config.llm.model,
    llmDailyLimit: config.llm.dailyLimit,
    fmcsaCensus: true,
    fmcsaAuthority: true,
    fmcsaQcMobile: !!s.fmcsaWebKey,
    googlePlaces: allowed('googlePlaces', !!s.googlePlacesKey),
    googleCse: !!(s.googleCseKey && s.googleCseCx),
    brave: !!s.braveKey,
    reddit: !!(s.redditClientId && s.redditClientSecret),
    zeroBounce: allowed('zeroBounce', !!config.verification.zeroBounceKey),
    neverBounce: allowed('neverBounce', !!config.verification.neverBounceKey),
    smtpProbe: config.verification.smtpProbe,
    inboundWebhook: !!config.inboundWebhookSecret,
    calendlyWebhook: !!config.calendlyWebhookSigningKey,
  };
}
