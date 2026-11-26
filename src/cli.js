import path from 'node:path';
import { config } from './config.js';
import { openDb, closeDb, one, run } from './db/index.js';
import { createUser } from './http/auth.js';
import { hashPassword } from './lib/crypto.js';

const [cmd, email, password, role = 'admin'] = process.argv.slice(2);
openDb(path.join(config.dataDir, 'leads.db'));

if (cmd === 'create-admin' || cmd === 'create-user') {
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password> [admin|viewer]');
    process.exit(1);
  }
  const existing = one('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) {
    if (password.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }
    run('UPDATE users SET password_hash = ?, role = ? WHERE id = ?', hashPassword(password), role, existing.id);
    console.log(`Updated password for ${email}`);
  } else {
    createUser({ email, name: email, password, role });
    console.log(`Created ${role} ${email}`);
  }
} else {
  console.error('Commands: create-admin <email> <password> [role]');
  process.exit(1);
}
closeDb();
