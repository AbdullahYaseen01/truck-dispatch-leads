import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { all, run, nowIso } from '../db/index.js';
import { runtime } from '../lib/runtime.js';
import { decrypt } from '../lib/crypto.js';
import { log, notify } from '../lib/audit.js';
import { ingestInbound, recordBounce } from '../agents/replies.js';

// Reads replies and bounce notifications (DSNs) from each sending account's IMAP inbox.

function imapClient(account) {
  if (runtime.imapClientFactory) return runtime.imapClientFactory(account);
  return new ImapFlow({
    host: account.imap_host, port: account.imap_port || 993, secure: !!account.imap_secure,
    auth: { user: account.imap_user || account.smtp_user, pass: decrypt(account.imap_pass_enc || account.smtp_pass_enc) },
    logger: false,
  });
}

// Bounce detection: delivery status notifications from MAILER-DAEMON/postmaster or multipart/report.
export function parseBounce(parsed, raw) {
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
  const ctype = String(parsed.headers?.get('content-type')?.value || '');
  const isDsn = /mailer-daemon|postmaster/.test(from) || /report/i.test(ctype) && /delivery-status/i.test(raw)
    || /^(undeliverable|delivery status notification|mail delivery failed|returned mail)/i.test(parsed.subject || '');
  if (!isDsn) return null;
  const status = raw.match(/^Status:\s*([245]\.\d+\.\d+)/mi)?.[1];
  if (status && !status.startsWith('5')) return { soft: true };
  const recipient = raw.match(/^Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/mi)?.[1]
    || raw.match(/^Original-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/mi)?.[1];
  const originalMessageId = raw.match(/^Message-ID:\s*(<[^>]+>)/gmi)?.map((l) => l.match(/<[^>]+>/)[0]).find((id) => id !== parsed.messageId) || null;
  const diag = raw.match(/^Diagnostic-Code:\s*(.+)$/mi)?.[1] || status || 'hard bounce';
  return { recipient: recipient?.toLowerCase(), originalMessageId, detail: diag };
}

export async function handleRawMessage(source) {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const parsed = await simpleParser(source);
  const bounce = parseBounce(parsed, raw);
  if (bounce) {
    if (bounce.soft) return { type: 'soft_bounce' };
    const id = recordBounce(bounce);
    return { type: 'bounce', messageId: id };
  }
  const refs = parsed.references ? [].concat(parsed.references) : [];
  const autoSubmitted = /auto-(replied|generated)/i.test(String(parsed.headers.get('auto-submitted') || ''))
    || !!parsed.headers.get('x-autoreply') || /^(auto|automatic) ?reply|out of (the )?office/i.test(parsed.subject || '');
  const id = ingestInbound({
    fromEmail: parsed.from?.value?.[0]?.address || '', subject: parsed.subject || '', text: parsed.text || '',
    messageId: parsed.messageId || null, inReplyTo: parsed.inReplyTo || null, references: refs,
    date: parsed.date ? parsed.date.toISOString() : null, autoSubmitted,
  });
  return { type: id ? 'reply' : 'ignored', replyId: id };
}

export async function pollInbox(account) {
  const client = imapClient(account);
  let lastUid = account.imap_last_uid || 0;
  const result = { fetched: 0, replies: 0, bounces: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // First connection: start from now instead of importing the whole mailbox history.
      if (!lastUid) {
        lastUid = Math.max(0, (client.mailbox?.uidNext || 1) - 1);
      } else {
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= lastUid) continue;
          result.fetched++;
          try {
            const r = await handleRawMessage(msg.source);
            if (r.type === 'reply') result.replies++;
            if (r.type === 'bounce') result.bounces++;
          } catch (e) { log.warn(`failed to process inbound uid ${msg.uid}: ${e.message}`); }
          lastUid = Math.max(lastUid, msg.uid);
        }
      }
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
  run('UPDATE sending_accounts SET imap_last_uid = ?, last_checked_at = ? WHERE id = ?', lastUid, nowIso(), account.id);
  return result;
}

export async function pollAllInboxes() {
  const out = {};
  for (const a of all(`SELECT * FROM sending_accounts WHERE enabled = 1 AND imap_host IS NOT NULL AND imap_host != ''`)) {
    try { out[a.from_email] = await pollInbox(a); } catch (e) {
      out[a.from_email] = { error: e.message };
      run('UPDATE sending_accounts SET last_error = ?, last_checked_at = ? WHERE id = ?', `IMAP: ${e.message}`.slice(0, 300), nowIso(), a.id);
      notify('warning', `Cannot read inbox for ${a.from_email}`, e.message.slice(0, 300), 'sending_account', a.id);
    }
  }
  return out;
}
