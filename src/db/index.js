import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export let db = null;

export const nowIso = () => new Date().toISOString();

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  dbFile = file;
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    // Table rebuilds (SQLite cannot alter CHECK constraints) need foreign keys off; the pragma
    // is ignored inside a transaction, so it is switched around it and integrity is checked before commit.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(() => {
        db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration ${f} broke ${broken.length} foreign key reference(s)`);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, nowIso());
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export let dbFile = null;

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export const json = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};
