import crypto from 'node:crypto';
import { one, all, run, nowIso, json } from '../db/index.js';
import { getSettings } from '../lib/settings.js';
import { llmEnabled, llmJson, noteCacheHit } from '../lib/llm.js';
import { daysAgo } from '../lib/text.js';

// Business Research Agent: before any email is written, builds a short evidence-backed brief on the
// business. Every line is derived from stored records; missing facts are listed as unknown, never guessed.
// The optional AI pass only rephrases these facts and is skipped when the facts have not changed.

export function researchFacts(company, contacts, sources) {
  const eq = json(company.equipment_types, []);
  const ev = json(company.authority_event, null);
  const facts = [];
  const unknown = [];
  const cite = (s) => s?.source_url || null;
  const census = sources.find((s) => s.source === 'fmcsa_census');
  const authSrc = sources.find((s) => s.source === 'fmcsa_authority');
  const site = sources.find((s) => s.source === 'website');

  const type = company.prospect_category === 'Community Post' ? 'Individual posting in a trucking community'
    : company.fleet_size === 1 ? 'Owner-operator (1 power unit)'
      : company.fleet_size ? `Small carrier (${company.fleet_size} power units)` : company.prospect_category;
  if (type) facts.push({ topic: 'Business type', fact: type, source: cite(census) });
  else unknown.push('business type / fleet size');

  if (eq.length) facts.push({ topic: 'Equipment', fact: `${eq.join(', ')} (inferred from cargo types filed with FMCSA)`, source: cite(census) });
  else unknown.push('equipment');

  if (company.city || company.state) facts.push({ topic: 'Location', fact: [company.city, company.state].filter(Boolean).join(', '), source: cite(census) });
  else unknown.push('location');
  if (company.operating_region) facts.push({ topic: 'Operating region', fact: company.operating_region, source: cite(census) });

  if (ev) facts.push({ topic: 'Authority', fact: `${ev.type === 'granted' ? 'Operating authority granted' : ev.type === 'applied' ? 'Applied for operating authority' : `Authority ${ev.status}`} on ${String(ev.at).slice(0, 10)} (${ev.docket || 'docket n/a'})`, source: cite(authSrc) });
  else if (company.authority_granted_at) facts.push({ topic: 'Registration', fact: `USDOT registered ${company.authority_granted_at.slice(0, 10)} (${Math.round(daysAgo(company.authority_granted_at))} days ago)`, source: cite(census) });
  if (company.operating_status) facts.push({ topic: 'Status', fact: company.operating_status.replace(/_/g, ' '), source: cite(authSrc || census) });

  if (company.website) facts.push({ topic: 'Website', fact: company.website, source: cite(site) });
  else unknown.push('company website');
  if (company.last_website_activity_at) facts.push({ topic: 'Recent activity', fact: company.last_website_activity_evidence, source: cite(site) });

  for (const s of json(company.intent_signals, [])) {
    if (s.weight > 0 && s.evidence && !['small_independent'].includes(s.signal)) facts.push({ topic: 'Dispatch-related signal', fact: `${s.label || s.signal}: "${s.evidence}"`, source: s.source_url || null });
  }
  if (!json(company.intent_signals, []).some((s) => ['seeking_dispatcher', 'needs_loads', 'low_rates', 'broker_paperwork_pain'].includes(s.signal))) {
    unknown.push('any stated dispatching problem (none found in public sources)');
  }
  const best = contacts.find((c) => ['verified', 'likely_valid'].includes(c.verification_status));
  if (best) facts.push({ topic: 'Contact', fact: `${best.email} (${best.verification_status.replace('_', ' ')}, ${best.ownership_evidence?.replace(/_/g, ' ') || best.source})`, source: best.source_url });
  else unknown.push('a confirmed business email');
  if (company.owner_name) facts.push({ topic: 'Decision-maker', fact: `${company.owner_name} (company officer on FMCSA filing)`, source: cite(census) });
  else unknown.push('decision-maker name');
  return { facts, unknown };
}

function relevance(company, facts) {
  const r = [];
  const ev = json(company.authority_event, null);
  if (ev?.type === 'applied') r.push('Preparing to start operating: has no broker relationships or load sources yet.');
  else if (ev?.type === 'granted' || daysAgo(company.authority_granted_at) <= 180) r.push('New authority: usually no broker setup packets, credit history or steady lanes yet.');
  if (company.fleet_size && company.fleet_size <= 3) r.push('Owner runs the truck(s) personally, so time spent on load boards and broker calls is time not driving.');
  if (facts.some((f) => f.topic === 'Dispatch-related signal' && /dispatcher|loads|rates|broker|paperwork/i.test(f.fact))) r.push('Has publicly described a problem a dispatcher solves.');
  return r;
}

export function buildBrief(company, contacts, sources) {
  const { facts, unknown } = researchFacts(company, contacts, sources);
  const why = relevance(company, facts);
  const lines = [
    ...facts.map((f) => `- ${f.topic}: ${f.fact}`),
    why.length ? `Why our service may fit:\n${why.map((w) => `- ${w}`).join('\n')}` : 'Why our service may fit: no specific evidence beyond being a small carrier.',
    unknown.length ? `Not known (do not assume): ${unknown.join('; ')}.` : '',
  ].filter(Boolean);
  return { text: lines.join('\n'), facts, unknown, why };
}

export async function researchCompany(id) {
  const c = one('SELECT * FROM companies WHERE id = ?', id);
  if (!c || c.duplicate_of) return null;
  const contacts = all('SELECT * FROM contacts WHERE company_id = ?', id);
  const sources = all('SELECT source, source_url, published_at FROM lead_sources WHERE company_id = ?', id);
  const brief = buildBrief(c, contacts, sources);
  const hash = crypto.createHash('sha256').update(brief.text).digest('hex').slice(0, 16);
  if (hash === c.research_hash) { noteCacheHit('research'); return { id, cached: true }; }
  let text = brief.text;
  if (llmEnabled() && getSettings().ai_research_summaries) {
    try {
      const ai = await llmJson(
        `You are the Business Research Agent for a small US truck dispatching service. Rewrite the research notes below into a 3-5 sentence internal brief for the person writing outreach.
Use ONLY the facts given. Keep every "Not known" item explicitly as unknown. Do not speculate about revenue, lanes, customers or problems that are not listed.
Return {"brief": string}.`,
        { notes: brief.text }, { agent: 'research', maxTokens: 350 },
      );
      if (ai?.brief && String(ai.brief).length > 40) text = `${String(ai.brief).trim()}\n\nSource notes:\n${brief.text}`;
    } catch { /* keep deterministic brief */ }
  }
  run('UPDATE companies SET research_summary = ?, research_hash = ?, researched_at = ? WHERE id = ?', text, hash, nowIso(), id);
  return { id, cached: false };
}
