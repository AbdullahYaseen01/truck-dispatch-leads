import { llmEnabled, llmJson } from '../lib/llm.js';
import { evidenceSentences, daysAgo } from '../lib/text.js';

// Intent Detection Agent.
// Scores 0-100 how likely a prospect is to buy dispatching services, from evidence only.
// Each signal keeps the quote and URL it came from so the score is explainable.

export const INTENT_SIGNALS = [
  { key: 'seeking_dispatcher', weight: 45, label: 'Actively looking for a dispatcher',
    patterns: [/\b(looking for|need|needs|seeking|hiring|want)\b[^.]{0,30}\b(a |an |good |reliable )?(truck )?dispatch(er|ers|ing| service| services)\b/i, /\brecommend(ations?)?\b[^.]{0,30}\bdispatch(er|ing)\b/i] },
  { key: 'needs_loads', weight: 30, label: 'Needs help finding loads',
    patterns: [/\b(need|looking for|help|struggling)\b[^.]{0,30}\b(finding |find |more |steady |consistent )?loads\b/i, /\bcan'?t find (good )?loads\b/i] },
  { key: 'low_rates', weight: 20, label: 'Complains about poor load rates',
    patterns: [/\b(low|cheap|bad|terrible|poor|garbage)\b[^.]{0,20}\brates?\b/i, /\brates? (are|is) (so )?(low|bad|terrible|trash)\b/i, /\bbetter[- ]paying loads\b/i] },
  { key: 'broker_paperwork_pain', weight: 15, label: 'Struggles with brokers or paperwork',
    patterns: [/\b(broker|brokers)\b[^.]{0,40}\b(won'?t|don'?t|never|ghost|hard|difficult|problem|issue)/i, /\b(paperwork|invoic\w+|rate con\w*|factoring)\b[^.]{0,40}\b(overwhelm\w*|hard|hate|too much|struggl\w+|behind)\b/i] },
  { key: 'new_authority', weight: 20, label: 'Recently started a trucking company',
    patterns: [/\b(new|just got( my)?|recently (got|received|activated))\b[^.]{0,15}\b(authority|mc number|mc#?|usdot)\b/i, /\bjust (started|launched) (my|our) (own )?trucking\b/i] },
  { key: 'recruiting_dispatch', weight: 25, label: 'Recruiting dispatch support',
    patterns: [/\b(hiring|now hiring|job|position)\b[^.]{0,20}\bdispatcher\b/i] },
];

const NEGATIVE = [/\b(we are|we're|i am|i'm) (a )?(truck )?dispatch(er|ing company|ing service)\b/i, /\bdispatch services? for (owner|carriers|truckers)\b/i, /\bwe (help|offer)\b[^.]{0,30}\bdispatch/i];

// New business evidence: an FMCSA authority grant/application (strongest), or a recent USDOT registration.
function newAuthoritySignal(lead) {
  const cands = [];
  const ev = lead.authority_event;
  const evDays = daysAgo(ev?.at);
  if (ev && Number.isFinite(evDays) && evDays <= 365 && ['granted', 'applied'].includes(ev.type)) {
    const granted = ev.type === 'granted';
    cands.push({
      signal: 'new_authority',
      label: granted ? `Operating authority granted ${Math.round(evDays)} days ago` : `Applied for operating authority ${Math.round(evDays)} days ago (preparing to operate)`,
      weight: granted ? (evDays <= 30 ? 35 : evDays <= 90 ? 25 : 12) : (evDays <= 60 ? 30 : 15),
      evidence: `FMCSA operating authority ${granted ? 'granted' : 'application filed'} ${ev.at.slice(0, 10)}${ev.docket ? ` (docket ${ev.docket})` : ''}`,
      source_url: lead.authority_source_url || null,
    });
  }
  const days = daysAgo(lead.authority_granted_at);
  if (Number.isFinite(days) && days <= 365) {
    cands.push({
      signal: 'new_authority', label: `USDOT registered ${Math.round(days)} days ago`, weight: days <= 60 ? 30 : days <= 180 ? 22 : 12,
      evidence: `FMCSA census add date ${lead.authority_granted_at.slice(0, 10)}`, source_url: lead.source_url || null,
    });
  }
  return cands.sort((a, b) => b.weight - a.weight)[0] || null;
}

function expansionSignal(lead) {
  const grow = (lead.fleet_history || []).filter((h) => h.to > h.from && daysAgo(h.at) <= 365).pop();
  if (!grow) return null;
  return { signal: 'fleet_expansion', label: `Fleet grew from ${grow.from} to ${grow.to} power units`, weight: 10,
    evidence: `FMCSA census power units changed on ${String(grow.at).slice(0, 10)}`, source_url: null };
}

export const STRUCTURAL_SIGNALS = ['new_authority', 'small_independent', 'fleet_expansion'];

function smallFleetSignal(lead) {
  if (!lead.fleet_size || lead.fleet_size > 5) return null;
  return {
    signal: 'small_independent', label: `Small fleet (${lead.fleet_size} power unit${lead.fleet_size > 1 ? 's' : ''}), likely self-dispatching`,
    weight: lead.fleet_size <= 2 ? 12 : 8, evidence: `Fleet size ${lead.fleet_size} from ${lead.fleet_source || 'public record'}`, source_url: null,
  };
}

// Rule engine: deterministic and always available. Requires a matching sentence per text signal.
export function ruleIntent(lead, docs) {
  const signals = [];
  const allText = docs.map((d) => d.text).join('\n');
  const isProvider = NEGATIVE.some((p) => p.test(allText)) && !docs.some((d) => d.is_post);
  for (const s of INTENT_SIGNALS) {
    for (const d of docs) {
      const ev = evidenceSentences(d.text, s.patterns, 1)[0];
      if (ev) {
        // Older posts count less: intent decays after ~60 days.
        const age = daysAgo(d.published_at);
        const decay = Number.isFinite(age) ? (age <= 30 ? 1 : age <= 90 ? 0.7 : 0.4) : 0.8;
        signals.push({ signal: s.key, label: s.label, weight: Math.round(s.weight * decay), evidence: ev.slice(0, 280), source_url: d.url || null });
        break;
      }
    }
  }
  const na = newAuthoritySignal(lead);
  if (na && !signals.some((s) => s.signal === 'new_authority')) signals.push(na);
  const sf = smallFleetSignal(lead);
  if (sf) signals.push(sf);
  const fx = expansionSignal(lead);
  if (fx) signals.push(fx);
  if (!signals.length) signals.push({ signal: 'none', label: 'No buying-intent evidence found', weight: 0, evidence: 'Only generic trucking activity', source_url: null });

  let score = Math.min(100, signals.reduce((a, s) => a + s.weight, 0));
  if (isProvider) score = Math.min(score, 5);
  const summary = isProvider
    ? 'Appears to be a dispatch service provider itself, not a prospect.'
    : signals.filter((s) => s.weight > 0).map((s) => s.label).join('; ') || 'No buying-intent evidence found.';
  return { score, signals, summary, method: 'rules', is_provider: isProvider };
}

export function intentBand(score) {
  if (score >= 90) return 'very_high';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

// AI pass: re-reads the evidence to separate real buying intent from generic trucking talk
// (e.g. "I AM a dispatcher" or a joke). It may only cite quotes that exist in the documents.
export async function detectIntent(lead, docs) {
  const rules = ruleIntent(lead, docs);
  // Only free text written by or about the business can carry intent; registry rows never need an AI call.
  if (!llmEnabled() || !docs.some((d) => d.free_text && d.text?.trim())) return rules;
  try {
    const ai = await llmJson(
      `You are the Intent Detection Agent for a US truck dispatching service. Decide how likely this prospect is to BUY dispatching services.
Real buying intent: asking for a dispatcher, needing loads, complaining about rates, broker/paperwork pain, brand-new authority, independent with no dispatcher.
NOT intent: companies that sell dispatching, freight brokers, job seekers wanting to BE dispatchers, generic trucking news.
Only use quotes that appear verbatim in the documents. Score 0-100 (90+ very high, 70-89 high, 40-69 medium, <40 low).
Return {"score": int, "is_dispatch_provider": bool, "signals":[{"signal": string, "evidence": exact quote, "source_url": string|null, "weight": int}], "summary": string}`,
      { lead: { name: lead.name, category: lead.prospect_category, fleet_size: lead.fleet_size, authority_granted_at: lead.authority_granted_at },
        rule_signals: rules.signals, documents: docs.filter((d) => d.free_text).map((d) => ({ url: d.url, published_at: d.published_at, text: d.text.slice(0, 3500) })) },
      { agent: 'intent' },
    );
    if (!ai) return rules;
    const corpus = docs.map((d) => d.text).join('\n').toLowerCase();
    // Drop any AI quote that is not actually present in the sources.
    const aiSignals = (ai.signals || []).filter((s) => s.evidence && corpus.includes(String(s.evidence).toLowerCase().slice(0, 60)));
    const structural = rules.signals.filter((s) => STRUCTURAL_SIGNALS.includes(s.signal));
    const signals = [...aiSignals.map((s) => ({ ...s, label: s.signal, weight: Number(s.weight) || 0 })), ...structural];
    let score = Math.max(0, Math.min(100, Math.round(Number(ai.score))));
    if (!Number.isFinite(score)) return rules;
    if (ai.is_dispatch_provider) score = Math.min(score, 5);
    // Without verifiable quotes the AI cannot score far above the rule engine.
    if (!aiSignals.length) score = Math.min(score, rules.score + 10);
    return { score, signals: signals.length ? signals : rules.signals, summary: String(ai.summary || rules.summary).slice(0, 600), method: 'ai+rules', is_provider: !!ai.is_dispatch_provider };
  } catch {
    return rules;
  }
}
