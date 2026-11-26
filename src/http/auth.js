import { one, run, nowIso } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/crypto.js';
import { HttpError } from './router.js';

const SESSION_DAYS = 14;
const attempts = new Map(); // ip -> { n, until }

export function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

export function createUser({ email, name, password, role = 'admin' }) {
  if (!email || !password || password.length < 10) throw new HttpError(400, 'Email and a password of at least 10 characters are required');
  if (!['admin', 'viewer'].includes(role)) throw new HttpError(400, 'Invalid role');
  const r = run('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    String(email).toLowerCase().trim(), name || email, hashPassword(password), role, nowIso());
  return Number(r.lastInsertRowid);
}

export function login(req, email, password) {
  const ip = req.socket.remoteAddress || 'unknown';
  const a = attempts.get(ip);
  if (a && a.n >= 8 && a.until > Date.now()) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
  const user = one('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    attempts.set(ip, { n: (a?.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 15 * 60000 });
    throw new HttpError(401, 'Invalid email or password');
  }
  attempts.delete(ip);
  const token = randomToken();
  run('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', sha256(token), user.id,
    new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), nowIso());
  return { token, user };
}

export function sessionCookie(token, maxAgeS = SESSION_DAYS * 86400) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${config.secureCookies ? '; Secure' : ''}`;
}

export function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = one(`SELECT u.id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sha256(token));
  if (!s || s.expires_at < nowIso()) return null;
  return { id: s.id, email: s.email, name: s.name, role: s.role };
}

export function logout(req) {
  const token = parseCookies(req).sid;
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
}
