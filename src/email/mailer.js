import crypto from 'node:crypto';
import { runtime } from '../lib/runtime.js';
import { decrypt, unsubscribeToken } from '../lib/crypto.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { complianceFooter } from '../agents/personalization.js';

const transports = new Map();

export function transportFor(account) {
  const key = `${account.id}:${account.updated_at}`;
  if (!transports.has(key)) {
    for (const k of transports.keys()) if (k.startsWith(`${account.id}:`)) transports.delete(k);
    transports.set(key, runtime.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: !!account.smtp_secure,
      auth: { user: account.smtp_user, pass: decrypt(account.smtp_pass_enc) },
      pool: false,
      connectionTimeout: 20000,
    }));
  }
  return transports.get(key);
}

export function newMessageId(fromEmail) {
  return `<${crypto.randomUUID()}@${String(fromEmail).split('@')[1] || 'localhost'}>`;
}

export function buildMail(message, account, settings = getSettings()) {
  const unsubUrl = `${config.publicBaseUrl}/u/${unsubscribeToken(message.to_email)}`;
  const replyTo = settings.reply_to_email || account.from_email;
  return {
    from: { name: account.from_name, address: account.from_email },
    to: message.to_email,
    replyTo,
    subject: message.subject,
    text: `${message.body_text}${complianceFooter(message.to_email, settings)}`,
    messageId: message.message_id_header,
    inReplyTo: message.in_reply_to || undefined,
    references: message.in_reply_to || undefined,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>, <mailto:${replyTo}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

// SMTP response codes that mean the recipient is permanently undeliverable.
export function isHardBounce(err) {
  const code = Number(err?.responseCode);
  return [550, 551, 553, 554].includes(code) && /recipient|mailbox|user|address|unknown|not exist|no such|invalid/i.test(String(err?.response || err?.message || ''));
}

export async function sendMail(account, mail) {
  return transportFor(account).sendMail(mail);
}

export async function verifyAccount(account) {
  await transportFor(account).verify();
  return true;
}
