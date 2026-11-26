import { all } from '../db/index.js';
import { POSITIVE } from './constants.js';

// Performance learning: compares the positive-reply rate of leads that share a trait (source, intent
// signal, equipment, category) with the overall rate. Only groups with enough contacted leads count,
// and the resulting score adjustment is capped, so a handful of replies can never swing scores.

export const MIN_SAMPLE = 20;
const MAX_ADJ = 8;
const POS = POSITIVE.map((p) => `'${p}'`).join(',');
let cache = null;

// Wilson lower bound: a conservative estimate of a rate from a small sample.
export function wilsonLower(pos, n, z = 1.96) {
  if (!n) return 0;
  const p = pos / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

function outcomes() {
  // One row per contacted company with its traits and whether it ever replied positively.
  return all(`SELECT c.id, c.prospect_category, c.equipment_types, c.intent_signals,
      (SELECT GROUP_CONCAT(DISTINCT s.source) FROM lead_sources s WHERE s.company_id = c.id) sources,
      EXISTS (SELECT 1 FROM replies r WHERE r.company_id = c.id AND r.classification IN (${POS})) positive,
      c.stage = 'client' client
    FROM companies c WHERE c.duplicate_of IS NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.company_id = c.id AND m.kind = 'sequence' AND m.status IN ('sent','bounced'))`);
}

function traitsOf(row) {
  const t = [];
  for (const s of String(row.sources || '').split(',').filter(Boolean)) t.push(`source:${s}`);
  if (row.prospect_category) t.push(`category:${row.prospect_category}`);
  for (const e of JSON.parse(row.equipment_types || '[]')) t.push(`equipment:${e}`);
  for (const s of JSON.parse(row.intent_signals || '[]')) if (s.weight > 0) t.push(`signal:${s.signal}`);
  return t;
}

export function learnedRates({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 10 * 60000) return cache.value;
  const rows = outcomes();
  const total = rows.length;
  const pos = rows.filter((r) => r.positive || r.client).length;
  const base = total ? pos / total : 0;
  const groups = new Map();
  for (const r of rows) {
    for (const t of traitsOf(r)) {
      const g = groups.get(t) || { n: 0, pos: 0 };
      g.n++; if (r.positive || r.client) g.pos++;
      groups.set(t, g);
    }
  }
  const traits = {};
  for (const [k, g] of groups) {
    if (g.n < MIN_SAMPLE) continue;
    traits[k] = { n: g.n, positive: g.pos, rate: g.pos / g.n, lower: wilsonLower(g.pos, g.n) };
  }
  cache = { at: Date.now(), value: { total, positive: pos, base, traits } };
  return cache.value;
}

export function resetLearningCache() { cache = null; }

// Score adjustment for one lead from traits with reliable evidence. Returns { points, why }.
export function learnedAdjustment(traits, model = learnedRates()) {
  if (model.total < MIN_SAMPLE || !model.base) return { points: 0, why: `not enough outcome data yet (${model.total}/${MIN_SAMPLE} contacted leads)` };
  let best = null;
  for (const t of traits) {
    const g = model.traits[t];
    if (!g) continue;
    // Lift only when even the conservative estimate beats the average; penalty only when the rate is clearly below it.
    const lift = g.lower > model.base ? (g.lower - model.base) / model.base : g.rate < model.base / 2 ? -0.5 : 0;
    if (lift && (!best || Math.abs(lift) > Math.abs(best.lift))) best = { t, g, lift };
  }
  if (!best) return { points: 0, why: 'no trait with a statistically clear difference yet' };
  const points = Math.max(-MAX_ADJ, Math.min(MAX_ADJ, Math.round(best.lift * 6)));
  return { points, why: `${best.t.replace(':', ' ')}: ${best.g.positive}/${best.g.n} positive vs ${(model.base * 100).toFixed(1)}% average` };
}

export function leadTraits(company, sources) {
  return traitsOf({ ...company, sources: [...new Set(sources.map((s) => s.source))].join(',') });
}
