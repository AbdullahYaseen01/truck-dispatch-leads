import path from 'node:path';
import { config, assertProductionConfig } from './config.js';
import { openDb, closeDb, one } from './db/index.js';
import { log } from './lib/audit.js';
import { createUser } from './http/auth.js';
import { seedDefaults } from './agents/outreach.js';
import { startScheduler } from './agents/pipeline.js';
import { Worker } from './queue/queue.js';
import { createApp } from './app.js';

const problems = assertProductionConfig();
if (problems.length) {
  for (const p of problems) log.error(p);
  log.error('Copy .env.example to .env and fill it in. See README.md.');
  process.exit(1);
}

openDb(path.join(config.dataDir, 'leads.db'));
seedDefaults();

if (!one('SELECT 1 FROM users LIMIT 1')) {
  if (config.adminEmail && config.adminPassword) {
    createUser({ email: config.adminEmail, name: 'Administrator', password: config.adminPassword, role: 'admin' });
    log.info(`Created admin user ${config.adminEmail}`);
  } else {
    log.warn('No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, or run: npm run create-admin -- <email> <password>');
  }
}

// Background workers: each agent step is a durable job; unfinished jobs from a crash are re-queued here.
const worker = new Worker({ concurrency: config.workerConcurrency });
worker.start();
const scheduler = startScheduler();

const server = createApp();
server.listen(config.port, () => log.info(`Dashboard on ${config.publicBaseUrl} (port ${config.port})`));

async function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  clearInterval(scheduler);
  server.close();
  await worker.stop();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
