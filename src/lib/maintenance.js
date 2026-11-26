import fs from 'node:fs';
import path from 'node:path';
import { db, dbFile, run, nowIso } from '../db/index.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';

// Daily housekeeping: consistent database backup, and deletion of data past its retention period.
// Business records (leads, contacts, messages, replies, suppressions) are never deleted automatically;
// the suppression list in particular must be kept forever so opted-out people are never emailed again.

export function backupDatabase(keep) {
  if (!dbFile || dbFile === ':memory:') return null;
  const dir = path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `leads-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  // VACUUM INTO writes a consistent snapshot while the app keeps running.
  db.prepare('VACUUM INTO ?').run(file);
  const old = fs.readdirSync(dir).filter((f) => /^leads-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return { file: path.basename(file), removed: old.length };
}

export function dailyMaintenance() {
  const s = getSettings();
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const deleted = {
    jobs: run(`DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < ?`, ago(s.retention_job_days)).changes,
    audit: run('DELETE FROM audit_log WHERE created_at < ?', ago(s.retention_audit_days)).changes,
    sessions: run('DELETE FROM sessions WHERE expires_at < ?', nowIso()).changes,
    snapshots: run('DELETE FROM analytics_snapshots WHERE created_at < ?', ago(90)).changes,
    notifications: run('DELETE FROM notifications WHERE is_read = 1 AND created_at < ?', ago(90)).changes,
  };
  const backup = backupDatabase(Math.max(1, s.backup_keep));
  audit('maintenance', 'maintenance.daily', null, null, { deleted, backup: backup?.file || null });
  return { deleted, backup };
}
