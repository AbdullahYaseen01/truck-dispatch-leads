// DispatchLeads dashboard. Vanilla JS SPA; every number shown comes from the API (database records).

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => Number(n || 0).toLocaleString();
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fmtTime = (s) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])).toString();
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

let me = null;
let meta = { equipment: [], categories: [], sources: {}, source_cost: {}, reply_categories: [], verification_statuses: [], states: [], stages: [] };
let counts = {};
const state = {
  leadQ: { sort: 'lead_score', limit: 50, offset: 0 },
  intentQ: { min_intent: 70, sort: 'intent_score', limit: 50, offset: 0 },
  contactQ: { status: '', q: '', offset: 0 },
  replyQ: { classification: '', needs_admin: '' },
  enrollQ: { status: 'active' },
};

// ---------------- api ----------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Please sign in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = `toast${err ? ' err' : ''}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) o[k] = k in o ? [].concat(o[k], v) : v;
  for (const el of $$('[data-multi]', form)) o[el.name] = el.name in o ? [].concat(o[el.name]) : [];
  for (const el of $$('input[type=checkbox][data-bool]', form)) o[el.name] = el.checked;
  return o;
}
const csv = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

// ---------------- small render helpers ----------------
function scoreEl(v) {
  const n = Number(v || 0);
  const c = n >= 90 ? '#7c3aed' : n >= 70 ? '#059669' : n >= 40 ? '#d97706' : '#94a3b8';
  return `<span class="score"><span>${n}</span><span class="bar"><i style="width:${n}%;background:${c}"></i></span></span>`;
}
const STATUS_BADGE = { verified: 'b-good', likely_valid: 'b-info', previously_bounced: 'b-bad', wants_call: 'b-purple',
  very_high: 'b-purple', high: 'b-good', medium: 'b-warn', low: 'b-gray', free: 'b-good', free_tier: 'b-info', paid: 'b-bad', risky: 'b-warn', invalid: 'b-bad', disposable: 'b-bad', duplicate: 'b-gray', suppressed: 'b-gray', unverified: 'b-info',
  active: 'b-good', paused: 'b-warn', draft: 'b-gray', completed: 'b-info', stopped: 'b-gray', running: 'b-info', queued: 'b-gray', done: 'b-good', failed: 'b-bad',
  pending_approval: 'b-warn', approved: 'b-info', sending: 'b-info', sent: 'b-good', bounced: 'b-bad', rejected: 'b-gray', cancelled: 'b-gray',
  interested: 'b-good', very_interested: 'b-purple', wants_pricing: 'b-good', wants_more_info: 'b-good', already_has_dispatcher: 'b-gray', follow_up_later: 'b-info',
  not_interested: 'b-gray', unsubscribe: 'b-bad', out_of_office: 'b-gray', invalid_response: 'b-gray',
  new: 'b-info', qualified: 'b-good', disqualified: 'b-gray', contacted: 'b-info', replied: 'b-purple', meeting: 'b-purple', client: 'b-good', do_not_contact: 'b-bad',
  ok: 'b-good', failing: 'b-bad', unknown: 'b-gray' };
const badge = (s, text) => (s ? `<span class="badge ${STATUS_BADGE[s] || ''}">${esc(text || label(s))}</span>` : '<span class="muted">—</span>');
const empty = (msg, cols = 1) => `<tr><td colspan="${cols}" class="empty">${esc(msg)}</td></tr>`;
const opt = (v, cur, text) => `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(text ?? label(v))}</option>`;
const checks = (name, values, selected = [], disabled = {}) => `<div class="checks">${values.map((v) => `<label class="${disabled[v] ? 'off' : ''}"><input type="checkbox" name="${name}" value="${esc(v)}" data-multi${selected.includes(v) ? ' checked' : ''}${disabled[v] ? ' disabled' : ''}> ${esc(label(v))}</label>`).join('')}</div>`;
const extLink = (url, text) => (url && /^https?:/.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text || url)}</a>` : esc(text || url || '—'));

function hbars(rows, valueKey, labelKey = 'k') {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  if (!rows.length) return '<p class="muted">No data yet.</p>';
  return rows.map((r) => `<div class="hbar"><span class="lbl" title="${esc(r[labelKey])}">${esc(label(r[labelKey] ?? 'unknown'))}</span><span class="track"><i style="width:${(100 * (r[valueKey] || 0)) / max}%"></i></span><b>${fmtN(r[valueKey])}</b></div>`).join('');
}

function barChart(series) {
  const keys = [['leads', '#2563eb', 'Leads discovered'], ['sent', '#7c3aed', 'Emails sent'], ['replies', '#059669', 'Replies']];
  const max = Math.max(4, ...series.flatMap((d) => keys.map(([k]) => d[k])));
  const W = 540, H = 220, pl = 34, pb = 24, pt = 10;
  const cw = (W - pl) / Math.max(1, series.length);
  const bw = Math.max(2, (cw - 4) / 3);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = pt + (H - pt - pb) * (1 - i / 4);
    g += `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}" stroke="#eef2f7"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end" font-size="12" fill="#64748b">${Math.round((max * i) / 4)}</text>`;
  }
  series.forEach((d, i) => {
    keys.forEach(([k, c], j) => {
      const h = ((H - pt - pb) * d[k]) / max;
      g += `<rect x="${pl + i * cw + 2 + j * bw}" y="${H - pb - h}" width="${Math.max(1, bw - 1)}" height="${h}" fill="${c}" rx="1"><title>${d.date} · ${k}: ${d[k]}</title></rect>`;
    });
    if (i % 5 === 0 || i === series.length - 1) g += `<text x="${pl + i * cw + cw / 2}" y="${H - 6}" text-anchor="${i === series.length - 1 ? 'end' : 'middle'}" font-size="12" fill="#64748b">${d.date.slice(5)}</text>`;
  });
  return `<div class="legend">${keys.map(([, c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div><div class="chart"><svg viewBox="0 0 ${W} ${H}" style="height:auto">${g}</svg></div>`;
}

const actions = {};
const forms = {};

// ---------------- routing ----------------
const routes = [
  ['overview', 'Overview', renderOverview],
  ['discovery', 'Lead Discovery', renderDiscovery],
  ['leads', 'Lead Database', renderLeads],
  ['intent', 'High-Intent Prospects', renderIntent],
  ['verification', 'Email Verification', renderVerification],
  ['campaigns', 'Campaign Management', renderCampaigns],
  ['templates', 'Email Templates', renderTemplates],
  ['followups', 'Follow-Up Management', renderFollowups],
  ['replies', 'AI Reply Management', renderReplies],
  ['analytics', 'Analytics', renderAnalytics],
  ['accounts', 'Sending Accounts', renderAccounts],
  ['settings', 'Settings', renderSettings],
];
let current = 'overview';

function renderNav() {
  const badgeFor = { campaigns: counts.pending_approval, replies: counts.needs_admin, intent: counts.high_intent };
  $('#nav').innerHTML = routes.map(([k, t]) => `<a href="#/${k}" class="${k === current ? 'active' : ''}"><span>${t}</span>${badgeFor[k] ? `<span class="count">${fmtN(badgeFor[k])}</span>` : ''}</a>`).join('');
}

async function refreshCounts() {
  try { counts = (await api('/api/overview?days=1')).stats; renderNav(); } catch { /* ignore */ }
}

async function go() {
  const key = location.hash.replace(/^#\/?/, '') || 'overview';
  const r = routes.find((x) => x[0] === key) || routes[0];
  current = r[0];
  $('#title').textContent = r[1];
  $('#top-actions').innerHTML = '';
  $('.sidebar').classList.remove('open');
  renderNav();
  await renderCurrent();
}

async function renderCurrent() {
  const r = routes.find((x) => x[0] === current);
  try { await r[2]($('#view')); } catch (e) { $('#view').innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`; }
}

// ---------------- login / session ----------------
function showLogin() { $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
async function boot() {
  try { me = (await api('/api/me')).user; } catch { return; }
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  document.body.classList.toggle('viewer', me.role !== 'admin');
  $('#me-name').textContent = `${me.name} · ${me.role}`;
  meta = await api('/api/meta');
  connectEvents();
  await refreshCounts();
  await go();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', body: formData(e.target) }); e.target.reset(); await boot(); } catch (err) { $('#login-error').textContent = err.message; }
});
actions.logout = async () => { await api('/api/logout', { method: 'POST', body: {} }); location.reload(); };
actions['toggle-nav'] = () => $('.sidebar').classList.toggle('open');

// ---------------- real-time updates ----------------
let es = null;
let refreshTimer = null;
let lastRefresh = 0;
function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onopen = () => { $('#live-dot').classList.add('on'); $('#live-text').textContent = 'Live updates on'; };
  es.onerror = () => { $('#live-dot').classList.remove('on'); $('#live-text').textContent = 'Reconnecting…'; };
  es.onmessage = () => scheduleRefresh();
}
function busyEditing() {
  const a = document.activeElement;
  return !$('#modal').classList.contains('hidden') || (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && $('#view').contains(a));
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const wait = Math.max(800, 3000 - (Date.now() - lastRefresh));
  refreshTimer = setTimeout(async () => {
    lastRefresh = Date.now();
    await refreshCounts();
    if (['templates', 'settings', 'accounts'].includes(current) || busyEditing()) return;
    const y = window.scrollY;
    await renderCurrent();
    window.scrollTo(0, y);
  }, wait);
}

// ---------------- modal & drawer ----------------
function openModal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }
actions['close-modal'] = closeModal;
actions['close-drawer'] = () => $('#drawer').classList.add('hidden');
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') $('#drawer').classList.add('hidden'); });

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  const was = el.disabled;
  if (el.tagName === 'BUTTON') el.disabled = true;
  try { await actions[el.dataset.act](el, e); } catch (err) { toast(err.message, true); } finally { if (el.tagName === 'BUTTON' && el.isConnected) el.disabled = was; }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const btns = $$('button[type=submit]', f);
  btns.forEach((b) => { b.disabled = true; });
  try { await forms[f.dataset.form](formData(f), f, e.submitter); } catch (err) { toast(err.message, true); } finally { btns.forEach((b) => { if (b.isConnected) b.disabled = false; }); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('#drawer').classList.add('hidden'); } });
window.addEventListener('hashchange', go);

// =============== 1. Overview ===============
async function renderOverview(v) {
  const [d, ag] = await Promise.all([api('/api/overview?days=30'), api('/api/agents')]);
  const s = d.stats;
  const cards = [
    ['Total Leads Discovered', s.total_leads, 'accent'], ['New Leads Today', s.new_today], ['Qualified Leads', s.qualified], ['High-Intent Leads', s.high_intent],
    ['Needs Review', s.needs_review], ['Verified Business Emails', s.verified_emails], ['Likely Valid Emails', s.likely_valid_emails],
    ['Risky / Unknown Emails', s.risky_emails], ['Invalid / Bounced Emails', s.invalid_emails], ['Duplicate Leads', s.duplicate_leads],
    ['Active Campaigns', s.active_campaigns], ['Awaiting Approval', s.pending_approval], ['Emails Sent', s.emails_sent],
    ['Emails Delivered', s.emails_delivered], ['Emails Bounced', s.emails_bounced], ['Follow-Ups Sent', s.followups_sent], ['Replies Received', s.replies],
    ['Positive Replies', s.positive_replies], ['Interested Leads', s.interested], ['Unsubscribes', s.unsubscribes], ['Meetings Booked', s.meetings], ['Converted Clients', s.clients],
  ];
  const aiRow = (a) => `<tr><td>${esc(a.agent)}</td><td>${fmtN(a.calls)}</td><td>${fmtN(a.cache_hits)}</td><td>${a.failures ? `<span class="badge b-bad">${a.failures}</span>` : 0}</td></tr>`;
  const jobs = {};
  for (const j of d.jobs) { jobs[j.type] ||= {}; jobs[j.type][j.status] = j.n; }
  v.innerHTML = `
    ${d.compliance.length ? `<div class="notice warn"><b>Outreach is blocked until these are fixed in <a href="#/settings">Settings</a>:</b><ul>${d.compliance.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <div class="stats">${cards.map(([l, n, cls]) => `<div class="stat ${cls || ''}"><div class="label">${l}</div><div class="value">${fmtN(n)}</div></div>`).join('')}</div>
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2>Last 30 days</h2></div>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Analytics Agent insights</h2><span class="muted small">${fmtTime(d.insights.created_at)}</span></div>
        <div class="list">${d.insights.insights.map((i) => `<div class="item">${esc(i)}</div>`).join('')}</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2>Notifications</h2><button class="btn sm" data-act="notif-read">Mark all read</button></div>
        <div class="list">${d.notifications.length ? d.notifications.map((n) => `<div class="item"><div class="head"><b>${esc(n.title)}</b><span class="row">${n.is_read ? '' : '<span class="badge b-info">new</span>'}<span class="muted small">${fmtTime(n.created_at)}</span></span></div>${n.body ? `<div class="muted small">${esc(n.body)}</div>` : ''}</div>`).join('') : '<p class="muted">No notifications yet.</p>'}</div></div>
      <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Agent job queue</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Agent job</th><th>Queued</th><th>Running</th><th>Done</th><th>Failed</th></tr></thead><tbody>
        ${Object.keys(jobs).length ? Object.entries(jobs).map(([t, c]) => `<tr><td class="mono">${esc(t)}</td><td>${fmtN(c.queued)}</td><td>${fmtN(c.running)}</td><td>${fmtN(c.done)}</td><td>${c.failed ? `<span class="badge b-bad">${c.failed}</span>` : 0}</td></tr>`).join('') : empty('No jobs have run yet', 5)}
        </tbody></table></div></div>
    </div>
    <div class="grid g2">
      <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Agent activity, last 24 hours</h2><span class="muted small">${fmtN(ag.workers.queued)} waiting${ag.workers.stuck ? ` · <span class="error">${ag.workers.stuck} stuck</span>` : ''}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Done</th><th>Failed</th><th>Queued</th><th>Last active</th></tr></thead><tbody>
        ${ag.agents.length ? ag.agents.map((a) => `<tr><td><b>${esc(a.agent)}</b></td><td>${fmtN(a.done)}</td><td>${a.failed ? `<span class="badge b-bad">${a.failed}</span>` : 0}</td><td>${fmtN(a.queued + a.running)}</td><td class="small">${fmtTime(a.last)}</td></tr>`).join('') : empty('No agent work in the last 24 hours', 5)}
        ${Object.entries(ag.extra).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${fmtN(n)}</td><td></td><td></td><td></td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Free AI usage today</h2><span class="muted small">${fmtN(ag.ai_budget_left)} calls left of today's budget</span></div>
        <div class="table-wrap"><table><thead><tr><th>Agent</th><th>AI calls</th><th>Cache hits (no call)</th><th>Failures</th></tr></thead><tbody>
        ${ag.ai_usage.length ? ag.ai_usage.map(aiRow).join('') : empty('No AI calls today. Without a local model the agents use their rule engines.', 4)}
        </tbody></table></div></div>
    </div>`;
}
actions['notif-read'] = async () => { await api('/api/notifications/read', { method: 'POST', body: {} }); renderCurrent(); };

// =============== 2. Lead Discovery ===============
const SOURCE_INFO = {
  fmcsa_authority: ['FMCSA Operating Authority (daily)', 'Official authority grants and new applications, updated daily. No key. The strongest "just got my MC" signal.'],
  fmcsa_census: ['FMCSA Company Census', 'Official US DOT carrier registry. No key. Newly registered for-hire carriers with their published email.'],
  google_cse: ['Google Search (Programmable Search)', 'Optional free tier (100 queries/day). Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX.'],
  brave: ['Brave Web Search', 'Optional free tier. Set BRAVE_SEARCH_KEY.'],
  reddit: ['Reddit (r/Truckers, r/OwnerOperators)', 'Optional free API app. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.'],
  google_places: ['Google Maps (Places API)', 'Paid API: switched off while FREE_ONLY is on.'],
};
const COST_TEXT = { free: 'free', free_tier: 'free tier', paid: 'paid' };

async function renderDiscovery(v) {
  const [runs, sch] = await Promise.all([api('/api/search-runs'), api('/api/schedules')]);
  const avail = runs.sources;
  v.innerHTML = `
    <div class="card admin-only">
      <div class="card-head"><h2>Start a discovery run</h2><span class="muted small">Each source × location × equipment query runs as its own parallel job</span></div>
      <form data-form="search" class="grid" style="gap:14px">
        <div><div class="muted small" style="margin-bottom:6px">Sources</div>
          <div class="grid g2" style="gap:8px">${Object.entries(SOURCE_INFO).map(([k, [t, hint]]) => `<label class="item" style="display:flex;gap:10px;align-items:flex-start;color:var(--ink);font-weight:500">
            <input type="checkbox" name="sources" value="${k}" data-multi ${avail[k] ? 'checked' : 'disabled'}>
            <span><b>${t}</b> ${badge(meta.source_cost[k], COST_TEXT[meta.source_cost[k]])} ${avail[k] ? badge('ok', 'ready') : badge('unknown', meta.source_cost[k] === 'paid' ? 'off (free-only)' : 'not configured')}<br><span class="muted small">${esc(hint)}</span></span></label>`).join('')}</div></div>
        <div class="form-grid">
          <label>US states (comma separated)<input name="states" value="TX, FL, GA" placeholder="TX, FL"></label>
          <label>Cities (optional, for map/web search)<input name="cities" placeholder="Houston TX, Dallas TX"></label>
          <label>Registered within (days)<input name="newWithinDays" type="number" min="1" value="120"></label>
          <label>Max fleet size (power units)<input name="maxFleet" type="number" min="1" value="10"></label>
          <label>Results per query<input name="limitPerQuery" type="number" min="1" max="500" value="50"></label>
          <label>Max queries<input name="maxQueries" type="number" min="1" max="200" value="40"></label>
        </div>
        <div><div class="muted small" style="margin-bottom:6px">Equipment types</div>${checks('equipment', meta.equipment, ['Dry Van', 'Flatbed', 'Hotshot', 'Reefer', 'Box Truck'])}</div>
        <label>Extra web search keywords (one per line)<textarea name="keywords" placeholder="&quot;new authority&quot; owner operator looking for loads"></textarea></label>
        <div class="row"><button class="btn primary" type="submit" value="run">Run discovery now</button>
          <span class="spacer"></span><input name="schedule_name" placeholder="Schedule name" style="width:180px">
          <select name="interval_minutes">${[['360', 'Every 6 hours'], ['720', 'Every 12 hours'], ['1440', 'Daily'], ['10080', 'Weekly']].map(([m, t]) => opt(m, '1440', t)).join('')}</select>
          <button class="btn" type="submit" value="schedule">Save as schedule</button></div>
      </form>
    </div>
    <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Discovery runs</h2></div><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Started</th><th>Sources / states</th><th>Status</th><th>Progress</th><th>Found</th><th>New</th><th>Merged (dupes)</th><th>By</th></tr></thead><tbody>
      ${runs.runs.length ? runs.runs.map((r) => {
        const s = r.stats || {};
        const pct = s.total ? Math.round((100 * ((s.completed || 0) + (s.failed_queries || 0))) / s.total) : r.status === 'done' ? 100 : 0;
        return `<tr><td>${r.id}</td><td>${fmtTime(r.created_at)}</td><td>${esc((r.params.sources || []).join(', '))}<div class="sub">${esc((r.params.states || []).join(', '))}</div></td>
          <td>${badge(r.status)}${r.error ? `<div class="sub error">${esc(r.error)}</div>` : ''}</td>
          <td><div class="progress"><i style="width:${pct}%"></i></div><div class="sub">${fmtN((s.completed || 0) + (s.failed_queries || 0))}/${fmtN(s.total)} queries</div></td>
          <td>${fmtN(s.found)}</td><td>${fmtN(s.new)}</td><td>${fmtN(s.merged)}</td><td class="small">${esc(r.created_by)}</td></tr>`;
      }).join('') : empty('No discovery runs yet. Start one above.', 9)}
    </tbody></table></div></div>
    <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Search schedules</h2></div><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Sources / states</th><th>Interval</th><th>Last run</th><th>Next run</th><th>Status</th><th></th></tr></thead><tbody>
      ${sch.schedules.length ? sch.schedules.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc((s.params.sources || []).join(', '))}<div class="sub">${esc((s.params.states || []).join(', '))}</div></td>
        <td>${s.interval_minutes >= 1440 ? `${s.interval_minutes / 1440} day(s)` : `${s.interval_minutes / 60} h`}</td><td>${fmtTime(s.last_run_at)}</td><td>${s.enabled ? fmtTime(s.next_run_at) : '—'}</td>
        <td>${s.enabled ? badge('active', 'enabled') : badge('paused', 'disabled')}</td>
        <td class="row admin-only"><button class="btn sm" data-act="schedule-toggle" data-id="${s.id}" data-enabled="${s.enabled ? 0 : 1}">${s.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn sm danger" data-act="schedule-delete" data-id="${s.id}" data-confirm="Delete this schedule?">Delete</button></td></tr>`).join('') : empty('No schedules. Use "Save as schedule" to run discovery automatically.', 7)}
    </tbody></table></div></div>`;
}
forms.search = async (d, f, submitter) => {
  const params = { sources: d.sources, states: csv(d.states), cities: csv(d.cities), equipment: d.equipment, keywords: d.keywords, newWithinDays: d.newWithinDays, maxFleet: d.maxFleet, limitPerQuery: d.limitPerQuery, maxQueries: d.maxQueries };
  if (submitter?.value === 'schedule') {
    if (!d.schedule_name) throw new Error('Give the schedule a name');
    await api('/api/schedules', { method: 'POST', body: { ...params, name: d.schedule_name, interval_minutes: d.interval_minutes } });
    toast('Schedule saved. It runs for the first time within a minute.');
  } else {
    const r = await api('/api/search-runs', { method: 'POST', body: params });
    toast(`Discovery run #${r.id} started`);
  }
  renderCurrent();
};
actions['schedule-toggle'] = async (el) => { await api(`/api/schedules/${el.dataset.id}`, { method: 'PATCH', body: { enabled: el.dataset.enabled === '1' } }); renderCurrent(); };
actions['schedule-delete'] = async (el) => { await api(`/api/schedules/${el.dataset.id}`, { method: 'DELETE', body: {} }); renderCurrent(); };

// =============== 3. Lead Database ===============
function leadFilters(q, formName) {
  return `<form data-form="${formName}" class="filters"><div class="form-grid">
    <label>Search<input name="q" value="${esc(q.q)}" placeholder="Name, USDOT, MC, ZIP or domain"></label>
    <label>MC number<select name="has_mc">${opt('', q.has_mc, 'Any')}${opt('1', q.has_mc, 'Has MC number')}</select></label>
    <label>ZIP code (or prefix)<input name="zip" value="${esc(q.zip)}" placeholder="770"></label>
    <label>Discovered from<input type="date" name="from" value="${esc(q.from)}"></label>
    <label>Discovered to<input type="date" name="to" value="${esc(q.to)}"></label>
    <label>US state<select name="states">${opt('', q.states, 'Any state')}${meta.states.map((s) => opt(s, q.states, s)).join('')}</select></label>
    <label>City<input name="city" value="${esc(q.city)}"></label>
    <label>Equipment<select name="equipment">${opt('', q.equipment, 'Any equipment')}${meta.equipment.map((s) => opt(s, q.equipment, s)).join('')}</select></label>
    <label>Category<select name="categories">${opt('', q.categories, 'Any category')}${[...meta.categories, 'Community Post'].map((s) => opt(s, q.categories, s)).join('')}</select></label>
    <label>Min fleet<input type="number" min="0" name="min_fleet" value="${esc(q.min_fleet)}"></label>
    <label>Max fleet<input type="number" min="0" name="max_fleet" value="${esc(q.max_fleet)}"></label>
    <label>Min lead score<input type="number" min="0" max="100" name="min_lead_score" value="${esc(q.min_lead_score)}"></label>
    <label>Min intent score<input type="number" min="0" max="100" name="min_intent" value="${esc(q.min_intent)}"></label>
    <label>Email status<select name="verification">${opt('', q.verification, 'Any')}${meta.verification_statuses.map((s) => opt(s, q.verification)).join('')}</select></label>
    <label>Discovery source<select name="source">${opt('', q.source, 'Any source')}${['fmcsa_authority', 'fmcsa_census', 'google_cse', 'brave', 'reddit', 'google_places', 'website', 'manual'].map((s) => opt(s, q.source)).join('')}</select></label>
    <label>Priority<select name="priority">${opt('', q.priority, 'Any priority')}${['very_high', 'high', 'medium', 'low'].map((s) => opt(s, q.priority)).join('')}</select></label>
    <label>Outreach eligibility<select name="eligible">${opt('', q.eligible, 'Any')}${opt('1', q.eligible, 'Eligible to email')}${opt('0', q.eligible, 'Not eligible')}</select></label>
    <label>Discovered in last (days)<input type="number" min="1" name="recent_days" value="${esc(q.recent_days)}"></label>
    <label>Stage<select name="stages">${opt('', q.stages, 'Any stage')}${meta.stages.map((s) => opt(s, q.stages)).join('')}</select></label>
    <label>Campaign status<select name="campaign_status">${opt('', q.campaign_status, 'Any')}${[['not_enrolled', 'Not in a campaign'], ['active', 'In active sequence'], ['stopped', 'Sequence stopped'], ['completed', 'Sequence completed']].map(([k, t]) => opt(k, q.campaign_status, t)).join('')}</select></label>
    <label>Sort by<select name="sort">${[['lead_score', 'Lead score'], ['intent_score', 'Intent score'], ['confidence', 'Confidence'], ['freshness', 'Freshness'], ['discovered', 'Newest'], ['fleet', 'Fleet size'], ['name', 'Name']].map(([k, t]) => opt(k, q.sort, t)).join('')}</select></label>
    <div class="row"><button class="btn primary" type="submit">Apply</button><button class="btn" type="submit" value="reset">Reset</button></div>
  </div></form>`;
}
function filterValues(d, defaults) {
  const keep = { ...defaults, offset: 0 };
  for (const [k, val] of Object.entries(d)) if (val !== '' && !Array.isArray(val)) keep[k] = val;
  return keep;
}
function pager(total, q, act) {
  const from = total ? q.offset + 1 : 0;
  const to = Math.min(total, Number(q.offset) + Number(q.limit));
  return `<div class="pager"><span>${fmtN(from)}–${fmtN(to)} of ${fmtN(total)}</span><span class="row">
    <button class="btn sm" data-act="${act}" data-dir="-1" ${q.offset <= 0 ? 'disabled' : ''}>Previous</button>
    <button class="btn sm" data-act="${act}" data-dir="1" ${to >= total ? 'disabled' : ''}>Next</button></span></div>`;
}

async function renderLeads(v) {
  const q = state.leadQ;
  const d = await api(`/api/leads?${qs(q)}`);
  $('#top-actions').innerHTML = `<div class="row"><a class="btn" href="/api/leads/export.csv?${esc(qs({ ...q, limit: '', offset: '' }))}">Export CSV</a><a class="btn primary" href="/api/leads/export.csv?${esc(qs({ ...q, has_mc: '1', fields: 'mc_zip', limit: '', offset: '' }))}">Export MC + ZIP</a><button class="btn admin-only" data-act="lead-new">Add lead</button></div>`;
  v.innerHTML = `<div class="card flush">${leadFilters(q, 'lead-filter')}<div class="table-wrap"><table>
    <thead><tr><th>Company</th><th>MC number · ZIP</th><th>Equipment · fleet</th><th>Best email</th><th>Intent</th><th>Lead score</th><th>Freshness</th><th>Stage</th><th>Discovered</th></tr></thead><tbody>
    ${d.leads.length ? d.leads.map((l) => `<tr class="click" data-act="lead-open" data-id="${l.id}">
      <td><b>${esc(l.name)}</b><div class="sub">${esc([l.city, l.state].filter(Boolean).join(', ') || '—')} · ${esc(l.prospect_category || 'Unknown category')}${l.usdot_number ? ` · USDOT ${esc(l.usdot_number)}` : ''}</div></td>
      <td>${l.mc_number ? `<b class="mono">MC${esc(l.mc_number)}</b>` : '<span class="muted">no MC yet</span>'}<div class="sub">ZIP ${esc(l.zip_code || '—')}</div></td>
      <td>${esc(l.equipment_types.join(', ') || '—')}<div class="sub">${l.fleet_size ? `${l.fleet_size} power unit(s)` : 'fleet unknown'}</div></td>
      <td>${l.best_email ? `${esc(l.best_email)}<div class="sub">${badge(l.best_email_status)}</div>` : `<span class="muted">${l.contact_count ? 'no usable email' : 'none found'}</span>`}</td>
      <td>${scoreEl(l.intent_score)}</td><td>${scoreEl(l.lead_score)}${l.priority ? `<div class="sub">${badge(l.priority, `${label(l.priority)} priority`)}</div>` : ''}</td><td>${scoreEl(l.freshness_score)}</td><td>${badge(l.stage)}</td><td class="small">${fmtDate(l.first_discovered_at)}<div class="sub">${esc(l.sources || '')}</div></td></tr>`).join('')
      : empty('No leads match these filters. Start a run in Lead Discovery.', 9)}
    </tbody></table></div>${pager(d.total, q, 'lead-page')}</div>`;
}
forms['lead-filter'] = async (d, f, s) => { state.leadQ = s?.value === 'reset' ? { sort: 'lead_score', limit: 50, offset: 0 } : filterValues(d, { limit: 50 }); renderCurrent(); };
actions['lead-page'] = (el) => { state.leadQ.offset = Math.max(0, Number(state.leadQ.offset) + Number(el.dataset.dir) * Number(state.leadQ.limit)); renderCurrent(); };
actions['lead-open'] = (el) => openLead(el.dataset.id);
actions['lead-new'] = () => openModal('Add a lead manually', `<form data-form="lead-new" class="form-grid">
  <label class="full">Company name *<input name="name" required></label>
  <label>Website<input name="website" placeholder="https://"></label><label>Phone<input name="phone"></label>
  <label>City<input name="city"></label><label>State<input name="state" maxlength="2" placeholder="TX"></label>
  <label>USDOT number<input name="usdot_number"></label><label>Fleet size<input name="fleet_size" type="number" min="1"></label>
  <label>Owner name<input name="owner_name"></label>
  <label>Category<select name="prospect_category">${opt('', '', '—')}${meta.categories.map((c) => opt(c, '', c)).join('')}</select></label>
  <label class="full">Equipment<div>${checks('equipment_types', meta.equipment)}</div></label>
  <label>Business email<input name="email" type="email"></label><label>Public URL where it is listed<input name="source_url" placeholder="https://"></label>
  <label class="full">Notes / evidence of need<textarea name="notes"></textarea></label>
  <div class="full row"><button class="btn primary" type="submit">Save lead</button><span class="muted small">The agents enrich, verify and score it automatically.</span></div></form>`);
forms['lead-new'] = async (d) => {
  const r = await api('/api/leads', { method: 'POST', body: d });
  closeModal();
  toast(r.created ? 'Lead added' : `Merged into an existing lead (matched by ${r.mergedBy})`);
  renderCurrent();
  openLead(r.companyId);
};

async function openLead(id) {
  const d = await api(`/api/leads/${id}`);
  const l = d.lead;
  const bd = l.lead_score_breakdown || {};
  const parts = (rows) => (rows || []).map((p) => `<div class="bd"><span>${esc(p.part)}</span><b>${p.points}/${p.of}</b><span class="why muted">${esc(p.why)}</span></div>`).join('');
  $('#drawer-title').textContent = l.name;
  $('#drawer-body').innerHTML = `
    <div class="card"><div class="row" style="gap:18px">
      <div><div class="muted small">Intent</div>${scoreEl(l.intent_score)}</div><div><div class="muted small">Lead score</div>${scoreEl(l.lead_score)}</div>
      <div><div class="muted small">Freshness</div>${scoreEl(l.freshness_score)}</div><div><div class="muted small">Confidence</div>${scoreEl(l.confidence_score)}</div>
      <div><div class="muted small">Priority</div>${badge(l.priority)}</div><div><div class="muted small">Stage</div>${badge(l.stage)}</div>
      ${l.duplicate_of ? `<div>${badge('duplicate', `Duplicate of #${l.duplicate_of}`)}</div>` : ''}</div>
      ${l.qualification_summary ? `<div class="quote">${esc(l.qualification_summary)}</div>` : ''}
      ${l.eligibility.eligible === true ? `<div class="notice info" style="margin-top:10px">${badge('ok', 'Eligible for outreach')}</div>`
        : l.eligibility.reasons?.length ? `<div class="notice warn" style="margin-top:10px"><b>Not eligible for outreach:</b> ${l.eligibility.reasons.map(esc).join('; ')}</div>` : ''}
      <dl class="kv">
        <dt>Owner / contact</dt><dd>${esc(l.owner_name || '—')}</dd><dt>Website</dt><dd>${extLink(l.website)}</dd><dt>Phone</dt><dd>${esc(l.phone || '—')}</dd>
        <dt>ZIP code</dt><dd>${esc(l.zip_code || '—')}</dd><dt>Location</dt><dd>${esc(l.address || [l.city, l.state].filter(Boolean).join(', ') || '—')}</dd><dt>Equipment</dt><dd>${esc(l.equipment_types.join(', ') || '—')}</dd>
        <dt>Fleet size</dt><dd>${l.fleet_size ? `${l.fleet_size} power unit(s)` : '—'}</dd><dt>Category</dt><dd>${esc(l.prospect_category || '—')}</dd>
        <dt>USDOT / MC</dt><dd>${esc(l.usdot_number || '—')} / ${esc(l.mc_number || '—')}</dd><dt>Operating status</dt><dd>${esc(label(l.operating_status || 'unknown'))}${l.authority_checked_at ? ` <span class="muted small">(checked ${fmtDate(l.authority_checked_at)})</span>` : ''}</dd>
        <dt>Dispatching need</dt><dd>${esc(l.dispatch_need || '—')}</dd>
        <dt>First discovered</dt><dd>${fmtTime(l.first_discovered_at)}</dd><dt>Last verified</dt><dd>${fmtTime(l.last_verified_at)}</dd>
        <dt>Website activity</dt><dd>${l.last_website_activity_at ? `${fmtDate(l.last_website_activity_at)} — ${esc(l.last_website_activity_evidence)}` : 'No dated evidence found'}</dd>
        <dt>Registered (FMCSA)</dt><dd>${fmtDate(l.authority_granted_at)}</dd>
        <dt>Authority event</dt><dd>${l.authority_event ? `${esc(label(l.authority_event.type === 'applied' ? 'applied for authority' : l.authority_event.type === 'granted' ? 'authority granted' : l.authority_event.type))} on ${fmtDate(l.authority_event.at)}${l.authority_event.docket ? ` <span class="muted small">(${esc(l.authority_event.docket)})</span>` : ''}` : '—'}</dd>
        <dt>Operating region</dt><dd>${esc(l.operating_region ? label(l.operating_region) : '—')}</dd>
        <dt>Lawful basis (non-US)</dt><dd>${esc(l.lawful_basis || '—')}</dd>
      </dl></div>
    <div class="card"><div class="card-head"><h2>Business research brief</h2><span class="row"><span class="muted small">${l.researched_at ? `built ${fmtTime(l.researched_at)}` : 'not built yet'}</span>
      <button class="btn sm admin-only" data-act="lead-research" data-id="${l.id}">Rebuild</button></span></div>
      ${l.research_summary ? `<pre class="email">${esc(l.research_summary)}</pre>` : '<p class="muted">The Business Research Agent builds this after qualification, from verified facts only.</p>'}</div>
    <div class="card"><h2>Buying-intent signals <span class="muted small">(${esc(l.intent_method || 'rules')})</span></h2>
      <div class="signals">${l.intent_signals.map((s) => `<div class="signal"><b>${esc(s.label || s.signal)}</b> <span class="badge ${s.weight > 0 ? 'b-good' : 'b-gray'}">+${s.weight}</span><div class="muted">“${esc(s.evidence)}”</div>${s.source_url ? `<div>${extLink(s.source_url, 'source')}</div>` : ''}</div>`).join('') || '<p class="muted">Not scored yet.</p>'}</div></div>
    <div class="grid g2"><div class="card"><h2>Why this lead score</h2><div class="breakdown">${parts(bd.lead) || '<p class="muted">Not scored yet.</p>'}</div></div>
      <div class="card"><h2>Why this freshness score</h2><div class="breakdown">${parts(bd.freshness) || '<p class="muted">Not scored yet.</p>'}</div>
        <h2 style="margin-top:14px">Why this confidence score</h2><div class="breakdown">${parts(bd.confidence) || '<p class="muted">Not scored yet.</p>'}</div></div></div>
    <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Business emails</h2></div><div class="table-wrap"><table>
      <thead><tr><th>Email</th><th>Status</th><th>Type</th><th>Found at</th><th>Checked</th><th></th></tr></thead><tbody>
      ${d.contacts.length ? d.contacts.map((c) => `<tr><td>${esc(c.email)}${c.name ? `<div class="sub">${esc(c.name)}</div>` : ''}</td><td>${badge(c.verification_status)}<div class="sub">${esc(c.verification_detail.reason || '')}</div></td>
        <td>${esc(c.contact_type)}${c.is_role ? '<div class="sub">role address</div>' : ''}</td><td class="small">${extLink(c.source_url, c.source)}<div class="sub">${fmtDate(c.discovered_at)}</div></td><td class="small">${fmtTime(c.verified_at)}</td>
        <td class="admin-only"><button class="btn sm" data-act="contact-verify" data-id="${c.id}" data-lead="${l.id}">Re-verify</button></td></tr>`).join('') : empty('No published business email found yet', 6)}
      </tbody></table></div>
      <form data-form="contact-add" class="filters admin-only" data-lead="${l.id}"><div class="form-grid"><label>Add email<input name="email" type="email" required></label>
        <label>Public URL where listed *<input name="source_url" required placeholder="https://"></label><label>Name<input name="name"></label>
        <label>Type<select name="contact_type">${['owner', 'business', 'operations', 'fleet', 'dispatch'].map((t) => opt(t, 'business')).join('')}</select></label>
        <div><button class="btn" type="submit">Add & verify</button></div></div></form></div>
    <div class="card admin-only"><h2>Actions</h2>
      <form data-form="lead-update" data-lead="${l.id}" class="form-grid"><label>Stage<select name="stage">${meta.stages.map((s) => opt(s, l.stage)).join('')}</select></label>
        <label>Lawful basis for non-US outreach<input name="lawful_basis" value="${esc(l.lawful_basis || '')}" placeholder="e.g. legitimate interest assessment #12"></label>
        <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="lead-enrich" data-id="${l.id}">Re-crawl & re-score</button></div></form>
      <form data-form="meeting" class="form-grid" style="margin-top:12px"><label>Record a booked meeting with<select name="email">${d.contacts.map((c) => opt(c.email, '', c.email)).join('') || opt('', '', 'no email')}</select></label>
        <label>When<input type="datetime-local" name="scheduled_for"></label><div><button class="btn" type="submit">Record meeting</button></div></form></div>
    <div class="card"><h2>Sources (${d.sources.length})</h2><div class="list">${d.sources.map((s) => `<div class="item"><div class="head"><b>${esc(label(s.source))}</b><span class="muted small">${fmtTime(s.discovered_at)}${s.published_at ? ` · dated ${fmtDate(s.published_at)}` : ''}</span></div>
      <div class="small">${extLink(s.source_url, s.title || s.source_url)}</div>${s.query ? `<div class="muted small">Query: ${esc(s.query)}</div>` : ''}${s.snippet ? `<div class="muted small" style="margin-top:4px;max-height:80px;overflow:hidden">${esc(s.snippet)}</div>` : ''}</div>`).join('')}</div>
      ${d.duplicates.length ? `<p class="muted small">Merged duplicates: ${d.duplicates.map((x) => `#${x.id} ${esc(x.name)}`).join(', ')}</p>` : ''}</div>
    <div class="card"><h2>Outreach history</h2>${d.enrollments.map((e) => `<p class="small">${esc(e.campaign_name)}: ${badge(e.status)} step ${e.current_step}${e.stop_reason ? ` · ${esc(e.stop_reason)}` : ''}</p>`).join('')}
      <div class="list">${[...d.messages.map((m) => ({ t: m.sent_at || m.created_at, html: `<div class="item"><div class="head"><b>${esc(m.subject)}</b><span>${badge(m.status)} <span class="muted small">${m.kind === 'reply' ? 'reply' : `step ${m.step_number}`} · ${esc(m.generated_by)} · ${fmtTime(m.sent_at || m.created_at)}</span></span></div><pre class="email">${esc(m.body_text)}</pre></div>` })),
        ...d.replies.map((r) => ({ t: r.received_at, html: `<div class="item"><div class="head"><b>Reply from ${esc(r.from_email)}</b><span>${badge(r.classification || 'queued', label(r.classification || 'classifying'))} <span class="muted small">${fmtTime(r.received_at)}</span></span></div><pre class="email">${esc(r.body_text)}</pre></div>` }))]
        .sort((a, b) => String(a.t).localeCompare(String(b.t))).map((x) => x.html).join('') || '<p class="muted">No outreach yet.</p>'}</div></div>`;
  $('#drawer').classList.remove('hidden');
}
actions['contact-verify'] = async (el) => { await api(`/api/contacts/${el.dataset.id}/verify`, { method: 'POST', body: {} }); toast('Verification queued'); setTimeout(() => (el.dataset.lead ? openLead(el.dataset.lead) : renderCurrent()), 1500); };
actions['lead-research'] = async (el) => { await api(`/api/leads/${el.dataset.id}/research`, { method: 'POST', body: {} }); toast('Research brief rebuilt'); openLead(el.dataset.id); };
actions['lead-enrich'] = async (el) => { await api(`/api/leads/${el.dataset.id}/enrich`, { method: 'POST', body: {} }); toast('Re-crawl and re-score queued'); setTimeout(() => openLead(el.dataset.id), 3000); };
forms['contact-add'] = async (d, f) => { await api(`/api/leads/${f.dataset.lead}/contacts`, { method: 'POST', body: d }); toast('Email added; verifying'); setTimeout(() => openLead(f.dataset.lead), 1500); };
forms['lead-update'] = async (d, f) => { await api(`/api/leads/${f.dataset.lead}`, { method: 'PATCH', body: d }); toast('Lead updated'); openLead(f.dataset.lead); renderCurrent(); };
forms.meeting = async (d) => {
  if (!d.email) throw new Error('Choose an email');
  await api('/api/meetings', { method: 'POST', body: { email: d.email, scheduled_for: d.scheduled_for ? new Date(d.scheduled_for).toISOString() : null } });
  toast('Meeting recorded; sequence stopped');
  renderCurrent();
  if (!$('#drawer').classList.contains('hidden')) $('#drawer').classList.add('hidden');
};

// =============== 4. High-Intent Prospects ===============
async function renderIntent(v) {
  const q = state.intentQ;
  const d = await api(`/api/leads?${qs(q)}`);
  v.innerHTML = `<div class="notice info">Prospects with intent ≥ ${esc(q.min_intent)} — scored only from evidence (FMCSA registration date, fleet size, and quoted public statements). 90–100 very high · 70–89 high · 40–69 medium · 0–39 low.</div>
    <div class="card flush">${leadFilters(q, 'intent-filter')}<div style="padding:16px" class="list">
    ${d.leads.length ? d.leads.map((l) => `<div class="item"><div class="head"><div><b class="link" data-act="lead-open" data-id="${l.id}" style="text-decoration:none;cursor:pointer">${esc(l.name)}</b>
      <div class="muted small">${esc([l.city, l.state].filter(Boolean).join(', '))} · ${esc(l.equipment_types.join(', ') || 'equipment unknown')} · ${l.fleet_size ? `${l.fleet_size} truck(s)` : 'fleet unknown'} · ${l.best_email ? `${esc(l.best_email)} ${badge(l.best_email_status)}` : 'no usable email'}</div></div>
      <div class="row"><span class="muted small">Intent</span>${scoreEl(l.intent_score)}<span class="muted small">Lead</span>${scoreEl(l.lead_score)}${badge(l.stage)}</div></div>
      <div class="signals">${l.intent_signals.filter((s) => s.weight > 0).map((s) => `<div class="signal"><b>${esc(s.label || s.signal)}</b> <span class="badge b-good">+${s.weight}</span> <span class="muted">“${esc(s.evidence)}”</span> ${s.source_url ? extLink(s.source_url, 'source') : ''}</div>`).join('')}</div></div>`).join('')
      : `<p class="empty">No prospects at intent ≥ ${esc(q.min_intent)} yet. Lower the minimum or run more discovery.</p>`}
    </div>${pager(d.total, q, 'intent-page')}</div>`;
}
forms['intent-filter'] = async (d, f, s) => { state.intentQ = s?.value === 'reset' ? { min_intent: 70, sort: 'intent_score', limit: 50, offset: 0 } : filterValues(d, { limit: 50 }); renderCurrent(); };
actions['intent-page'] = (el) => { state.intentQ.offset = Math.max(0, Number(state.intentQ.offset) + Number(el.dataset.dir) * 50); renderCurrent(); };

// =============== 5. Email Verification ===============
async function renderVerification(v) {
  const q = state.contactQ;
  const [d, sup] = await Promise.all([api(`/api/contacts?${qs({ ...q, limit: 50 })}`), api('/api/suppressions')]);
  const sum = Object.fromEntries(d.summary.map((r) => [r.status, r.n]));
  const order = meta.verification_statuses;
  v.innerHTML = `
    <div class="stats">${order.map((s) => `<div class="stat"><div class="label">${label(s)}</div><div class="value">${fmtN(sum[s])}</div></div>`).join('')}</div>
    <div class="notice info">Free layers: syntax → suppression list → duplicates → disposable domains (public list, refreshed weekly) → role/system addresses → previous bounces → DNS & MX → SMTP mailbox probe (port 25, no email is sent).
      <b>Verified</b> = the mail server confirmed the mailbox and rejected a random one. <b>Likely valid</b> = the business published the address itself (e.g. FMCSA registration) but the server would not confirm it.
      <b>Risky</b> = catch-all domain. <b>Unknown</b> = no evidence either way. An MX record alone never counts as proof.</div>
    <div class="card flush"><form data-form="contact-filter" class="filters"><div class="form-grid">
      <label>Status<select name="status">${opt('', q.status, 'All')}${order.map((s) => opt(s, q.status)).join('')}</select></label>
      <label>Search<input name="q" value="${esc(q.q)}" placeholder="Email or company"></label>
      <div class="row"><button class="btn primary" type="submit">Filter</button>
        <button class="btn admin-only" type="button" data-act="reverify" data-statuses="risky,unknown,likely_valid,unverified" data-confirm="Re-check all risky, unknown, likely-valid and unverified emails?">Re-check unconfirmed emails</button></div></div></form>
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Company</th><th>Status & reason</th><th>DNS / MX</th><th>Mailbox check</th><th>Found at</th><th>Checked</th><th></th></tr></thead><tbody>
      ${d.contacts.length ? d.contacts.map((c) => { const x = c.verification_detail || {}; return `<tr><td>${esc(c.email)}<div class="sub">${esc(c.contact_type)}${c.is_role ? ' · role' : ''}${x.free_mail ? ' · free mail' : ''}</div></td>
        <td class="click" data-act="lead-open" data-id="${c.company_id}">${esc(c.company_name)}</td><td>${badge(c.verification_status)}<div class="sub">${esc(x.reason || '')}</div></td>
        <td class="small">${x.dns ? (x.dns.mx?.length ? `MX: ${esc(x.dns.mx[0])}` : x.dns.domain_exists ? 'no MX' : esc(x.dns.error || '—')) : '—'}</td>
        <td class="small">${x.smtp ? `SMTP: ${esc(label(x.smtp.result))}${x.smtp.detail ? `<div class="sub">${esc(String(x.smtp.detail).slice(0, 80))}</div>` : ''}` : x.provider ? `${esc(x.provider.provider)}: ${esc(x.provider.raw)}` : '—'}</td>
        <td class="small">${extLink(c.source_url, c.source)}<div class="sub">${fmtDate(c.discovered_at)}</div></td><td class="small">${fmtTime(c.verified_at)}</td>
        <td class="admin-only"><button class="btn sm" data-act="contact-verify" data-id="${c.id}">Re-check</button></td></tr>`; }).join('') : empty('No emails match.', 8)}
      </tbody></table></div>${pager(d.total, { offset: q.offset, limit: 50 }, 'contact-page')}</div>
    <div class="card"><div class="card-head"><h2>Suppression list (${fmtN(sup.suppressions.length)})</h2>
      <form data-form="suppress" class="row admin-only"><input name="email" type="email" placeholder="email@domain.com" required><button class="btn" type="submit">Suppress</button></form></div>
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Source</th><th>Added</th></tr></thead><tbody>
      ${sup.suppressions.length ? sup.suppressions.slice(0, 100).map((s) => `<tr><td>${esc(s.email_normalized)}</td><td>${badge(s.reason === 'unsubscribe' || s.reason === 'bounce' ? 'invalid' : 'suppressed', label(s.reason))}</td><td class="small">${esc(s.source || '')}</td><td class="small">${fmtTime(s.created_at)}</td></tr>`).join('') : empty('No suppressed addresses', 4)}
      </tbody></table></div></div>`;
}
forms['contact-filter'] = async (d) => { state.contactQ = { status: d.status, q: d.q, offset: 0 }; renderCurrent(); };
actions['contact-page'] = (el) => { state.contactQ.offset = Math.max(0, state.contactQ.offset + Number(el.dataset.dir) * 50); renderCurrent(); };
actions.reverify = async (el) => { const r = await api('/api/contacts/reverify', { method: 'POST', body: { statuses: el.dataset.statuses } }); toast(`${r.queued} email(s) queued for re-checking`); };
forms.suppress = async (d, f) => { await api('/api/suppressions', { method: 'POST', body: d }); f.reset(); toast('Address suppressed; any queued emails cancelled'); renderCurrent(); };

// =============== 6. Campaign Management ===============
async function renderCampaigns(v) {
  const [c, m] = await Promise.all([api('/api/campaigns'), api('/api/messages?status=pending_approval&limit=100')]);
  $('#top-actions').innerHTML = '<div class="row admin-only"><button class="btn" data-act="outreach-run">Run outreach now</button><button class="btn primary" data-act="campaign-new">New campaign</button></div>';
  v.innerHTML = `
    ${c.compliance.length ? `<div class="notice warn"><b>Campaigns cannot start until these are set in <a href="#/settings">Settings</a> (CAN-SPAM):</b><ul>${c.compliance.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><div class="card-head"><h2>Campaigns</h2></div><div class="list">
    ${c.campaigns.length ? c.campaigns.map((k) => `<div class="item"><div class="head"><div><b>${esc(k.name)}</b> ${badge(k.status)} ${k.require_approval ? badge('pending_approval', 'manual approval') : badge('active', 'auto-send')}
      <div class="muted small">Segment: ${esc(segmentText(k.segment))} · ${k.steps.map((s) => `Day ${s.day_offset + 1}: ${label(s.purpose)}${s.variant_template_ids?.length ? ' (A/B test)' : ''}`).join(' → ')}</div></div>
      <div class="row admin-only">${k.status !== 'active' && k.status !== 'completed' ? `<button class="btn sm good" data-act="campaign-activate" data-id="${k.id}" data-confirm="Activate and enroll matching verified leads?">Activate</button>` : ''}
        ${k.status === 'active' ? `<button class="btn sm" data-act="campaign-pause" data-id="${k.id}">Pause</button>` : ''}
        <button class="btn sm" data-act="campaign-preview" data-id="${k.id}">Preview audience</button>
        ${k.status !== 'completed' ? `<button class="btn sm" data-act="campaign-edit" data-id="${k.id}">Edit</button><button class="btn sm danger" data-act="campaign-complete" data-id="${k.id}" data-confirm="End this campaign and stop all its sequences?">End</button>` : ''}</div></div>
      <div class="row small" style="margin-top:8px;gap:16px"><span>Enrolled: <b>${fmtN((k.counts.active || 0) + (k.counts.stopped || 0) + (k.counts.completed || 0))}</b></span><span>Active: <b>${fmtN(k.counts.active)}</b></span>
        <span>Sent: <b>${fmtN(k.messages.sent)}</b></span><span>Awaiting approval: <b>${fmtN(k.messages.pending_approval)}</b></span><span>Bounced: <b>${fmtN(k.messages.bounced)}</b></span><span>Replies: <b>${fmtN(k.replies)}</b></span></div></div>`).join('')
      : '<p class="muted">No campaigns yet. Create one to start outreach to qualified, verified leads.</p>'}</div></div>
    <div class="card"><div class="card-head"><h2>Approval queue (${fmtN(m.messages.length)})</h2>
      ${m.messages.length ? '<div class="row admin-only"><label class="row" style="color:var(--ink)"><input type="checkbox" data-act="select-all"> Select all</label><button class="btn good" data-act="approve-selected">Approve selected</button></div>' : ''}</div>
      <div class="list">${m.messages.length ? m.messages.map(messageEditor).join('') : '<p class="muted">Nothing waiting. New emails appear here before they are sent when a campaign requires approval.</p>'}</div></div>`;
}
function segmentText(s) {
  const p = [];
  if (s.states?.length) p.push(s.states.join('/'));
  if (s.equipment?.length) p.push(s.equipment.join('/'));
  if (s.categories?.length) p.push(s.categories.join('/'));
  if (s.min_lead_score) p.push(`lead ≥ ${s.min_lead_score}`);
  if (s.min_intent) p.push(`intent ≥ ${s.min_intent}`);
  if (s.max_fleet) p.push(`fleet ≤ ${s.max_fleet}`);
  if (s.limit) p.push(`max ${s.limit}`);
  return p.join(', ') || 'all qualified leads';
}
function messageEditor(m) {
  return `<form class="item" data-form="message-save" data-id="${m.id}"><div class="head"><div><label class="row admin-only" style="color:var(--ink);display:inline-flex"><input type="checkbox" class="msg-select" value="${m.id}"></label>
    <b>${esc(m.company_name || m.to_email)}</b> → ${esc(m.to_email)} <span class="muted small">${m.kind === 'reply' ? 'reply to prospect' : `step ${m.step_number}`} · written by ${esc(m.generated_by)}${m.intent_score != null ? ` · intent ${m.intent_score}` : ''}</span></div>
    <div class="row admin-only"><button class="btn sm" type="submit">Save edits</button><button class="btn sm good" type="button" data-act="message-approve" data-id="${m.id}">Approve</button>
    <button class="btn sm danger" type="button" data-act="message-reject" data-id="${m.id}" data-confirm="Reject this email? For sequence emails this stops the prospect's sequence.">Reject</button></div></div>
    <label style="margin-top:8px">Subject<input name="subject" value="${esc(m.subject)}"></label><label style="margin-top:6px">Body (sender address and unsubscribe link are appended automatically)<textarea name="body_text" rows="${Math.min(22, String(m.body_text).split('\n').length + 3)}">${esc(m.body_text)}</textarea></label>
    ${m.personalization_facts?.length ? `<div class="muted small" style="margin-top:6px">Facts used: ${m.personalization_facts.map((f) => `${esc(label(f.key))}: ${esc(f.value)}`).join(' · ')}</div>` : ''}</form>`;
}
forms['message-save'] = async (d, f) => { await api(`/api/messages/${f.dataset.id}`, { method: 'PUT', body: d }); toast('Saved'); };
actions['message-approve'] = async (el) => {
  const f = el.closest('form');
  if (f) await api(`/api/messages/${el.dataset.id}`, { method: 'PUT', body: formData(f) });
  await api(`/api/messages/${el.dataset.id}/approve`, { method: 'POST', body: {} });
  toast('Approved. It will be sent within the send window.');
  renderCurrent();
};
actions['message-reject'] = async (el) => { await api(`/api/messages/${el.dataset.id}/reject`, { method: 'POST', body: {} }); toast('Rejected'); renderCurrent(); };
actions['select-all'] = (el) => { $$('.msg-select').forEach((c) => { c.checked = el.checked; }); };
actions['approve-selected'] = async () => {
  const ids = $$('.msg-select').filter((c) => c.checked).map((c) => Number(c.value));
  if (!ids.length) throw new Error('Select at least one email');
  const r = await api('/api/messages/approve-all', { method: 'POST', body: { ids } });
  toast(`${r.approved} email(s) approved`);
  renderCurrent();
};
actions['outreach-run'] = async () => {
  const outside = confirm('Run the Outreach Agent now?\n\nOK = also send outside the configured send window\nCancel = respect the send window');
  const r = await api('/api/outreach/run', { method: 'POST', body: { ignoreWindow: outside } });
  toast(r.skipped ? `Skipped: ${r.skipped}` : `Generated ${r.generated || 0}, sent ${r.sent || 0}${r.reason ? ` (${r.reason})` : ''}`);
  renderCurrent();
};
actions['campaign-activate'] = async (el) => { const r = await api(`/api/campaigns/${el.dataset.id}/activate`, { method: 'POST', body: {} }); toast(`Activated: ${r.enrolled} lead(s) enrolled`); renderCurrent(); };
actions['campaign-pause'] = async (el) => { await api(`/api/campaigns/${el.dataset.id}/pause`, { method: 'POST', body: {} }); toast('Paused'); renderCurrent(); };
actions['campaign-complete'] = async (el) => { await api(`/api/campaigns/${el.dataset.id}/complete`, { method: 'POST', body: {} }); toast('Campaign ended'); renderCurrent(); };
actions['campaign-preview'] = async (el) => {
  const p = await api(`/api/campaigns/${el.dataset.id}/preview`);
  openModal('Campaign audience preview', `<p><b>${fmtN(p.count)}</b> lead(s) would be enrolled now.</p>
    ${Object.keys(p.skipped).length ? `<div class="notice info">Skipped: ${Object.entries(p.skipped).map(([k, n]) => `${esc(k)} (${n})`).join(', ')}</div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Company</th><th>Email</th><th>Intent</th><th>Lead</th></tr></thead><tbody>
    ${p.sample.length ? p.sample.map((s) => `<tr><td>${esc(s.name)} <span class="muted small">${esc(s.state || '')}</span></td><td>${esc(s.email)} ${badge(s.status)}</td><td>${scoreEl(s.intent_score)}</td><td>${scoreEl(s.lead_score)}</td></tr>`).join('') : empty('No eligible leads', 4)}</tbody></table></div>`);
};
actions['campaign-new'] = () => campaignForm(null);
actions['campaign-edit'] = async (el) => campaignForm((await api(`/api/campaigns/${el.dataset.id}`)).campaign);
async function campaignForm(k) {
  const [acc, tpl] = await Promise.all([api('/api/accounts'), api('/api/templates')]);
  const s = k?.segment || {};
  const steps = k?.steps?.length ? k.steps : [{ purpose: 'intro', day_offset: 0 }, { purpose: 'followup', day_offset: 2 }, { purpose: 'benefits', day_offset: 5 }, { purpose: 'final', day_offset: 9 }];
  const seqTpl = tpl.templates.filter((t) => !t.purpose.startsWith('reply'));
  const tplOpts = (cur, none) => opt('', cur, none) + seqTpl.map((t) => opt(t.id, cur, `${t.name} (${t.purpose})`)).join('');
  const stepRow = (st) => `<div class="form-grid step-row"><label>Send on day<input type="number" min="1" name="step_day" value="${Number(st.day_offset) + 1}"></label>
    <label>Purpose<select name="step_purpose">${['intro', 'followup', 'benefits', 'final'].map((p) => opt(p, st.purpose)).join('')}</select></label>
    <label>Template (variant A)<select name="step_template">${tplOpts(st.template_id, 'Default for purpose')}</select></label>
    <label>A/B test: variant B<select name="step_variant">${tplOpts((st.variant_template_ids || [])[0], 'No experiment')}</select></label>
    <div><button class="btn sm danger" type="button" data-act="step-remove">Remove</button></div></div>`;
  openModal(k ? `Edit campaign: ${k.name}` : 'New campaign', `<form data-form="campaign-save" data-id="${k?.id || ''}" class="grid" style="gap:14px">
    <label>Campaign name<input name="name" required value="${esc(k?.name || '')}" placeholder="TX new authorities — dry van"></label>
    <h3>Audience (only verified emails are enrolled; likely-valid and risky only if allowed in Settings)</h3>
    <div class="form-grid"><label>States (comma)<input name="states" value="${esc((s.states || []).join(', '))}"></label>
      <label>Min lead score<input type="number" name="min_lead_score" min="0" max="100" value="${esc(s.min_lead_score ?? '')}" placeholder="from Settings"></label>
      <label>Min intent<input type="number" name="min_intent" min="0" max="100" value="${esc(s.min_intent ?? '')}"></label>
      <label>Max fleet<input type="number" name="max_fleet" min="1" value="${esc(s.max_fleet ?? '')}"></label>
      <label>Max leads to enroll<input type="number" name="limit" min="1" value="${esc(s.limit ?? '')}"></label></div>
    <div><div class="muted small">Equipment</div>${checks('equipment', meta.equipment, s.equipment || [])}</div>
    <div><div class="muted small">Categories</div>${checks('categories', meta.categories, s.categories || [])}</div>
    <h3>Sequence (stops automatically on reply, unsubscribe, bounce, meeting or client)</h3>
    <div id="steps" class="grid" style="gap:8px">${steps.map(stepRow).join('')}</div>
    <div><button class="btn sm" type="button" data-act="step-add">Add step</button></div>
    <template id="step-tpl">${stepRow({ purpose: 'followup', day_offset: 13 })}</template>
    <h3>Sending</h3>
    <div>${acc.accounts.length ? checks('sending_account_ids', acc.accounts.map((a) => String(a.id)), (k?.sending_account_ids || []).map(String)).replace(/> (\d+)<\/label>/g, (m0, id) => `> ${esc(acc.accounts.find((a) => String(a.id) === id)?.from_email)}</label>`) : '<p class="muted">No sending accounts yet. Add one in <a href="#/accounts">Sending Accounts</a>.</p>'}
      <div class="muted small">None selected = rotate across all enabled accounts, each within its own limits.</div></div>
    <label class="row" style="color:var(--ink)"><input type="checkbox" name="require_approval" data-bool ${k?.require_approval === 0 ? '' : 'checked'}> Require manual approval of every email before it is sent</label>
    <div class="row"><button class="btn primary" type="submit">${k ? 'Save campaign' : 'Create campaign'}</button></div></form>`);
}
actions['step-add'] = () => $('#steps').insertAdjacentHTML('beforeend', $('#step-tpl').innerHTML);
actions['step-remove'] = (el) => { if ($$('.step-row', $('#steps')).length > 1) el.closest('.step-row').remove(); };
forms['campaign-save'] = async (d, f) => {
  const steps = $$('.step-row', f).map((r) => ({ day_offset: Math.max(0, Number($('[name=step_day]', r).value) - 1), purpose: $('[name=step_purpose]', r).value, template_id: $('[name=step_template]', r).value || null,
    variant_template_ids: [$('[name=step_variant]', r).value].filter(Boolean) }))
    .sort((a, b) => a.day_offset - b.day_offset);
  const segment = { states: csv(d.states).map((x) => x.toUpperCase()), equipment: d.equipment, categories: d.categories, min_lead_score: d.min_lead_score, min_intent: d.min_intent, max_fleet: d.max_fleet, limit: d.limit };
  const body = { name: d.name, segment, steps, require_approval: d.require_approval, sending_account_ids: (d.sending_account_ids || []).map(Number) };
  if (f.dataset.id) await api(`/api/campaigns/${f.dataset.id}`, { method: 'PUT', body });
  else await api('/api/campaigns', { method: 'POST', body });
  closeModal();
  toast('Campaign saved');
  renderCurrent();
};

// =============== 7. Email Templates ===============
const PLACEHOLDERS = ['greeting', 'first_name', 'company', 'city', 'state', 'location', 'equipment', 'fleet_phrase', 'authority_line', 'intent_line', 'sender_name', 'sender_company', 'calendly_line', 'calendly_url', 'services', 'pricing', 'original_subject'];
async function renderTemplates(v) {
  const d = await api('/api/templates');
  $('#top-actions').innerHTML = '<button class="btn primary admin-only" data-act="template-new">New template</button>';
  v.innerHTML = `<div class="notice info">Templates are the base for every email. With a free local AI model (Ollama) configured, the Personalization Agent rewrites each email from verified facts only and falls back to the rendered template if the AI output invents claims, numbers, guarantees or links. Placeholders: ${PLACEHOLDERS.map((p) => `<code>{{${p}}}</code>`).join(' ')}</div>
    <div class="grid g2">${d.templates.map((t) => `<div class="card"><div class="card-head"><div><b>${esc(t.name)}</b> ${badge('new', label(t.purpose))}</div>
      <div class="row admin-only"><button class="btn sm" data-act="template-edit" data-id="${t.id}">Edit</button><button class="btn sm danger" data-act="template-delete" data-id="${t.id}" data-confirm="Delete this template?">Delete</button></div></div>
      <div class="small"><b>Subject:</b> ${esc(t.subject)}</div><pre class="email">${esc(t.body)}</pre>${t.ai_guidance ? `<div class="muted small">AI guidance: ${esc(t.ai_guidance)}</div>` : ''}</div>`).join('')}</div>`;
  state.templates = d.templates;
}
function templateForm(t) {
  openModal(t ? `Edit template: ${t.name}` : 'New template', `<form data-form="template-save" data-id="${t?.id || ''}" class="grid" style="gap:12px">
    <div class="form-grid"><label>Name<input name="name" required value="${esc(t?.name || '')}"></label>
    <label>Purpose<select name="purpose">${['intro', 'followup', 'benefits', 'final', 'reply_interested', 'reply_pricing', 'reply_info'].map((p) => opt(p, t?.purpose || 'intro')).join('')}</select></label></div>
    <label>Subject<input name="subject" required value="${esc(t?.subject || '')}"></label>
    <label>Body<textarea name="body" rows="12" required>${esc(t?.body || '')}</textarea></label>
    <label>Extra guidance for the AI writer (optional)<input name="ai_guidance" value="${esc(t?.ai_guidance || '')}" placeholder="e.g. mention we work nights and weekends"></label>
    <div><button class="btn primary" type="submit">Save template</button></div></form>`);
}
actions['template-new'] = () => templateForm(null);
actions['template-edit'] = (el) => templateForm(state.templates.find((t) => String(t.id) === el.dataset.id));
actions['template-delete'] = async (el) => { await api(`/api/templates/${el.dataset.id}`, { method: 'DELETE', body: {} }); toast('Deleted'); renderCurrent(); };
forms['template-save'] = async (d, f) => {
  if (f.dataset.id) await api(`/api/templates/${f.dataset.id}`, { method: 'PUT', body: d });
  else await api('/api/templates', { method: 'POST', body: d });
  closeModal();
  toast('Template saved');
  renderCurrent();
};

// =============== 8. Follow-Up Management ===============
async function renderFollowups(v) {
  const q = state.enrollQ;
  const [d, sent] = await Promise.all([api(`/api/enrollments?${qs(q)}`), api('/api/messages?kind=sequence&limit=50')]);
  v.innerHTML = `
    <div class="stats"><div class="stat"><div class="label">Active sequences</div><div class="value">${fmtN(d.counts.active)}</div></div>
      <div class="stat"><div class="label">Due in next 24h</div><div class="value">${fmtN(d.due_today)}</div></div>
      <div class="stat"><div class="label">Stopped</div><div class="value">${fmtN(d.counts.stopped)}</div></div>
      <div class="stat"><div class="label">Completed</div><div class="value">${fmtN(d.counts.completed)}</div></div></div>
    <div class="card flush"><div class="filters row"><span class="muted small">Show</span>${['active', 'stopped', 'completed', ''].map((s) => `<button class="btn sm ${q.status === s ? 'primary' : ''}" data-act="enroll-filter" data-status="${s}">${s ? label(s) : 'All'}</button>`).join('')}</div>
      <div class="table-wrap"><table><thead><tr><th>Prospect</th><th>Campaign</th><th>Progress</th><th>Status</th><th>Next send</th><th></th></tr></thead><tbody>
      ${d.enrollments.length ? d.enrollments.map((e) => `<tr><td class="click" data-act="lead-open" data-id="${e.company_id}"><b>${esc(e.company_name)}</b><div class="sub">${esc(e.email)}</div></td><td>${esc(e.campaign_name)}</td>
        <td><div class="progress"><i style="width:${(100 * e.current_step) / Math.max(1, e.total_steps)}%"></i></div><div class="sub">${e.current_step}/${e.total_steps} sent</div></td>
        <td>${badge(e.status)}${e.stop_reason ? `<div class="sub">${esc(e.stop_reason)}</div>` : ''}</td><td class="small">${e.status === 'active' ? fmtTime(e.next_send_at) : '—'}</td>
        <td class="admin-only">${e.status === 'active' ? `<button class="btn sm danger" data-act="enroll-stop" data-id="${e.id}" data-confirm="Stop this prospect's sequence?">Stop</button>` : ''}</td></tr>`).join('') : empty('No sequences in this state.', 6)}
      </tbody></table></div></div>
    <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Recent sequence emails</h2></div><div class="table-wrap"><table>
      <thead><tr><th>To</th><th>Step</th><th>Subject</th><th>Status</th><th>Sent / created</th></tr></thead><tbody>
      ${sent.messages.length ? sent.messages.map((m) => `<tr><td>${esc(m.company_name)}<div class="sub">${esc(m.to_email)}</div></td><td>${m.step_number}</td><td>${esc(m.subject)}<div class="sub">${esc(m.generated_by)}${m.error ? ` · ${esc(m.error)}` : ''}</div></td><td>${badge(m.status)}</td><td class="small">${fmtTime(m.sent_at || m.created_at)}</td></tr>`).join('') : empty('No sequence emails yet.', 5)}
      </tbody></table></div></div>`;
}
actions['enroll-filter'] = (el) => { state.enrollQ.status = el.dataset.status; renderCurrent(); };
actions['enroll-stop'] = async (el) => { await api(`/api/enrollments/${el.dataset.id}/stop`, { method: 'POST', body: {} }); toast('Sequence stopped'); renderCurrent(); };

// =============== 9. AI Reply Management ===============
async function renderReplies(v) {
  const q = state.replyQ;
  const [d, drafts, mt] = await Promise.all([api(`/api/replies?${qs(q)}`), api('/api/messages?kind=reply&limit=200'), api('/api/meetings')]);
  const draftBy = {};
  for (const m of drafts.messages) if (!draftBy[m.reply_id]) draftBy[m.reply_id] = m;
  const cats = meta.reply_categories;
  v.innerHTML = `
    <div class="stats">${cats.map((c) => `<div class="stat"><div class="label">${label(c)}</div><div class="value">${fmtN(d.counts[c])}</div></div>`).join('')}</div>
    <div class="card"><div class="card-head"><h2>Replies</h2><form data-form="reply-filter" class="row"><select name="classification">${opt('', q.classification, 'All categories')}${cats.map((c) => opt(c, q.classification)).join('')}</select>
      <label class="row" style="color:var(--ink)"><input type="checkbox" name="needs_admin" value="1" ${q.needs_admin ? 'checked' : ''}> Needs my attention</label><button class="btn" type="submit">Filter</button></form></div>
      <div class="list">${d.replies.length ? d.replies.map((r) => { const dr = draftBy[r.id]; return `<div class="item"><div class="head"><div><b class="link" data-act="lead-open" data-id="${r.company_id}" style="text-decoration:none;cursor:pointer">${esc(r.company_name || r.from_email)}</b> <span class="muted small">${esc(r.from_email)} · ${fmtTime(r.received_at)} · re: ${esc(r.original_subject || r.subject || '')}</span></div>
        <div class="row">${badge(r.classification || 'queued', label(r.classification || 'classifying…'))}${r.confidence != null ? `<span class="muted small">${Math.round(r.confidence * 100)}% · ${esc(r.classifier)}</span>` : ''}${r.needs_admin && !r.handled ? badge('invalid', 'needs review') : ''}${r.handled ? badge('done', 'handled') : ''}</div></div>
        <div class="quote">${esc(r.latest_text || r.body_text)}</div>
        ${r.reasoning ? `<div class="muted small">Why: ${esc(r.reasoning)}${r.admin_reason ? ` · Review reason: ${esc(r.admin_reason)}` : ''}</div>` : ''}
        ${dr ? `<div style="margin-top:10px"><div class="row"><b class="small">Conversion Agent draft</b> ${badge(dr.status)}</div>${dr.status === 'pending_approval' ? messageEditor(dr) : `<pre class="email">${esc(dr.body_text)}</pre>`}</div>` : ''}
        <div class="row admin-only" style="margin-top:10px"><select class="reclass">${cats.map((c) => opt(c, r.classification)).join('')}</select><button class="btn sm" data-act="reply-reclass" data-id="${r.id}">Set category</button>
          <button class="btn sm" data-act="reply-rerun" data-id="${r.id}">Re-classify with AI</button>
          ${!dr || ['rejected', 'cancelled'].includes(dr.status) ? `<button class="btn sm" data-act="reply-draft" data-id="${r.id}">Draft a reply</button>` : ''}
          ${!r.handled ? `<button class="btn sm" data-act="reply-handled" data-id="${r.id}">Mark handled</button>` : ''}
          <button class="btn sm" data-act="reply-meeting" data-email="${esc(r.from_email)}">Meeting booked</button></div></div>`; }).join('')
        : '<p class="muted">No replies yet. Replies are read from each sending account\'s IMAP inbox (every 2 minutes) or the inbound webhook.</p>'}</div></div>
    <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Meetings booked (${fmtN(mt.meetings.length)})</h2></div><div class="table-wrap"><table>
      <thead><tr><th>Prospect</th><th>Email</th><th>Scheduled for</th><th>Source</th><th>Recorded</th></tr></thead><tbody>
      ${mt.meetings.length ? mt.meetings.map((m) => `<tr><td>${esc(m.company_name || '—')}</td><td>${esc(m.email)}</td><td>${fmtTime(m.scheduled_for)}</td><td>${esc(m.source)}</td><td class="small">${fmtTime(m.created_at)}</td></tr>`).join('') : empty('No meetings yet. Calendly bookings arrive automatically when the webhook is configured.', 5)}
      </tbody></table></div></div>`;
}
forms['reply-filter'] = async (d) => { state.replyQ = { classification: d.classification, needs_admin: d.needs_admin ? '1' : '' }; renderCurrent(); };
actions['reply-reclass'] = async (el) => { const c = el.parentElement.querySelector('.reclass').value; await api(`/api/replies/${el.dataset.id}/classify`, { method: 'POST', body: { classification: c } }); toast(`Set to ${label(c)}`); renderCurrent(); };
actions['reply-rerun'] = async (el) => { const r = await api(`/api/replies/${el.dataset.id}/classify`, { method: 'POST', body: {} }); toast(`Classified as ${label(r.classification)}`); renderCurrent(); };
actions['reply-draft'] = async (el) => { await api(`/api/replies/${el.dataset.id}/draft`, { method: 'POST', body: {} }); toast('Draft created'); renderCurrent(); };
actions['reply-handled'] = async (el) => { await api(`/api/replies/${el.dataset.id}/handled`, { method: 'POST', body: {} }); renderCurrent(); };
actions['reply-meeting'] = async (el) => { await api('/api/meetings', { method: 'POST', body: { email: el.dataset.email } }); toast('Meeting recorded'); renderCurrent(); };

// =============== 10. Analytics ===============
async function renderAnalytics(v) {
  const d = await api('/api/analytics?days=30');
  const b = d.breakdowns;
  const s = d.stats;
  const rate = (a, n) => (n ? `${Math.round((1000 * a) / n) / 10}%` : '—');
  const funnel = (rows, title) => `<div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>${title}</h2></div><div class="table-wrap"><table>
    <thead><tr><th></th><th>Leads</th><th>Qualified</th><th>Contacted</th><th>Replied</th><th>Positive</th><th>Clients</th><th>Positive rate</th></tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr><td><b>${esc(label(r.k))}</b></td><td>${fmtN(r.leads)}</td><td>${fmtN(r.qualified)}</td><td>${fmtN(r.contacted)}</td><td>${fmtN(r.replied)}</td><td>${fmtN(r.positive)}</td><td>${fmtN(r.clients)}</td><td>${r.contacted >= 20 ? rate(r.positive, r.contacted) : `<span class="muted small">${r.contacted ? 'not enough data' : '—'}</span>`}</td></tr>`).join('') : empty('No data yet', 8)}
    </tbody></table></div></div>`;
  $('#top-actions').innerHTML = '<button class="btn admin-only" data-act="analytics-refresh">Refresh insights</button>';
  v.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="label">Reply rate</div><div class="value">${rate(s.replies, s.emails_sent)}</div></div>
      <div class="stat"><div class="label">Positive reply rate</div><div class="value">${rate(s.positive_replies, s.emails_sent)}</div></div>
      <div class="stat"><div class="label">Bounce rate</div><div class="value">${rate(s.emails_bounced, s.emails_sent)}</div></div>
      <div class="stat"><div class="label">Unsubscribe rate</div><div class="value">${rate(s.unsubscribes, s.emails_sent)}</div></div>
      <div class="stat"><div class="label">Meetings / positive</div><div class="value">${rate(s.meetings, s.positive_replies)}</div></div>
      <div class="stat"><div class="label">Clients / meetings</div><div class="value">${rate(s.clients, s.meetings)}</div></div></div>
    <div class="grid g2"><div class="card"><h2>Activity, last 30 days</h2>${barChart(d.series)}</div>
      <div class="card"><div class="card-head"><h2>Feedback loop: what is working</h2><span class="muted small">${fmtTime(d.insights.created_at)}</span></div><div class="list">${d.insights.insights.map((i) => `<div class="item">${esc(i)}</div>`).join('')}</div></div></div>
    <div class="grid g3"><div class="card"><h2>Pipeline stages</h2>${hbars(b.stages, 'n')}</div><div class="card"><h2>Reply categories</h2>${hbars(b.replies_by_class, 'n')}</div><div class="card"><h2>Email verification</h2>${hbars(b.verification, 'n')}</div></div>
    ${funnel(b.by_source, 'By discovery source')}${funnel(b.by_intent_band, 'By intent band')}
    ${funnel(b.by_category, 'By prospect category')}${funnel(b.by_equipment, 'By equipment')}
    ${funnel(b.by_state, 'By state')}${funnel(b.by_signal, 'By buying-intent signal')}
    <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>A/B experiments</h2><span class="muted small">A winner needs at least 20 sends per variant; "conservative rate" is the 95% Wilson lower bound</span></div><div class="table-wrap"><table>
      <thead><tr><th>Campaign</th><th>Step</th><th>Variant</th><th>Template</th><th>Sent</th><th>Replied</th><th>Positive</th><th>Conservative positive rate</th></tr></thead><tbody>
      ${b.by_variant.length ? b.by_variant.map((r) => `<tr><td>${esc(r.campaign || `#${r.campaign_id}`)}</td><td>${r.step}</td><td><b>${esc(r.variant)}</b></td><td>${esc(r.template || '—')}</td><td>${r.sent}</td><td>${r.replied}</td><td>${r.positive}</td>
        <td>${r.enough_data ? `${r.positive_lower}%` : `<span class="muted small">not enough data (${r.sent}/20)</span>`}</td></tr>`).join('') : empty('No experiments yet. Pick a "variant B" template on a campaign step to start one.', 8)}
    </tbody></table></div></div>
    <div class="grid g2"><div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Subject lines</h2></div><div class="table-wrap"><table><thead><tr><th>Subject</th><th>Sent</th><th>Replied</th><th>Positive</th></tr></thead><tbody>
      ${b.by_subject.length ? b.by_subject.map((r) => `<tr><td>${esc(r.k)}</td><td>${r.sent}</td><td>${r.replied} <span class="muted small">${rate(r.replied, r.sent)}</span></td><td>${r.positive}</td></tr>`).join('') : empty('No emails sent yet', 4)}</tbody></table></div></div>
      <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Sequence steps & writer</h2></div><div class="table-wrap"><table><thead><tr><th>Step</th><th>Writer</th><th>Sent</th><th>Replied</th><th>Positive</th></tr></thead><tbody>
      ${b.by_step.length ? b.by_step.map((r) => `<tr><td>${r.k}</td><td>${esc(r.writer)}</td><td>${r.sent}</td><td>${r.replied} <span class="muted small">${rate(r.replied, r.sent)}</span></td><td>${r.positive}</td></tr>`).join('') : empty('No emails sent yet', 5)}</tbody></table></div></div></div>`;
}
actions['analytics-refresh'] = async () => { await api('/api/analytics/refresh', { method: 'POST', body: {} }); toast('Insights refreshed'); renderCurrent(); };

// =============== 11. Sending Accounts ===============
async function renderAccounts(v) {
  const d = await api('/api/accounts');
  state.accounts = d.accounts;
  $('#top-actions').innerHTML = '<button class="btn primary admin-only" data-act="account-new">Add sending account</button>';
  v.innerHTML = `<div class="notice info">Use your own business mailboxes (Google Workspace, Microsoft 365, or any SMTP provider). Rotation only spreads volume across these accounts and always stays inside each account's daily and hourly limits; it never bypasses provider limits. Keep new mailboxes at 20–40 emails/day while they warm up. Passwords are encrypted at rest and never sent back to the browser.</div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Account</th><th>SMTP</th><th>Inbox (IMAP)</th><th>Sent today / limit</th><th>This hour / limit</th><th>Health</th><th></th></tr></thead><tbody>
    ${d.accounts.length ? d.accounts.map((a) => `<tr><td><b>${esc(a.name)}</b><div class="sub">${esc(a.from_name)} &lt;${esc(a.from_email)}&gt;</div>${a.enabled ? '' : badge('paused', 'disabled')}</td>
      <td class="small">${esc(a.smtp_host)}:${a.smtp_port}${a.smtp_secure ? ' (TLS)' : ''}</td><td class="small">${a.imap_host ? `${esc(a.imap_host)}:${a.imap_port}<div class="sub">last check ${fmtTime(a.last_checked_at)}</div>` : '<span class="muted">not set — replies not read</span>'}</td>
      <td>${a.usage.day} / ${a.daily_limit}</td><td>${a.usage.hour} / ${a.hourly_limit}</td><td>${badge(a.health_status)}${a.last_error ? `<div class="sub error">${esc(a.last_error)}</div>` : ''}</td>
      <td class="row admin-only"><button class="btn sm" data-act="account-test" data-id="${a.id}">Test SMTP</button><button class="btn sm" data-act="account-edit" data-id="${a.id}">Edit</button>
      <button class="btn sm danger" data-act="account-delete" data-id="${a.id}" data-confirm="Remove this account? (Accounts with sent history are disabled instead.)">Remove</button></td></tr>`).join('') : empty('No sending accounts yet.', 7)}
    </tbody></table></div></div>`;
}
function accountForm(a) {
  openModal(a ? `Edit ${a.from_email}` : 'Add sending account', `<form data-form="account-save" data-id="${a?.id || ''}" class="form-grid">
    <label>Label<input name="name" required value="${esc(a?.name || '')}" placeholder="Main mailbox"></label>
    <label>From name<input name="from_name" required value="${esc(a?.from_name || '')}"></label>
    <label>From email<input name="from_email" type="email" required value="${esc(a?.from_email || '')}"></label>
    <label>SMTP host<input name="smtp_host" required value="${esc(a?.smtp_host || '')}" placeholder="smtp.gmail.com"></label>
    <label>SMTP port<input name="smtp_port" type="number" value="${esc(a?.smtp_port || 587)}"></label>
    <label class="row" style="color:var(--ink)"><input type="checkbox" name="smtp_secure" data-bool ${a?.smtp_secure ? 'checked' : ''}> Implicit TLS (port 465)</label>
    <label>SMTP username<input name="smtp_user" required value="${esc(a?.smtp_user || '')}"></label>
    <label>SMTP password / app password<input name="smtp_pass" type="password" autocomplete="new-password" ${a ? 'placeholder="unchanged"' : 'required'}></label>
    <label>IMAP host (to read replies)<input name="imap_host" value="${esc(a?.imap_host || '')}" placeholder="imap.gmail.com"></label>
    <label>IMAP port<input name="imap_port" type="number" value="${esc(a?.imap_port || 993)}"></label>
    <label class="row" style="color:var(--ink)"><input type="checkbox" name="imap_secure" data-bool ${a?.imap_secure === 0 ? '' : 'checked'}> IMAP TLS</label>
    <label>IMAP user (blank = SMTP user)<input name="imap_user" value="${esc(a?.imap_user || '')}"></label>
    <label>IMAP password (blank = SMTP password)<input name="imap_pass" type="password" autocomplete="new-password" placeholder="${a?.has_imap_password ? 'unchanged' : ''}"></label>
    <label>Daily limit<input name="daily_limit" type="number" min="1" value="${esc(a?.daily_limit || 40)}"></label>
    <label>Hourly limit<input name="hourly_limit" type="number" min="1" value="${esc(a?.hourly_limit || 10)}"></label>
    <label class="row" style="color:var(--ink)"><input type="checkbox" name="enabled" data-bool ${a?.enabled === 0 ? '' : 'checked'}> Enabled</label>
    <div class="full"><button class="btn primary" type="submit">Save account</button></div></form>`);
}
actions['account-new'] = () => accountForm(null);
actions['account-edit'] = (el) => accountForm(state.accounts.find((a) => String(a.id) === el.dataset.id));
actions['account-test'] = async (el) => { const r = await api(`/api/accounts/${el.dataset.id}/test`, { method: 'POST', body: {} }); toast(r.ok ? 'SMTP connection works' : `SMTP failed: ${r.error}`, !r.ok); renderCurrent(); };
actions['account-delete'] = async (el) => { await api(`/api/accounts/${el.dataset.id}`, { method: 'DELETE', body: {} }); toast('Removed'); renderCurrent(); };
forms['account-save'] = async (d, f) => {
  if (f.dataset.id) await api(`/api/accounts/${f.dataset.id}`, { method: 'PUT', body: d });
  else await api('/api/accounts', { method: 'POST', body: d });
  closeModal();
  toast('Account saved. Use "Test SMTP" to check it.');
  renderCurrent();
};

// =============== 12. Settings ===============
// [key, name, how to enable, cost]
const INTEGRATIONS = [
  ['fmcsaAuthority', 'FMCSA Operating Authority (daily)', 'public, always on', 'free'], ['fmcsaCensus', 'FMCSA Company Census', 'public, always on', 'free'],
  ['smtpProbe', 'SMTP mailbox probe (port 25)', 'on by default; SMTP_PROBE=0 turns it off', 'free'],
  ['llm', 'Local AI model (Ollama)', 'LLM_BASE_URL=http://localhost:11434/v1, LLM_MODEL', 'free'],
  ['googleCse', 'Google Programmable Search', 'GOOGLE_CSE_KEY, GOOGLE_CSE_CX', 'free_tier'], ['brave', 'Brave Search', 'BRAVE_SEARCH_KEY', 'free_tier'],
  ['reddit', 'Reddit API', 'REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET', 'free_tier'],
  ['inboundWebhook', 'Inbound email webhook', 'INBOUND_WEBHOOK_SECRET', 'free'], ['calendlyWebhook', 'Calendly webhook (optional)', 'CALENDLY_WEBHOOK_SIGNING_KEY', 'paid'],
];
async function renderSettings(v) {
  const [d, au, jb] = await Promise.all([api('/api/settings'), api('/api/audit?limit=40'), api('/api/jobs')]);
  const users = me.role === 'admin' ? (await api('/api/users')).users : [];
  const s = d.settings;
  const i = d.integrations;
  const txt = (k, l, ph = '') => `<label>${l}<input name="${k}" value="${esc(s[k])}" placeholder="${esc(ph)}"></label>`;
  const num = (k, l) => `<label>${l}<input type="number" name="${k}" value="${esc(s[k])}"></label>`;
  const bool = (k, l) => `<label class="row" style="color:var(--ink);grid-column:span 2"><input type="checkbox" name="${k}" data-bool ${s[k] ? 'checked' : ''}> ${l}</label>`;
  v.innerHTML = `
    ${d.compliance.length ? `<div class="notice warn"><b>Required before any email can be sent:</b><ul>${d.compliance.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <form data-form="settings" class="card grid" style="gap:16px"><h2>Sender identity & compliance (CAN-SPAM)</h2>
      <div class="form-grid">${txt('sender_company_name', 'Business name *')}${txt('sender_person_name', 'Your name *')}${txt('reply_to_email', 'Reply-to email', 'optional')}${txt('admin_notify_email', 'Admin notification email')}
      <label class="full">Physical postal address * (shown in every email)<input name="postal_address" value="${esc(s.postal_address)}" placeholder="123 Main St, Suite 4, Dallas, TX 75201"></label>
      ${txt('allowed_outreach_countries', 'Allowed outreach countries (ISO codes)', 'US')}</div>
      <p class="muted small">Every email includes your identity, postal address, a working one-click unsubscribe link and List-Unsubscribe headers. Unsubscribes, bounces and "not interested" replies are suppressed permanently. Leads outside the allowed countries are only contacted when you record a lawful basis on the lead.</p>
      <h2>Offer & conversion</h2>
      <div class="form-grid">${txt('calendly_url', 'Calendly booking link', 'calendly.com/you/intro')}
      <label class="full">Services description (used in replies)<textarea name="services_description">${esc(s.services_description)}</textarea></label>
      ${bool('pricing_enabled', 'Share pricing in replies')}<label class="full">Pricing text (only shared when enabled)<input name="pricing_text" value="${esc(s.pricing_text)}" placeholder="Our fee is a flat percentage of each load's gross rate, with no contracts."></label>
      ${bool('auto_reply_enabled', 'Send AI replies to interested prospects without approval')}</div>
      <h2>Sending rules</h2>
      <div class="form-grid">${num('min_lead_score_to_enroll', 'Min lead score to enroll')}${num('recheck_after_days', 'Re-verify emails older than (days)')}${num('send_window_start_hour', 'Send window start (hour, 0–23)')}${num('send_window_end_hour', 'Send window end (hour)')}
      ${num('min_days_between_company_emails', 'Min days between emails to one business')}${num('max_company_emails_30d', 'Max emails per business per 30 days')}
      ${num('reenroll_after_days', 'Do not re-enroll a business for (days)')}${num('bounce_pause_percent', 'Auto-pause above bounce rate (%)')}
      ${bool('send_weekends', 'Send on weekends')}
      ${bool('allow_likely_valid_sends', 'Allow sending to likely-valid emails (published by the business, mailbox unconfirmed)')}
      ${bool('allow_risky_sends', 'Allow sending to risky / unknown emails')}${bool('allow_role_addresses', 'Allow role addresses (info@, dispatch@)')}</div>
      <p class="muted small">The send window is in each recipient's local time zone (from the business's state). Replies to people who wrote to you are not held by the window.</p>
      <h2>Research</h2>
      <div class="form-grid">${bool('respect_robots_txt', 'Respect robots.txt')}${num('max_pages_per_site', 'Max pages crawled per website')}
      ${bool('ai_research_summaries', 'Rewrite research briefs with the local AI model (uses the daily AI budget)')}</div>
      <h2>Maintenance</h2>
      <div class="form-grid">${num('backup_keep', 'Daily database backups to keep')}${num('retention_job_days', 'Delete finished background jobs after (days)')}${num('retention_audit_days', 'Keep audit log for (days)')}</div>
      <p class="muted small">Suppressions (unsubscribes, bounces, do-not-contact) are never deleted.</p>
      <div class="admin-only"><button class="btn primary" type="submit">Save settings</button></div></form>
    <div class="grid g2"><div class="card"><h2>Integrations</h2><p class="muted small">${i.freeOnly ? badge('free', 'FREE_ONLY on') + ' Paid services are switched off. ' : ''}Settings are in the server's .env file; keys are never shown here.</p><div class="list">
      ${INTEGRATIONS.map(([k, t, env, cost]) => `<div class="row"><span style="width:20px">${i[k] ? '✅' : '⚪'}</span><b>${t}</b> ${badge(cost, COST_TEXT[cost])}<span class="spacer"></span><span class="muted small mono">${esc(env)}</span></div>`).join('')}
      <div class="muted small">Calendly webhooks need a paid Calendly plan; on the free plan, record meetings with "Meeting booked".</div>
      ${i.llmBlockedPaid ? '<div class="notice warn">LLM_BASE_URL points at a paid AI API, so it is switched off while FREE_ONLY is on.</div>' : ''}
      ${i.llm ? `<div class="muted small">Model: ${esc(i.llmModel)} · daily budget ${fmtN(i.llmDailyLimit)} calls</div>` : '<div class="notice info">No local AI model: agents use their deterministic rule engines and templates (fully functional). Install Ollama for free AI personalization and reply understanding.</div>'}</div></div>
      <div class="card admin-only"><h2>Users</h2><div class="list">${users.map((u) => `<div class="row"><b>${esc(u.email)}</b>${badge(u.role === 'admin' ? 'active' : 'new', u.role)}<span class="spacer"></span><span class="muted small">${fmtDate(u.created_at)}</span></div>`).join('')}</div>
        <form data-form="user-new" class="form-grid" style="margin-top:12px"><label>Email<input name="email" type="email" required></label><label>Password (10+ chars)<input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
        <label>Role<select name="role">${opt('viewer', 'viewer')}${opt('admin', 'viewer')}</select></label><div><button class="btn" type="submit">Add user</button></div></form></div></div>
    <div class="grid g2"><div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Audit log</h2></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>
      ${au.entries.length ? au.entries.map((a) => `<tr><td class="small">${fmtTime(a.created_at)}</td><td class="small">${esc(a.actor)}</td><td class="mono">${esc(a.action)}</td><td class="small">${esc(a.entity_type || '')}${a.entity_id ? ` #${a.entity_id}` : ''}</td></tr>`).join('') : empty('No entries', 4)}</tbody></table></div></div>
      <div class="card flush"><div class="card-head" style="padding:16px 16px 0"><h2>Recent job failures</h2></div><div class="table-wrap"><table><thead><tr><th>Job</th><th>Attempts</th><th>Error</th></tr></thead><tbody>
      ${jb.recent_failures.length ? jb.recent_failures.map((j) => `<tr><td class="mono">${esc(j.type)} #${j.id}</td><td>${j.attempts}</td><td class="small">${esc(j.last_error)}</td></tr>`).join('') : empty('No failed jobs', 3)}</tbody></table></div></div></div>`;
}
forms.settings = async (d) => { const r = await api('/api/settings', { method: 'PUT', body: d }); toast(r.compliance.length ? 'Saved. Some required fields are still missing.' : 'Settings saved'); renderCurrent(); };
forms['user-new'] = async (d, f) => { await api('/api/users', { method: 'POST', body: d }); f.reset(); toast('User added'); renderCurrent(); };

boot().then(() => { if (!me) showLogin(); });
