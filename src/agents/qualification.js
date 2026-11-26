import { one, all, run, nowIso, json } from '../db/index.js';
import { getSettings } from '../lib/settings.js';
import { llmEnabled, llmJson } from '../lib/llm.js';
import { daysAgo } from '../lib/text.js';
import { detectIntent, intentBand } from './intent.js';
import { learnedAdjustment, leadTraits } from './learning.js';
import { priorityOf, MAILABLE } from './constants.js';
import { enqueue } from '../queue/queue.js';

// Qualification Agent: freshness score, lead score with an explanation for every point, and a summary.

const CONTACT_RANK = { owner: 5, dispatch: 4, operations: 4, fleet: 3, business: 2, role: 1 };
const STATUS_RANK = { verified: 5, likely_valid: 4, risky: 3, unknown: 2, unverified: 1 };

export function bestContact(contacts) {
  return contacts
    .filter((c) => STATUS_RANK[c.verification_status] && !c.duplicate_of)
    .sort((a, b) => (STATUS_RANK[b.verification_status] - STATUS_RANK[a.verification_status])
      || ((CONTACT_RANK[b.contact_type] || 0) - (CONTACT_RANK[a.contact_type] || 0))
      || (a.is_role - b.is_role) || a.id - b.id)[0] || null;
}

function band(days, steps) {
  for (const [max, pts] of steps) if (days <= max) return pts;
  return 0;
}

export function freshnessScore(company, contacts, sources) {
  const parts = [];
  const disc = band(daysAgo(company.first_discovered_at), [[7, 25], [30, 20], [90, 12], [Infinity, 5]]);
  parts.push({ part: 'Discovered', points: disc, of: 25, why: `first found ${Math.round(daysAgo(company.first_discovered_at))} days ago` });

  const verifiedAt = contacts.map((c) => c.verified_at).filter(Boolean).sort().pop();
  const ver = band(daysAgo(verifiedAt), [[7, 25], [30, 18], [90, 8]]);
  parts.push({ part: 'Email verified', points: ver, of: 25, why: verifiedAt ? `last email check ${Math.round(daysAgo(verifiedAt))} days ago` : 'no email checked yet' });

  const evidence = [
    company.last_website_activity_at && { at: company.last_website_activity_at, what: company.last_website_activity_evidence || 'website activity' },
    company.authority_granted_at && { at: company.authority_granted_at, what: 'FMCSA registration date' },
    ...sources.filter((s) => s.published_at).map((s) => ({ at: s.published_at, what: `${s.source} post/listing date` })),
  ].filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const latest = evidence[0];
  const act = latest ? band(daysAgo(latest.at), [[90, 25], [365, 15], [730, 5]]) : 0;
  parts.push({ part: 'Activity evidence', points: act, of: 25, why: latest ? `${latest.what}: ${String(latest.at).slice(0, 10)}` : 'no dated activity evidence (not assumed active)' });

  const rel = Math.round((company.source_reliability || 0.5) * 25);
  parts.push({ part: 'Source reliability', points: rel, of: 25, why: `best source reliability ${(company.source_reliability || 0.5).toFixed(2)}` });
  return { score: Math.min(100, disc + ver + act + rel), parts };
}

export function leadScore(company, intent, fresh, contacts, settings = getSettings(), learned = null) {
  const parts = [];
  const fleet = company.fleet_size;
  const post = company.prospect_category === 'Community Post';
  let demand = 8;
  let demandWhy = 'fleet size unknown';
  if (intent.is_provider) { demand = 0; demandWhy = 'is a dispatch provider itself'; }
  else if (fleet && fleet <= 10) { demand = 20; demandWhy = `${fleet} power unit(s): owner-operators and small fleets are the core dispatch market`; }
  else if (fleet && fleet <= 25) { demand = 10; demandWhy = `${fleet} power units: mid-size fleet, may have in-house dispatch`; }
  else if (fleet) { demand = 4; demandWhy = `${fleet} power units: large fleet, usually in-house dispatch`; }
  else if (post) { demand = 14; demandWhy = 'individual driver posting in a trucking community'; }
  parts.push({ part: 'Dispatching demand', points: demand, of: 20, why: demandWhy });

  const intentPts = Math.round(intent.score * 0.3);
  parts.push({ part: 'Buying intent', points: intentPts, of: 30, why: `intent ${intent.score}/100 (${intentBand(intent.score).replace('_', ' ')}): ${intent.summary}` });

  let rel = 8;
  let relWhy = 'trucking business from search results';
  const st = company.operating_status;
  if (['closed', 'not_authorized', 'inactive_usdot'].includes(st)) { rel = 0; relWhy = `operating status: ${st}`; }
  else if (st === 'authorized') { rel = 15; relWhy = 'FMCSA: authorized to operate'; }
  else if (st === 'pending_authority') { rel = 12; relWhy = 'FMCSA: authority application pending (about to start hauling)'; }
  else if (st === 'active_usdot') { rel = 13; relWhy = 'FMCSA: active for-hire USDOT registration'; }
  else if (st === 'operational') { rel = 11; relWhy = 'Google listing: operational'; }
  else if (post) { rel = 6; relWhy = 'community post, business not yet verified'; }
  const allowed = settings.allowed_outreach_countries || ['US'];
  if (company.country && !allowed.includes(company.country)) { rel = Math.min(rel, 3); relWhy += `; country ${company.country} not in allowed outreach markets`; }
  parts.push({ part: 'Business relevance', points: rel, of: 15, why: relWhy });

  const best = bestContact(contacts);
  let cq = 0;
  let cqWhy = 'no business email found';
  if (best) { cq = best.is_role ? 10 : 15; cqWhy = `${best.contact_type} email ${best.is_role ? '(role address)' : ''} from ${best.source}`.replace('  ', ' '); }
  else if (company.phone) { cq = 4; cqWhy = 'phone only'; }
  parts.push({ part: 'Contact quality', points: cq, of: 15, why: cqWhy });

  const fr = Math.round(fresh.score * 0.1);
  parts.push({ part: 'Data freshness', points: fr, of: 10, why: `freshness ${fresh.score}/100` });

  const dlv = { verified: 10, likely_valid: 7, risky: 3, unknown: 3 }[best?.verification_status] || 0;
  parts.push({ part: 'Deliverability confidence', points: dlv, of: 10, why: best ? `best email is ${best.verification_status}` : 'no usable email' });

  if (learned && learned.points) parts.push({ part: 'Learned from outcomes', points: learned.points, of: 8, why: learned.why });
  return { score: Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.points, 0))), parts, best };
}

// Is this business eligible for outreach right now? Deterministic, never decided by AI.
export function eligibility(company, contacts, settings = getSettings()) {
  const reasons = [];
  if (company.duplicate_of) reasons.push('duplicate record');
  if (['do_not_contact', 'not_interested', 'client', 'disqualified'].includes(company.stage)) reasons.push(`stage: ${company.stage.replace(/_/g, ' ')}`);
  if (['closed', 'not_authorized', 'inactive_usdot'].includes(company.operating_status)) reasons.push(`operating status: ${company.operating_status.replace(/_/g, ' ')}`);
  if (company.country && !(settings.allowed_outreach_countries || ['US']).includes(company.country) && !company.lawful_basis) reasons.push(`country ${company.country} not allowed and no lawful basis recorded`);
  const mailable = contacts.filter((x) => MAILABLE.includes(x.verification_status) && !x.duplicate_of);
  if (!mailable.length) reasons.push(contacts.length ? 'no mailable email (all invalid, suppressed, bounced or unchecked)' : 'no business email found');
  const repliedBefore = contacts.length && one('SELECT 1 FROM replies WHERE company_id = ? LIMIT 1', company.id);
  if (repliedBefore) reasons.push('already replied (handled in Reply Management, not by sequences)');
  return { eligible: !reasons.length, reasons };
}

// How sure we are that the record describes a real, reachable trucking business (separate from intent).
export function confidenceScore(company, contacts, sources) {
  const parts = [];
  const official = sources.some((s) => ['fmcsa_census', 'fmcsa_authority'].includes(s.source));
  parts.push({ part: 'Official registry record', points: official ? 40 : 0, of: 40, why: official ? 'present in FMCSA data' : 'not matched to an FMCSA record' });
  const kinds = new Set(sources.map((s) => s.source)).size;
  parts.push({ part: 'Independent sources', points: Math.min(20, (kinds - 1) * 10), of: 20, why: `${kinds} distinct source(s)` });
  const best = contacts.map((c) => ({ verified: 30, likely_valid: 22, risky: 10, unknown: 8 }[c.verification_status] || 0)).sort((a, b) => b - a)[0] || 0;
  parts.push({ part: 'Contact confidence', points: best, of: 30, why: best ? 'best email status' : 'no usable email' });
  const id = company.usdot_number || company.mc_number;
  parts.push({ part: 'Identifiers', points: id ? 10 : 0, of: 10, why: id ? `USDOT ${company.usdot_number || '—'} / MC ${company.mc_number || '—'}` : 'no USDOT/MC' });
  return { score: Math.min(100, parts.reduce((a, p) => a + p.points, 0)), parts };
}

function dispatchNeed(company, intent) {
  const b = intentBand(intent.score);
  const label = { very_high: 'Very high', high: 'High', medium: 'Medium', low: 'Low' }[b];
  const reasons = intent.signals.filter((s) => s.weight > 0).map((s) => s.label).slice(0, 3);
  return `${label}${reasons.length ? `: ${reasons.join('; ')}` : ''}`;
}

function ruleSummary(company, intent, score, best) {
  const eq = json(company.equipment_types, []);
  const bits = [
    `${company.name}${company.city ? ` (${company.city}, ${company.state})` : company.state ? ` (${company.state})` : ''}`,
    company.fleet_size ? `${company.fleet_size} power unit(s)` : null,
    eq.length ? `hauls ${eq.join('/')}` : null,
    company.authority_granted_at ? `registered with FMCSA ${company.authority_granted_at.slice(0, 10)}` : null,
  ].filter(Boolean);
  return `${bits.join(', ')}. Intent ${intent.score}/100: ${intent.summary} Lead score ${score.score}/100. `
    + (best ? `Best contact: ${best.email} (${best.verification_status}).` : 'No usable email yet.');
}

async function aiSummary(company, intent, score, best, fallback) {
  if (!llmEnabled()) return fallback;
  try {
    const r = await llmJson(
      'You are the Qualification Agent for a truck dispatching service. Write a 2-3 sentence plain-English qualification summary for the sales team using ONLY the given facts. Do not invent anything. Return {"summary": string}.',
      { company: { name: company.name, city: company.city, state: company.state, fleet_size: company.fleet_size, equipment: json(company.equipment_types, []), operating_status: company.operating_status, registered: company.authority_granted_at },
        intent: { score: intent.score, summary: intent.summary, signals: intent.signals }, lead_score: score.score, score_breakdown: score.parts, best_contact: best ? { email: best.email, status: best.verification_status } : null },
      { maxTokens: 300 },
    );
    return String(r.summary || fallback).slice(0, 800);
  } catch {
    return fallback;
  }
}

export async function qualifyCompany(id) {
  const c = one('SELECT * FROM companies WHERE id = ?', id);
  if (!c || c.duplicate_of) return null;
  const settings = getSettings();
  const contacts = all('SELECT * FROM contacts WHERE company_id = ?', id);
  const sources = all('SELECT * FROM lead_sources WHERE company_id = ? ORDER BY discovered_at DESC', id);
  const census = sources.find((s) => s.source === 'fmcsa_census');
  const authSrc = sources.find((s) => s.source === 'fmcsa_authority');
  const lead = { ...c, equipment_types: json(c.equipment_types, []), authority_event: json(c.authority_event, null), fleet_history: json(c.fleet_history, []),
    source_url: census?.source_url || null, authority_source_url: authSrc?.source_url || null, fleet_source: census || authSrc ? 'FMCSA census' : 'public listing' };
  const docs = sources.filter((s) => s.title || s.snippet).map((s) => ({
    url: s.source_url, text: [s.title, s.snippet].filter(Boolean).join('\n'), published_at: s.published_at,
    is_post: s.source === 'reddit' || (c.prospect_category === 'Community Post' && s.source !== 'website'),
    // Registry rows (FMCSA) are structured data, not text anyone wrote, so they never need an AI intent read.
    free_text: !['fmcsa_census', 'fmcsa_authority'].includes(s.source),
  }));
  const intent = await detectIntent(lead, docs);
  const fresh = freshnessScore(c, contacts, sources);
  const learned = learnedAdjustment(leadTraits({ ...c, intent_signals: JSON.stringify(intent.signals) }, sources));
  const score = leadScore(c, intent, fresh, contacts, settings, learned);
  const elig = eligibility(c, contacts, settings);
  const confidence = confidenceScore(c, contacts, sources);
  const summary = await aiSummary(c, intent, score, score.best, ruleSummary(c, intent, score, score.best));

  let stage = c.stage;
  if (['new', 'qualified', 'disqualified'].includes(c.stage)) {
    if (intent.is_provider || ['closed', 'not_authorized', 'inactive_usdot'].includes(c.operating_status)) stage = 'disqualified';
    else stage = score.score >= settings.min_lead_score_to_enroll ? 'qualified' : 'new';
  }
  run(
    `UPDATE companies SET intent_score = ?, intent_signals = ?, intent_summary = ?, intent_method = ?, dispatch_need = ?,
       lead_score = ?, lead_score_breakdown = ?, qualification_summary = ?, freshness_score = ?, stage = ?, priority = ?, confidence_score = ?, eligibility = ?, intent_hash = ?,
       last_verified_at = COALESCE(?, last_verified_at), updated_at = ? WHERE id = ?`,
    intent.score, JSON.stringify(intent.signals), intent.summary, intent.method, dispatchNeed(c, intent),
    score.score, JSON.stringify({ lead: score.parts, freshness: fresh.parts, confidence: confidence.parts }), summary, fresh.score, stage, priorityOf(score.score), confidence.score, JSON.stringify(elig), null,
    contacts.map((x) => x.verified_at).filter(Boolean).sort().pop() || null, nowIso(), id,
  );
  enqueue('lead.research', { companyId: id }, { dedupeKey: `research:${id}` });
  return { id, intent: intent.score, lead: score.score, freshness: fresh.score, stage, priority: priorityOf(score.score) };
}
