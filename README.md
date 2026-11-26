# DispatchLeads: trucking dispatch client acquisition platform

A self-hosted, multi-agent system that finds US owner-operators and small trucking companies that are likely to need a dispatcher. It verifies their published business emails, scores and explains every lead, runs compliant personalized email sequences, reads and classifies replies, and tracks conversions. Every dashboard number is a count over real database rows.

## Quick start

Requirements: Node.js 22.13+ (uses the built-in `node:sqlite`). No database server or build step is needed.

```bash
npm install
cp .env.example .env        # set APP_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_BASE_URL
npm start                   # dashboard on http://localhost:3000
npm test                    # unit + end-to-end workflow tests
```

Then in the dashboard:

1. **Settings**: enter your business name, your name, and your **physical postal address**. CAN-SPAM requires these, and outreach stays blocked until they are set. Add your Calendly link and services text.
2. **Sending Accounts**: add your own mailbox's SMTP details, and its IMAP details so replies are read. Click **Test SMTP**.
3. **Lead Discovery**: choose states and equipment, then run. The FMCSA Operating Authority and Company Census sources need no API key.
4. **Lead Database / High-Intent Prospects**: review the scored leads. Open a lead to see why it got its scores, with evidence.
5. **Campaign Management**: create a campaign, preview its audience, and activate it. Approve the generated emails in the approval queue.
6. **AI Reply Management**: replies are classified automatically. Approve the Conversion Agent's drafted answers.

## MC number + ZIP code list

A **qualified lead** is a carrier whose MC authority has been **continuously active for at least 5 months** (a suspension or revocation restarts the clock) and that runs **at least one tractor** (large commercial truck, owned or leased), with ≤ 10 power units.

- **Website (Vercel):** https://truck-dispatch-leads.vercel.app: search and filter by state, ZIP, months active and tractors; download CSV.
- **Agent, free:** the GitHub Action `.github/workflows/mc-zip-daily.yml` runs every 4 hours. It downloads FMCSA's full authority history (Motus AuthHist, ~270k events, pages fetched in parallel), computes each carrier's active-since date, then looks up ZIP and truck counts in the FMCSA census (batches of 100 USDOT numbers, 8 requests in parallel). It rebuilds [`exports/mc-zip.csv`](exports/mc-zip.csv) (carriers that lose authority drop out) and every commit redeploys the website. Run it on demand from **Actions → MC + ZIP agent → Run workflow**.
- **Locally:** `npm run export:mc-zip -- --min-months 5 --max-months 0 --max-fleet 10 --parallel 8`.
- **Dashboard:** Lead Database → filter "Has MC number" or a ZIP prefix → **Export MC + ZIP**.

Columns: `mc_number, zip_code, name, state, city, usdot_number, active_since, tractors, power_units, first_seen`. Carriers authorized since 2025 have FMCSA's new 8-digit docket numbers (e.g. `MC56166284`).

## Agents and data flow

Agents hand work to each other through a durable SQLite job queue (`jobs` table). Jobs survive restarts, retry with exponential backoff, and are de-duplicated by key.

| Agent | Code | What it does |
|---|---|---|
| 1 Discovery | `src/agents/sources.js`, `pipeline.js` (`search.run`, `search.query`) | Splits a run into independent source × location × equipment queries that run in parallel. Free: FMCSA Operating Authority (daily grants and new applications, joined to the census) and the FMCSA Company Census (new for-hire carriers ≤ N trucks). Optional free tiers: Google Programmable Search, Brave, Reddit API |
| 2 Intent Detection | `src/agents/intent.js` | 0–100 score from evidence only: authority just granted or applied for, fleet expansion, quoted statements (seeking a dispatcher, needs loads, low rates, broker/paperwork pain), new registration, small fleet. Older evidence decays. Dispatch providers are scored ≤ 5. AI runs only on free-text posts and may only cite quotes that exist |
| 3 Email Discovery | `src/agents/crawler.js` | Crawls the company's own site (robots.txt respected, ≤ 5 pages). Keeps only addresses published on a page (mailto, text, `[at]`/`[dot]`), each with its source URL and date. Never guesses addresses |
| 4 Verification | `src/agents/verification.js` | Syntax → suppression → duplicate → disposable (public list, refreshed weekly) → system/role → previous bounce → DNS/MX/null MX → free SMTP probe with a random-address catch-all control, paced per mail server and backed off for 24 h where refused. Statuses: verified, likely valid, risky, unknown, invalid, disposable, duplicate, previously bounced, suppressed. **MX alone never counts as verified** |
| 4b Business Research | `src/agents/research.js` | Builds a short brief per qualified lead from stored facts, and lists what is *not* known so emails never assume it. Cached by a hash of the facts; optional AI rewrite |
| 5 Deduplication | `src/agents/leads.js` | Merges by USDOT, website domain, phone, email, source URL, or name+state. A periodic sweep catches keys learned later |
| 6 Qualification | `src/agents/qualification.js` | Lead score (demand, intent, relevance, contact quality, freshness, deliverability, learned-from-outcomes), freshness and confidence scores, each with a reason per component; priority (very high/high/medium/low) and outreach eligibility with reasons |
| 7 Personalization | `src/agents/personalization.js` | Writes each email from verified facts and the research brief only, and picks the best of several subject lines. AI output with guarantees, numbers, testimonials or unapproved links is rejected and the template is used instead |
| 8 Outreach | `src/agents/outreach.js` | Campaigns, segments, a Day 1/3/6/10 sequence, A/B template variants per step, approval queue, send window in the recipient's time zone, per-business frequency limits, re-enrollment cooldown, per-account limits and rotation, threading, bounce-rate auto-pause, suppression |
| 9 Reply Management | `src/agents/replies.js`, `src/email/inbox.js` | IMAP polling and an inbound webhook. Parses DSN bounces, strips quoted history, and sorts replies into 11 categories (including "wants a call"). Any reply stops the sequence. Out-of-office replies resume it |
| 10 Conversion | `src/agents/conversion.js` | Drafts answers (services, Calendly, pricing only when enabled), records meetings (manual or Calendly webhook), marks clients |
| 11 Analytics + Learning | `src/agents/analytics.js`, `learning.js` | Funnels by source, category, equipment, state, intent band, signal, subject line, step and A/B variant; agent activity and AI usage. Learning adjusts lead scores by at most ±8 points, only for traits with ≥ 20 contacted leads, using a conservative (Wilson) rate estimate |
| 12 Maintenance | `src/lib/maintenance.js` | Daily SQLite backup (`data/backups`, last 7 kept), retention cleanup of old jobs and logs. Suppressions are never deleted |

## Compliance built in

- Every email carries the sender's identity, physical postal address, an unsubscribe link (`/u/<signed token>`), and `List-Unsubscribe` and `List-Unsubscribe-Post` one-click headers.
- Unsubscribes, hard bounces, complaints and "not interested" replies are added to a permanent suppression list, checked at enrollment, at generation, and again right before sending.
- Outreach goes only to countries listed in Settings (default `US`). Leads elsewhere need a recorded lawful basis.
- Each enrollment and step is unique in the database, and sending claims a message atomically, so no email is sent twice.
- Sending accounts are rotated only within each account's own limits. Failing accounts are skipped and the admin is notified.
- The crawler honours robots.txt. LinkedIn and Facebook pages are never fetched; only titles and snippets returned by search APIs are stored.

## Integrations (`.env`)

The whole system runs on free services. All variables are optional except `APP_SECRET`. `FREE_ONLY` is on by default: paid integrations (Google Places, ZeroBounce, NeverBounce, OpenAI/Anthropic APIs) stay off even if a key is present. The Settings page shows which integrations are active (as booleans only).

| Variable | Cost | Purpose |
|---|---|---|
| *(none)* | free | FMCSA Operating Authority and Company Census (data.transportation.gov), SMTP mailbox probe, disposable-domain list |
| `LLM_BASE_URL`, `LLM_MODEL` | free | Local [Ollama](https://ollama.com) model (`http://localhost:11434/v1`, `llama3.1:8b`) for AI personalization, reply understanding and insights. `LLM_DAILY_LIMIT` caps calls (default 300). Without it, rule engines and templates do the work |
| `SOCRATA_APP_TOKEN` | free | Higher rate limits on data.transportation.gov |
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | free tier | Google Programmable Search (100 queries/day) |
| `BRAVE_SEARCH_KEY` | free tier | Brave web search |
| `REDDIT_CLIENT_ID/SECRET` | free | Public posts in r/Truckers and r/OwnerOperators |
| `SMTP_PROBE=0` | — | Turns the SMTP probe off. The probe needs outbound port 25 and works best from an IP with reverse DNS matching `SMTP_PROBE_HELO`. Gmail and most business mail servers answer; Outlook and Yahoo often refuse home/cloud IPs, and those addresses stay "likely valid" or "unknown" rather than being guessed |
| `INBOUND_WEBHOOK_SECRET` | free | `POST /hooks/inbound` with header `x-webhook-secret`, body `{raw}` (full RFC 822 message) or `{from, subject, text, message_id, in_reply_to, references}` |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | needs a paid Calendly plan | Optional. `POST /hooks/calendly` records `invitee.created` bookings automatically. On the free Calendly plan, record meetings with the "Meeting booked" button instead |

## Deployment

- **Process**: `npm start` behind a process manager (systemd, pm2, or a Windows service). On shutdown the worker finishes running jobs. On start, unfinished jobs are re-queued.
- **HTTPS**: put it behind a reverse proxy (Caddy or nginx) with TLS, then set `SECURE_COOKIES=1` and `PUBLIC_BASE_URL=https://your-domain`. The unsubscribe URL must be publicly reachable.
- **Data**: everything is in `data/leads.db` (SQLite, WAL mode). The Maintenance job writes a consistent daily copy to `data/backups/` (count set in Settings); copy that folder off the machine as well.
- **Users**: `npm run create-admin -- you@example.com 'long-password' [admin|viewer]`. Viewers can read everything but change nothing.
- **Deliverability**: use a dedicated sending domain with SPF, DKIM and DMARC. Warm up new mailboxes at 20–40 emails/day. Start with only **verified** addresses; enable "likely valid" sends once bounce rates are known. Campaigns and accounts auto-pause above the configured bounce rate.

## Security

- scrypt password hashes, HttpOnly SameSite=Strict session cookies, a login rate limit, an Origin check on mutating requests, and admin/viewer roles.
- SMTP/IMAP passwords are encrypted with AES-256-GCM and never returned by the API. Secret-looking keys are scrubbed from audit log details.
- Strict Content-Security-Policy, no inline scripts. All API keys stay on the server.
