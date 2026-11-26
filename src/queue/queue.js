import { one, run, all, nowIso, json } from '../db/index.js';
import { emit } from '../lib/events.js';
import { log } from '../lib/audit.js';

// Durable SQLite job queue. Agents hand work to each other by enqueuing jobs.
// Jobs survive restarts: anything left 'running' by a crash is re-queued on start.

const handlers = new Map();

export function registerHandler(type, fn, { maxAttempts = 4 } = {}) {
  handlers.set(type, { fn, maxAttempts });
}

export function enqueue(type, payload = {}, { dedupeKey = null, runAt = null, maxAttempts } = {}) {
  const now = nowIso();
  const res = run(
    `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, dedupe_key, created_at, updated_at)
     VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    type, JSON.stringify(payload), maxAttempts ?? handlers.get(type)?.maxAttempts ?? 4,
    runAt || now, dedupeKey, now, now,
  );
  if (res.changes) emit('job', { type, status: 'queued' });
  return res.changes ? Number(res.lastInsertRowid) : null;
}

export function recoverStaleJobs() {
  const r = run(`UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ? WHERE status = 'running'`, nowIso());
  return r.changes;
}

function claim() {
  const now = nowIso();
  const types = [...handlers.keys()];
  if (!types.length) return null;
  const job = one(
    `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? AND type IN (${types.map(() => '?').join(',')})
                 ORDER BY run_at, id LIMIT 1)
     RETURNING *`,
    now, now, now, ...types,
  );
  return job || null;
}

export async function runJob(job) {
  const h = handlers.get(job.type);
  try {
    const result = await h.fn(json(job.payload, {}), job);
    run(`UPDATE jobs SET status = 'done', result = ?, last_error = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(result ?? null), nowIso(), nowIso(), job.id);
    emit('job', { id: job.id, type: job.type, status: 'done' });
  } catch (e) {
    const permanent = e.permanent === true;
    const willRetry = !permanent && job.attempts < job.max_attempts;
    const delayS = Math.min(3600, 15 * 4 ** (job.attempts - 1));
    run(`UPDATE jobs SET status = ?, last_error = ?, run_at = ?, locked_at = NULL, updated_at = ?, finished_at = ? WHERE id = ?`,
      willRetry ? 'queued' : 'failed', String(e.message || e).slice(0, 1000),
      willRetry ? new Date(Date.now() + delayS * 1000).toISOString() : job.run_at,
      nowIso(), willRetry ? null : nowIso(), job.id);
    log.warn(`job ${job.id} ${job.type} failed (attempt ${job.attempts}/${job.max_attempts}): ${e.message}`);
    emit('job', { id: job.id, type: job.type, status: willRetry ? 'retrying' : 'failed' });
  }
}

export class Worker {
  constructor({ concurrency = 4, pollMs = 1000 } = {}) {
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    this.active = 0;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    recoverStaleJobs();
    this.timer = setInterval(() => this.pump(), this.pollMs);
    this.pump();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.active > 0) await new Promise((r) => setTimeout(r, 50));
  }

  pump() {
    while (!this.stopped && this.active < this.concurrency) {
      const job = claim();
      if (!job) return;
      this.active++;
      runJob(job).finally(() => { this.active--; this.pump(); });
    }
  }
}

// Run queued jobs until none are ready. Used by tests and the CLI to drain the pipeline.
export async function drain({ concurrency = 4, maxJobs = 10000 } = {}) {
  let count = 0;
  for (;;) {
    const batch = [];
    for (let i = 0; i < concurrency; i++) { const j = claim(); if (j) batch.push(j); }
    if (!batch.length) return count;
    await Promise.all(batch.map(runJob));
    count += batch.length;
    if (count >= maxJobs) return count;
  }
}

export function jobStats() {
  return all(`SELECT type, status, COUNT(*) n FROM jobs GROUP BY type, status ORDER BY type`);
}

export class PermanentError extends Error {
  constructor(msg) { super(msg); this.permanent = true; }
}
