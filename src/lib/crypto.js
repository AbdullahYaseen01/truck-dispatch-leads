import crypto from 'node:crypto';
import { config } from '../config.js';

function key(purpose) {
  if (!config.appSecret) throw new Error('APP_SECRET is not configured');
  return crypto.createHash('sha256').update(`${purpose}:${config.appSecret}`).digest();
}

// AES-256-GCM for SMTP/IMAP passwords at rest.
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key('enc'), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(token) {
  const [iv, tag, data] = String(token).split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key('enc'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Signed, non-expiring unsubscribe token for an email address.
export function unsubscribeToken(email) {
  const e = Buffer.from(String(email).toLowerCase()).toString('base64url');
  const sig = crypto.createHmac('sha256', key('unsub')).update(e).digest('base64url').slice(0, 22);
  return `${e}.${sig}`;
}

export function readUnsubscribeToken(token) {
  const [e, sig] = String(token || '').split('.');
  if (!e || !sig) return null;
  const expected = crypto.createHmac('sha256', key('unsub')).update(e).digest('base64url').slice(0, 22);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Buffer.from(e, 'base64url').toString('utf8');
}
