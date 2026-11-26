import { run, nowIso } from '../db/index.js';
import { emit } from './events.js';

const SECRET_KEYS = /pass|secret|token|key|authorization/i;

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : scrub(x)]));
  }
  return v;
}

export function audit(actor, action, entityType = null, entityId = null, detail = {}) {
  run(
    'INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    actor, action, entityType, entityId, JSON.stringify(scrub(detail)), nowIso(),
  );
  emit('audit', { actor, action, entityType, entityId });
}

export function notify(level, title, body = '', entityType = null, entityId = null) {
  run(
    'INSERT INTO notifications (level, title, body, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    level, title, body, entityType, entityId, nowIso(),
  );
  emit('notification', { level, title });
}

export const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', ...a.map(String)),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a.map(String)),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a.map(String)),
};
