import { config } from '../config.js';
import { fetchJson } from '../lib/runtime.js';
import { titleCase, hostOf, hostMatches, NON_COMPANY_HOSTS, FORUM_HOSTS } from '../lib/text.js';

// Discovery sources. Each returns raw leads in one shape:
// { name, website, phone, address, city, state, country, equipment_types[], prospect_category, fleet_size,
//   usdot_number, owner_name, operating_status, authority_granted_at, emails:[{email, source_url, contact_type}],
//   source, source_url, title, snippet, published_at, reliability }
// Only official APIs and public pages are used. LinkedIn/Facebook are never crawled; only the public
// title/snippet a search engine returns is stored.

export const EQUIPMENT_TYPES = ['Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Hotshot', 'Box Truck', 'Power Only', 'Car Hauler', 'Tanker'];
export const PROSPECT_CATEGORIES = [
  'Owner-Operator', 'Independent Truck Driver', 'Small Trucking Company', 'Independent Carrier', 'Fleet Owner',
  'Hotshot Trucking Company', 'Dry Van Operator', 'Reefer Operator', 'Flatbed Operator', 'Step Deck Operator',
  'Box Truck Operator', 'Power Only Operator',
];

export const SOURCE_RELIABILITY = {
  fmcsa_census: 0.95, fmcsa_authority: 0.95, google_places: 0.8, website: 0.85, google_cse: 0.6, brave: 0.6, reddit: 0.4, manual: 0.7,
};

// What each provider costs. 'free' needs nothing; 'free_tier' needs a free account/key; 'paid' needs billing.
export const SOURCE_COST = {
  fmcsa_census: 'free', fmcsa_authority: 'free', reddit: 'free_tier', google_cse: 'free_tier', brave: 'free_tier', google_places: 'paid',
};

export function sourceAvailability() {
  const s = config.sources;
  const configured = {
    fmcsa_census: true,
    fmcsa_authority: true,
    google_places: !!s.googlePlacesKey,
    google_cse: !!(s.googleCseKey && s.googleCseCx),
    brave: !!s.braveKey,
    reddit: !!(s.redditClientId && s.redditClientSecret),
  };
  return Object.fromEntries(Object.entries(configured).map(([k, v]) => [k, v && !(config.freeOnly && SOURCE_COST[k] === 'paid')]));
}

// ---------- FMCSA Company Census (data.transportation.gov, public, no key required) ----------
export const CENSUS_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';

const CARGO_EQUIPMENT = [
  [['crgo_coldfood', 'crgo_produce', 'crgo_meat'], 'Reefer'],
  [['crgo_genfreight', 'crgo_household', 'crgo_paperprod', 'crgo_beverages'], 'Dry Van'],
  [['crgo_metalsheet', 'crgo_bldgmat', 'crgo_machlrg', 'crgo_logpole', 'crgo_construct'], 'Flatbed'],
  [['crgo_motoveh', 'crgo_cargoothr_motoveh'], 'Car Hauler'],
  [['crgo_liqgas', 'crgo_chem', 'crgo_oilfield'], 'Tanker'],
];

function censusDate(d) {
  return /^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00.000Z` : null;
}

export function mapCensusRow(r) {
  const units = Number(r.power_units || r.truck_units || 0) || null;
  const equipment = CARGO_EQUIPMENT.filter(([keys]) => keys.some((k) => r[k] === 'X')).map(([, e]) => e);
  const email = (r.email_address || '').trim().toLowerCase();
  const dot = String(r.dot_number);
  return {
    name: titleCase(r.dba_name || r.legal_name),
    legal_name: titleCase(r.legal_name),
    phone: r.phone || null,
    address: [r.phy_street, r.phy_city, r.phy_state, r.phy_zip].filter(Boolean).join(', '),
    city: titleCase(r.phy_city),
    state: r.phy_state,
    zip_code: /^\d{5}/.test(r.phy_zip || '') ? r.phy_zip.slice(0, 5) : null,
    // The census lists the MC docket for carriers with for-hire authority (empty until it is issued).
    mc_number: r.docket1prefix === 'MC' && Number(r.docket1) ? String(Number(r.docket1)) : null,
    country: r.phy_country || 'US',
    equipment_types: equipment,
    equipment_inferred: true,
    prospect_category: units && units <= 1 ? 'Owner-Operator' : units && units <= 10 ? 'Small Trucking Company' : 'Fleet Owner',
    fleet_size: units,
    operating_region: r.carrier_operation === 'A' ? 'Interstate' : r.carrier_operation ? 'Intrastate only' : null,
    usdot_number: dot,
    owner_name: r.company_officer_1 ? titleCase(r.company_officer_1) : null,
    operating_status: r.status_code === 'A' ? 'active_usdot' : 'inactive_usdot',
    authority_granted_at: censusDate(r.add_date),
    emails: email ? [{ email, source_url: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`, contact_type: 'owner' }] : [],
    source: 'fmcsa_census',
    source_url: `https://data.transportation.gov/resource/az4n-8mr2.json?dot_number=${dot}`,
    title: `FMCSA census: ${titleCase(r.legal_name)} (USDOT ${dot})`,
    snippet: `${r.classdef || ''}; ${units ?? '?'} power units; registered ${censusDate(r.add_date)?.slice(0, 10) || 'unknown'}; status ${r.status_code}`,
    published_at: censusDate(r.add_date),
    reliability: SOURCE_RELIABILITY.fmcsa_census,
  };
}

export function socrataHeaders() {
  return config.sources.socrataAppToken ? { 'X-App-Token': config.sources.socrataAppToken } : {};
}

export async function searchFmcsaCensus({ state, newWithinDays = 120, maxFleet = 10, limit = 50 }) {
  const since = new Date(Date.now() - newWithinDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const where = [
    `add_date >= '${since}'`,
    `status_code = 'A'`,
    `classdef like '%AUTHORIZED FOR HIRE%'`,
    `carrier_operation in ('A','C')`,
    state ? `phy_state = '${String(state).replace(/[^A-Z]/gi, '').toUpperCase()}'` : null,
  ].filter(Boolean).join(' AND ');
  const url = `${CENSUS_URL}?${new URLSearchParams({ $where: where, $order: 'add_date DESC', $limit: String(Math.min(limit * 2, 1000)) })}`;
  const rows = await fetchJson(url, { headers: socrataHeaders() });
  return rows
    .filter((r) => { const u = Number(r.power_units || 0); return u >= 1 && u <= maxFleet; })
    .slice(0, limit)
    .map(mapCensusRow);
}

export async function lookupCensusByDot(dot) {
  const url = `${CENSUS_URL}?${new URLSearchParams({ dot_number: String(dot), $limit: '1' })}`;
  const rows = await fetchJson(url, { headers: socrataHeaders() });
  return rows[0] ? mapCensusRow(rows[0]) : null;
}

// ---------- FMCSA operating-authority events (data.transportation.gov "Motus AuthHist", daily, free) ----------
// New grants ("Granted") and new applications ("Pending / Initial Status") are the strongest public signal
// that a carrier is just starting out and has no load sources yet.
// Runs fn over items with at most `limit` requests in flight; results keep the input order.
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// From one carrier's authority history (Motus events, any order), the date its CURRENT active streak began,
// or null when it is not active now. A suspension or revocation resets the streak; a reinstatement starts a new one.
export function authorityActiveSince(events) {
  const sorted = [...events].sort((a, b) => String(a.status_change_date).localeCompare(String(b.status_change_date)));
  let since = null;
  for (const e of sorted) {
    if (e.op_auth_status === 'Active') since ||= String(e.status_change_date);
    else since = null;
  }
  return since; // YYYYMMDD
}

const MOTUS_AUTH_URL = 'https://data.transportation.gov/resource/dm5j-zc6c.json';
const PROPERTY = /^Motor Carrier of Property/i;
export const normDot = (d) => { const n = Number(String(d ?? '').replace(/\D/g, '')); return n ? String(n) : ''; };
export const mcFromDocket = (d) => (/^MC\d+/i.test(d || '') ? String(Number(d.slice(2))) : null);
const isNewAuthorityEvent = (e) => PROPERTY.test(e.op_auth_type || '')
  && (e.reason === 'Granted' || (e.op_auth_status === 'Pending' && e.reason === 'Initial Status'));

function authorityStatus(e) {
  if (e.op_auth_status === 'Active') return 'authorized';
  if (e.op_auth_status === 'Pending') return 'pending_authority';
  return 'not_authorized';
}

function eventOf(e) {
  return { type: e.reason === 'Granted' ? 'granted' : e.op_auth_status === 'Pending' && e.reason === 'Initial Status' ? 'applied' : 'status_change',
    at: censusDate(e.status_change_date), docket: e.docket_number || null, status: e.op_auth_status, reason: e.reason };
}

export async function searchFmcsaAuthority({ state, newWithinDays = 30, maxFleet = 10, limit = 50 }) {
  const since = new Date(Date.now() - Math.min(newWithinDays, 120) * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const where = `status_change_date >= '${since}' AND op_auth_type like 'Motor Carrier of Property%' AND (reason = 'Granted' OR (op_auth_status = 'Pending' AND reason = 'Initial Status'))`;
  const events = await fetchJson(`${MOTUS_AUTH_URL}?${new URLSearchParams({ $where: where, $order: 'status_change_date DESC', $limit: '20000' })}`, { headers: socrataHeaders() }, { retries: 4 });
  const byDot = new Map();
  for (const e of events) {
    const dot = normDot(e.usdot_number);
    if (dot && !byDot.has(dot) && isNewAuthorityEvent(e)) byDot.set(dot, e);
  }
  const st = state ? String(state).replace(/[^A-Z]/gi, '').toUpperCase() : null;
  const dots = [...byDot.keys()];
  const out = [];
  // Join to the census for name, published email, fleet size and address (100 DOT numbers per request).
  const chunks = [];
  for (let i = 0; i < dots.length; i += 100) chunks.push(dots.slice(i, i + 100));
  const censusRows = await mapPool(chunks, 6, (chunk) => {
    const w = [`dot_number in (${chunk.map((d) => `'${d}'`).join(',')})`, st ? `phy_state = '${st}'` : null].filter(Boolean).join(' AND ');
    return fetchJson(`${CENSUS_URL}?${new URLSearchParams({ $where: w, $limit: '1000' })}`, { headers: socrataHeaders() }, { retries: 4 });
  });
  for (const rows of censusRows) {
    if (out.length >= limit) break;
    for (const r of rows) {
      const dot = normDot(r.dot_number);
      const e = byDot.get(dot);
      if (!e || (st && r.phy_state !== st) || Number(r.power_units || 0) > maxFleet) continue;
      const ev = eventOf(e);
      const lead = mapCensusRow(r);
      Object.assign(lead, {
        source: 'fmcsa_authority', reliability: SOURCE_RELIABILITY.fmcsa_authority,
        source_url: `${MOTUS_AUTH_URL}?usdot_number=${dot}`,
        title: `FMCSA authority ${ev.type === 'granted' ? 'granted' : 'application'}: ${lead.legal_name} (${e.docket_number})`,
        snippet: `${e.op_auth_type}; ${e.op_auth_status} (${e.reason}) on ${ev.at?.slice(0, 10)}; ${r.power_units || 0} power units`,
        published_at: ev.at, authority_event: ev, mc_number: mcFromDocket(e.docket_number) || lead.mc_number, operating_status: authorityStatus(e),
      });
      out.push(lead);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Latest property-carrier authority status for one DOT number, from the free FMCSA dataset.
export async function lookupAuthorityFree(dot) {
  const d = normDot(dot);
  if (!d) return null;
  const rows = await fetchJson(`${MOTUS_AUTH_URL}?${new URLSearchParams({ usdot_number: d, $order: 'status_change_date DESC', $limit: '20' })}`, { headers: socrataHeaders() });
  const latest = rows.filter((r) => normDot(r.usdot_number) === d && PROPERTY.test(r.op_auth_type || ''))
    .sort((a, b) => String(b.status_change_date).localeCompare(String(a.status_change_date)))[0];
  if (!latest) return null;
  const firstNew = rows.filter((r) => normDot(r.usdot_number) === d && isNewAuthorityEvent(r))
    .sort((a, b) => String(b.status_change_date).localeCompare(String(a.status_change_date)))[0];
  return {
    operating_status: authorityStatus(latest),
    mc_number: mcFromDocket(latest.docket_number),
    authority_event: firstNew ? eventOf(firstNew) : null,
    source: 'fmcsa_authority',
  };
}

// ---------- operating authority + MC: FMCSA QCMobile when a (free) WebKey is set, else the free dataset ----------
export async function lookupAuthority(dot) {
  const key = config.sources.fmcsaWebKey;
  if (!dot) return null;
  if (!key) return lookupAuthorityFree(dot);
  const base = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(dot)}`;
  const [carrier, dockets] = await Promise.all([
    fetchJson(`${base}?webKey=${key}`),
    fetchJson(`${base}/docket-numbers?webKey=${key}`).catch(() => null),
  ]);
  const c = carrier?.content?.carrier;
  if (!c) return null;
  const mc = (dockets?.content || []).find((d) => d.prefix === 'MC')?.docketNumber;
  return {
    allowed_to_operate: c.allowedToOperate === 'Y',
    operating_status: c.allowedToOperate === 'Y' ? 'authorized' : 'not_authorized',
    mc_number: mc ? String(mc) : null,
    legal_name: c.legalName,
  };
}

// ---------- Google Places (New) Text Search ----------
export async function searchGooglePlaces({ query, limit = 20 }) {
  const res = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': config.sources.googlePlacesKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.businessStatus,places.addressComponents,places.googleMapsUri,places.types',
    },
    body: JSON.stringify({ textQuery: query, pageSize: Math.min(limit, 20), regionCode: 'US' }),
  });
  return (res.places || []).map((p) => {
    const comp = (t) => p.addressComponents?.find((c) => c.types?.includes(t));
    return {
      name: p.displayName?.text,
      website: p.websiteUri || null,
      phone: p.nationalPhoneNumber || null,
      address: p.formattedAddress || null,
      city: comp('locality')?.longText || null,
      state: comp('administrative_area_level_1')?.shortText || null,
      country: comp('country')?.shortText || 'US',
      operating_status: p.businessStatus === 'CLOSED_PERMANENTLY' ? 'closed' : p.businessStatus === 'OPERATIONAL' ? 'operational' : null,
      emails: [],
      source: 'google_places',
      source_url: p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      title: p.displayName?.text,
      snippet: p.formattedAddress,
      reliability: SOURCE_RELIABILITY.google_places,
    };
  }).filter((l) => l.name);
}

// ---------- Web search (Google Programmable Search / Brave) ----------
function webResultToLead(r, source) {
  const host = hostOf(r.url);
  if (!host) return null;
  const isForum = hostMatches(host, FORUM_HOSTS);
  const isProfile = /linkedin\.com\/company\/|facebook\.com\/[^/]+\/?$/i.test(r.url);
  if (hostMatches(host, NON_COMPANY_HOSTS) && !isForum && !isProfile) return null;
  const cleanTitle = String(r.title || '').split(/\s[|\-–—]\s/)[0].trim();
  return {
    name: isForum ? `Post: ${cleanTitle.slice(0, 80)}` : cleanTitle || host,
    website: isForum || isProfile ? null : `https://${host}`,
    emails: [],
    prospect_category: isForum ? 'Community Post' : null,
    source,
    source_url: r.url,
    title: r.title,
    snippet: r.snippet,
    published_at: r.published_at || null,
    is_post: isForum,
    reliability: SOURCE_RELIABILITY[source],
  };
}

export async function searchGoogleCse({ query, limit = 10 }) {
  const { googleCseKey, googleCseCx } = config.sources;
  const url = `https://www.googleapis.com/customsearch/v1?${new URLSearchParams({ key: googleCseKey, cx: googleCseCx, q: query, num: String(Math.min(limit, 10)), gl: 'us' })}`;
  const res = await fetchJson(url);
  return (res.items || []).map((i) => webResultToLead({
    url: i.link, title: i.title, snippet: i.snippet,
    published_at: i.pagemap?.metatags?.[0]?.['article:published_time'] || null,
  }, 'google_cse')).filter(Boolean);
}

export async function searchBrave({ query, limit = 20 }) {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(Math.min(limit, 20)), country: 'us' })}`;
  const res = await fetchJson(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': config.sources.braveKey } });
  return (res.web?.results || []).map((r) => webResultToLead({
    url: r.url, title: r.title, snippet: String(r.description || '').replace(/<[^>]+>/g, ''),
    published_at: r.page_age || null,
  }, 'brave')).filter(Boolean);
}

// ---------- Reddit (official OAuth API, public posts only) ----------
let redditToken = null;
async function redditAuth() {
  if (redditToken && redditToken.exp > Date.now()) return redditToken.value;
  const { redditClientId, redditClientSecret, userAgent } = config.sources;
  const res = await fetchJson('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${redditClientId}:${redditClientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent,
    },
    body: 'grant_type=client_credentials',
  });
  redditToken = { value: res.access_token, exp: Date.now() + (res.expires_in - 60) * 1000 };
  return redditToken.value;
}

export async function searchReddit({ query, subreddit = 'Truckers', limit = 25 }) {
  const token = await redditAuth();
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search?${new URLSearchParams({ q: query, restrict_sr: '1', sort: 'new', t: 'month', limit: String(limit) })}`;
  const res = await fetchJson(url, { headers: { authorization: `Bearer ${token}`, 'user-agent': config.sources.userAgent } });
  return (res.data?.children || []).map(({ data: p }) => ({
    name: `Reddit u/${p.author}`,
    emails: [],
    prospect_category: 'Community Post',
    source: 'reddit',
    source_url: `https://www.reddit.com${p.permalink}`,
    title: p.title,
    snippet: String(p.selftext || '').slice(0, 1500),
    published_at: new Date(p.created_utc * 1000).toISOString(),
    is_post: true,
    reliability: SOURCE_RELIABILITY.reddit,
  }));
}

// ---------- Query planning ----------
const INTENT_PHRASES = [
  '"looking for a dispatcher"', '"need a truck dispatcher"', '"looking for dispatch services"',
  '"need help finding loads"', '"owner operator" "need dispatcher"',
];

// Builds independent (source, query) tasks from the search parameters. Each runs as its own job, in parallel.
export function planQueries(params) {
  const avail = sourceAvailability();
  const sources = (params.sources?.length ? params.sources : Object.keys(avail)).filter((s) => avail[s]);
  const states = params.states?.length ? params.states : ['TX'];
  const cities = params.cities?.length ? params.cities : [];
  const equipment = params.equipment?.length ? params.equipment : ['Dry Van', 'Flatbed', 'Hotshot'];
  const locations = cities.length ? cities.map((c) => `${c}`) : states;
  const keywords = params.keywords?.length ? params.keywords : [];
  const tasks = [];

  for (const s of sources) {
    if (s === 'fmcsa_census' || s === 'fmcsa_authority') {
      for (const st of states) tasks.push({ source: s, args: { state: st, newWithinDays: params.newWithinDays || 120, maxFleet: params.maxFleet || 10, limit: params.limitPerQuery || 50 } });
    } else if (s === 'google_places') {
      for (const loc of locations) for (const eq of equipment) tasks.push({ source: s, args: { query: `${eq} trucking company ${loc}` } });
    } else if (s === 'google_cse' || s === 'brave') {
      for (const loc of locations) for (const eq of equipment) tasks.push({ source: s, args: { query: `${eq.toLowerCase()} owner operator trucking ${loc} contact` } });
      for (const ph of INTENT_PHRASES) tasks.push({ source: s, args: { query: `${ph} ${equipment[0].toLowerCase()}` } });
      for (const k of keywords) tasks.push({ source: s, args: { query: k } });
    } else if (s === 'reddit') {
      for (const q of ['looking for dispatcher', 'need dispatcher', 'dispatch service', 'finding loads new authority']) {
        for (const sub of ['Truckers', 'OwnerOperators']) tasks.push({ source: s, args: { query: q, subreddit: sub } });
      }
    }
  }
  const max = params.maxQueries || 40;
  return tasks.slice(0, max);
}

export const SOURCE_FUNCTIONS = {
  fmcsa_census: searchFmcsaCensus,
  fmcsa_authority: searchFmcsaAuthority,
  google_places: searchGooglePlaces,
  google_cse: searchGoogleCse,
  brave: searchBrave,
  reddit: searchReddit,
};
