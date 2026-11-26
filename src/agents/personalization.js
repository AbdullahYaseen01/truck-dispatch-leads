import { json } from '../db/index.js';
import { getSettings } from '../lib/settings.js';
import { llmEnabled, llmJson } from '../lib/llm.js';
import { daysAgo } from '../lib/text.js';
import { unsubscribeToken } from '../lib/crypto.js';
import { config } from '../config.js';

// Personalization Agent. Builds a list of facts we can actually back up, then writes the email
// from those facts only. AI output is checked for invented claims; on failure the template is used.

export function firstName(fullName) {
  const f = String(fullName || '').trim().split(/\s+/)[0] || '';
  return f.length > 1 ? f[0].toUpperCase() + f.slice(1).toLowerCase() : '';
}

export function prospectFacts(company, contact) {
  const facts = [];
  const eq = json(company.equipment_types, []);
  facts.push({ key: 'company', value: company.name });
  if (contact?.name || (contact?.contact_type === 'owner' && company.owner_name)) facts.push({ key: 'contact_name', value: contact.name || company.owner_name });
  if (company.city && company.state) facts.push({ key: 'location', value: `${company.city}, ${company.state}` });
  else if (company.state) facts.push({ key: 'location', value: company.state });
  if (eq.length) facts.push({ key: 'equipment', value: eq.join(', ') });
  if (company.fleet_size) facts.push({ key: 'fleet_size', value: `${company.fleet_size} truck${company.fleet_size > 1 ? 's' : ''}` });
  const age = daysAgo(company.authority_granted_at);
  if (age <= 365) facts.push({ key: 'new_authority', value: `registered with FMCSA ${age < 7 ? 'this week' : age < 56 ? `about ${Math.round(age / 7)} week${Math.round(age / 7) > 1 ? 's' : ''} ago` : `about ${Math.round(age / 30)} months ago`}` });
  for (const s of json(company.intent_signals, [])) {
    if (s.weight > 0 && s.evidence && s.source_url && !['new_authority', 'small_independent'].includes(s.signal)) {
      facts.push({ key: 'public_need', value: s.label || s.signal, evidence: s.evidence, source_url: s.source_url });
    }
  }
  return facts;
}

function render(tpl, vars) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

export function templateVars(company, contact, settings = getSettings()) {
  const eq = json(company.equipment_types, []);
  const fn = firstName(contact?.name || (contact?.contact_type === 'owner' ? company.owner_name : ''));
  const age = daysAgo(company.authority_granted_at);
  const need = json(company.intent_signals, []).find((s) => ['seeking_dispatcher', 'needs_loads', 'low_rates', 'broker_paperwork_pain'].includes(s.signal) && s.weight > 0);
  const needLine = {
    seeking_dispatcher: 'I saw you were looking for dispatch help, so I wanted to reach out.',
    needs_loads: 'I saw you mentioned looking for more consistent loads.',
    low_rates: 'I saw you mentioned rates have been tough lately.',
    broker_paperwork_pain: 'I saw you mentioned the broker calls and paperwork can pile up.',
  }[need?.signal] || '';
  return {
    first_name: fn,
    greeting: fn ? `Hi ${fn},` : 'Hi there,',
    company: company.name,
    city: company.city || '',
    state: company.state || '',
    location: company.city && company.state ? `${company.city}, ${company.state}` : company.state || 'your area',
    equipment: eq.length ? eq[0].toLowerCase() : 'truck',
    fleet_phrase: company.fleet_size ? (company.fleet_size === 1 ? 'one truck' : `${company.fleet_size} trucks`) : 'your trucks',
    authority_line: age <= 365 ? 'Congrats on getting your authority set up.' : '',
    intent_line: needLine,
    sender_name: settings.sender_person_name,
    sender_company: settings.sender_company_name,
    calendly_line: settings.calendly_url ? `If it's easier, you can pick a time here: ${settings.calendly_url}` : '',
    calendly_url: settings.calendly_url || '',
    services: settings.services_description,
    pricing: settings.pricing_enabled && settings.pricing_text ? settings.pricing_text : '',
  };
}

// CAN-SPAM footer: sender identity, physical postal address, working unsubscribe.
export function complianceFooter(email, settings = getSettings()) {
  const link = `${config.publicBaseUrl}/u/${unsubscribeToken(email)}`;
  return `\n\n--\n${settings.sender_person_name}\n${settings.sender_company_name}\n${settings.postal_address}\n\n`
    + `You received this because your business contact details are publicly listed. If you'd rather not hear from us, reply "unsubscribe" or use this link: ${link}`;
}

const BANNED = [/guarantee/i, /\b\d+(\.\d+)?\s?%/, /\btestimonial/i, /\bour clients (say|love)/i, /\bwe('ve| have) worked with\b/i, /\b(top|best|#1|number one) (dispatch|dispatcher)/i, /\$\s?\d/, /\bact now\b/i, /\blimited time\b/i];

export function checkGenerated(text, facts, settings) {
  const problems = [];
  for (const b of BANNED) {
    if (b.test(text) && !(settings.pricing_enabled && settings.pricing_text && text.includes(settings.pricing_text))) problems.push(`contains ${b}`);
  }
  for (const url of text.match(/https?:\/\/\S+/g) || []) {
    if (!settings.calendly_url || !url.startsWith(settings.calendly_url)) problems.push(`unapproved link ${url}`);
  }
  const words = text.split(/\s+/).length;
  if (words > 190) problems.push('too long');
  return problems;
}

// Subject lines are scored by fixed rules: truthful (no fake reply/forward, no hype), short, specific to the
// prospect, and different from earlier subjects in the same sequence. The best one is used; all are stored.
const SPAMMY = /\b(free|guarantee|urgent|act now|limited|\$\$|!!|100%|winner|cash)\b|!$/i;
export function scoreSubject(subject, vars, previous = []) {
  const s = String(subject || '').trim();
  const why = [];
  let score = 50;
  if (!s) return { subject: s, score: 0, why: ['empty'] };
  if (/^(re|fw|fwd):/i.test(s) && !previous.length) { score -= 60; why.push('implies an earlier conversation that did not happen'); }
  if (SPAMMY.test(s)) { score -= 40; why.push('spam-trigger wording'); }
  if (s.length > 60) { score -= 15; why.push('too long'); } else if (s.length <= 45) { score += 10; why.push('short'); }
  if (vars.company && s.toLowerCase().includes(String(vars.company).toLowerCase())) { score += 15; why.push('names the business'); }
  if (vars.equipment && vars.equipment !== 'truck' && s.toLowerCase().includes(vars.equipment)) { score += 10; why.push('mentions their equipment'); }
  if (/\bdispatch|loads?\b/i.test(s)) { score += 10; why.push('says what it is about'); }
  if (previous.some((p) => p.toLowerCase() === s.toLowerCase())) { score -= 30; why.push('repeats an earlier subject'); }
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) { score -= 20; why.push('all caps'); }
  return { subject: s, score, why };
}

const ALT_SUBJECTS = {
  intro: ['{{equipment}} loads for {{company}}', 'dispatch support for {{company}}', 'question about {{company}}\'s loads'],
  followup: ['following up: dispatch for {{company}}'],
  benefits: ['less time on load boards for {{company}}', 'broker calls and paperwork for {{company}}'],
  final: ['last note about dispatch help for {{company}}'],
};

export function bestSubject(candidates, vars, previous, preferred = null) {
  const scored = [...new Set(candidates.filter(Boolean))].map((c) => {
    const s = scoreSubject(c, vars, previous);
    // The subject written in your template wins unless it has a real problem.
    if (c === preferred) { s.score += 20; s.why.push('your template subject'); }
    return s;
  }).sort((a, b) => b.score - a.score);
  return { best: scored[0]?.subject || '', candidates: scored };
}

// Returns { subject, body, generated_by, facts, subject_candidates }. body excludes the compliance footer (added at send time).
export async function writeEmail({ company, contact, template, step, previousSubjects = [], settings = getSettings() }) {
  const vars = templateVars(company, contact, settings);
  const facts = prospectFacts(company, contact);
  const templateSubjects = [template.subject, ...(ALT_SUBJECTS[template.purpose] || [])].map((s) => render(s, vars));
  const ranked = bestSubject(templateSubjects, vars, previousSubjects, templateSubjects[0]);
  const fallback = { subject: ranked.best || render(template.subject, vars), body: render(template.body, vars), generated_by: 'template', facts, subject_candidates: ranked.candidates };
  if (!llmEnabled()) return fallback;
  try {
    const r = await llmJson(
      `You are the Personalization Agent for a small US truck dispatching service. Write ONE cold email (step ${step}) to a trucking business.
Rules: simple, friendly American English; 60-120 words; no hype or pressure; focus on the prospect's problems (finding good loads, negotiating rates, cutting deadhead, broker calls, paperwork, saving the owner time).
Use ONLY the facts provided. Never invent company details, past clients, results, numbers, testimonials, or guarantees. Do not mention a public post unless a "public_need" fact is given, and then refer to it gently.
No links except the Calendly URL if given. Sign with the sender name. Do NOT add an unsubscribe footer or address (added automatically).
Subject: short, specific, lowercase-friendly, no clickbait, under 60 characters${previousSubjects.length ? `, different from: ${previousSubjects.join(' | ')}` : ''}.
Give 3 different subject options.
Return {"subjects": [string, string, string], "body": string}.`,
      { facts, sender: { name: settings.sender_person_name, company: settings.sender_company_name }, our_services: settings.services_description,
        pricing: vars.pricing || null, calendly_url: settings.calendly_url || null, purpose: template.purpose,
        research_brief: company.research_summary || null,
        template_example: { subject: fallback.subject, body: fallback.body }, extra_guidance: template.ai_guidance || null },
      { temperature: 0.7, maxTokens: 650, agent: 'personalization' },
    );
    if (!r) return fallback;
    const body = String(r.body || '').trim();
    if (body.length < 40 || checkGenerated(body, facts, settings).length) return fallback;
    const aiSubjects = (Array.isArray(r.subjects) ? r.subjects : [r.subject]).map((s) => String(s || '').trim().slice(0, 120))
      .filter((s) => s && !checkGenerated(s, facts, settings).length);
    const ranked2 = bestSubject([...aiSubjects, ...templateSubjects], vars, previousSubjects);
    if (!ranked2.best) return fallback;
    return { subject: ranked2.best, body, generated_by: 'ai', facts, subject_candidates: ranked2.candidates };
  } catch {
    return fallback;
  }
}
