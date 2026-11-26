// Password encryption for data published on the public website: PBKDF2-SHA256 -> AES-256-GCM (Web Crypto),
// so the browser can decrypt it with the same password and nobody else can read it.
import { webcrypto as crypto } from 'node:crypto';

export const ITERATIONS = 310000;
const b64 = (buf) => Buffer.from(buf).toString('base64');

async function keyFor(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt, ITERATIONS);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function unseal(box, password) {
  const key = await keyFor(password, Buffer.from(box.salt, 'base64'), box.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64') }, key, Buffer.from(box.data, 'base64'));
  return JSON.parse(new TextDecoder().decode(plain));
}
