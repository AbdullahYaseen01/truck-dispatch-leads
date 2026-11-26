import { config, llmConfigured } from '../config.js';
import { one, run } from '../db/index.js';
import { fetchJson } from './runtime.js';

// OpenAI-compatible chat completions client. Works with a local Ollama server (free, no key) or any
// provider's free tier. Every caller has a deterministic fallback, so the platform runs without AI too.
// Usage is counted per agent per day and capped (LLM_DAILY_LIMIT) to stay inside free quotas.

export const llmEnabled = () => llmConfigured();

const today = () => new Date().toISOString().slice(0, 10);

function bump(agent, col) {
  run(`INSERT INTO llm_usage (day, agent, ${col}) VALUES (?, ?, 1)
       ON CONFLICT(day, agent) DO UPDATE SET ${col} = ${col} + 1`, today(), agent);
}

export function llmBudgetLeft() {
  return Math.max(0, config.llm.dailyLimit - (one('SELECT COALESCE(SUM(calls), 0) n FROM llm_usage WHERE day = ?', today())?.n || 0));
}

// Returns the parsed JSON object, or null when AI is off or today's free budget is used up.
export async function llmJson(system, user, { temperature = 0.3, maxTokens = 900, agent = 'general' } = {}) {
  if (!llmEnabled() || llmBudgetLeft() <= 0) return null;
  bump(agent, 'calls');
  const body = {
    model: config.llm.model,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${system}\nRespond with a single JSON object only.` },
      { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user, null, 2) },
    ],
  };
  try {
    const res = await fetchJson(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.llm.apiKey ? { authorization: `Bearer ${config.llm.apiKey}` } : {}) },
      body: JSON.stringify(body),
    }, { retries: 2, timeoutMs: config.llm.timeoutMs });
    const text = res?.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM returned no JSON object');
    return JSON.parse(m[0]);
  } catch (e) {
    bump(agent, 'failures');
    throw e;
  }
}

export function noteCacheHit(agent) {
  bump(agent, 'cache_hits');
}
