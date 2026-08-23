// Redfin scraper for the Peninsula Homes dashboard.
//
// Redfin protects most of its site behind an AWS WAF JS challenge, but three
// surfaces are scrapable with a browser user-agent and polite retries:
//   1. /stingray/api/gis            -> JSON of currently ACTIVE listings (stable)
//   2. /city/<id>/CA/<slug>/recently-sold  -> SSR HTML embedding sold listings JSON
//   3. /CA/<city>/<address>/home/<id>      -> SSR HTML with status + schools
// The HTML surfaces are challenge-gated probabilistically; fetchWithRetries()
// backs off and retries, and callers treat failures as "no data today".

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const BASE = 'https://www.redfin.com';

export const MAX_PRICE = 6_000_000;
export const MIN_SQFT = 1800;

export const CITIES = [
  { name: 'Los Altos', regionId: 11018, slug: 'Los-Altos' },
  { name: 'Mountain View', regionId: 12739, slug: 'Mountain-View' },
  { name: 'Palo Alto', regionId: 14325, slug: 'Palo-Alto' },
];

const HTML_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const JSON_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json',
  Referer: BASE + '/',
};

// ---------------------------------------------------------------------------
// Low-level fetch helpers

export function isChallenge(text) {
  if (typeof text !== 'string') return false;
  // Real listing pages embed the WAF telemetry loader too, so a marker alone
  // is not a challenge; challenge interstitials are small and contain none of
  // the SSR content markers real pages always have.
  const looksReal =
    text.includes('application/ld+json') || text.includes('SchoolsListItem') || text.length > 200000;
  if (looksReal) return false;
  return text.includes('gokuProps') || text.includes('awsWafCookieDomainList') || text.includes('aws-waf');
}

/**
 * Fetch with retry/backoff, skipping WAF-challenge responses.
 * budget: object { used, cap } mutated to count external subrequests.
 * Returns { ok, status, text } — ok=false when challenged/failed after retries.
 */
export async function fetchText(url, headers, budget, { retries = 2, baseDelay = 1500 } = {}) {
  let lastStatus = 0;
  let challenged = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (budget && budget.used >= budget.cap) return { ok: false, status: 0, text: '', challenged: false, exhausted: true };
    if (budget) budget.used++;
    let res;
    try {
      res = await fetch(url, { headers, redirect: 'follow' });
    } catch {
      await sleep(baseDelay);
      continue;
    }
    lastStatus = res.status;
    const text = await res.text();
    if (res.status === 200 && !isChallenge(text)) return { ok: true, status: 200, text, challenged: false };
    if (res.status === 202 || res.status === 403 || isChallenge(text)) {
      // WAF challenge (note: challenges can arrive with status 200 too).
      challenged = true;
      await sleep(baseDelay * (attempt + 1) + Math.floor(Math.random() * 700));
      continue;
    }
    return { ok: false, status: res.status, text, challenged: false };
  }
  return { ok: false, status: lastStatus, text: '', challenged };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseStingray(text) {
  // Responses are prefixed with `{}&&` anti-JSONP garbage.
  const i = text.indexOf('{', 2);
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Active listings (gis JSON API)

export function gisUrl(regionId) {
  const p = new URLSearchParams({
    al: '1',
    market: 'sanfrancisco',
    num_homes: '500',
    ord: 'redfin-recommended-asc',
    page_number: '1',
    region_id: String(regionId),
    region_type: '6', // city
    sf: '1,2,3,5,6,7',
    start: '0',
    status: '9', // for-sale
    uipt: '1', // single-family houses only
  });
  return `${BASE}/stingray/api/gis?${p}`;
}

export function normalizeGisHome(h) {
  const price = h.price && h.price.value ? h.price.value : null;
  const ll = h.latLong && h.latLong.value ? h.latLong.value : null;
  const unit = h.unitNumber && h.unitNumber.value ? ` ${h.unitNumber.value}` : '';
  return {
    propertyId: h.propertyId,
    listingId: h.listingId || null,
    mlsId: h.mlsId && h.mlsId.value ? h.mlsId.value : null,
    address: `${h.streetLine ? h.streetLine.value : ''}${unit}`.trim(),
    city: h.city || (h.location && h.location.value) || '',
    state: h.state || 'CA',
    zip: h.zip || '',
    url: BASE + (h.url || ''),
    path: h.url || '',
    price,
    beds: h.beds ?? null,
    baths: h.baths ?? null,
    sqft: h.sqFt && h.sqFt.value ? h.sqFt.value : null,
    lotSize: h.lotSize && h.lotSize.value ? h.lotSize.value : null,
    yearBuilt: h.yearBuilt && h.yearBuilt.value ? h.yearBuilt.value : null,
    lat: ll ? ll.latitude : null,
    lng: ll ? ll.longitude : null,
    dom: h.dom && h.dom.value ? h.dom.value : null,
    // Approximate listing date: today minus days-on-market (Redfin dom).
    // dom increments daily with the calendar, so this stays stable across scans.
    listedDate:
      h.dom && h.dom.value != null
        ? new Date(Date.now() - h.dom.value * 86400000).toISOString().slice(0, 10)
        : null,
    mlsStatus: h.mlsStatus || null,
    soldDate: h.soldDate || null,
    // gis soldDate is epoch-ms of the last public sale (for active homes)
    lastSoldYear: h.soldDate ? new Date(h.soldDate).getUTCFullYear() : null,
    uiPropertyType: h.uiPropertyType ?? null,
    // Open house schedule from the gis feed (if present).
    openHouses: Array.isArray(h.openHouses)
      ? h.openHouses
          .filter((oh) => oh && oh.date)
          .map((oh) => ({
            date: typeof oh.date === 'string' ? oh.date : new Date(oh.date).toISOString().slice(0, 10),
            time: oh.time || null,
            comment: oh.comment || oh.notes || null,
          }))
      : [],
  };
}

/**
 * Single-family houses only: Redfin uiPropertyType 1. Condos (2), townhomes
 * (3), multi-family (4) and everything else are dropped at ingest. The
 * uipt=1 URL param is not honored reliably by the gis endpoint, so the field
 * itself is the source of truth.
 */
export function isSingleFamily(h) {
  return h.uiPropertyType === 1;
}

/** Fetch ACTIVE houses <= MAX_PRICE for a city. Returns [] on failure. */
export async function fetchActiveHomes(city, budget) {
  const res = await fetchText(gisUrl(city.regionId), JSON_HEADERS, budget, { retries: 2 });
  if (!res.ok) return { homes: [], failed: true };
  const d = parseStingray(res.text);
  const homes = (d && d.payload && d.payload.homes) || [];
  return {
    homes: homes
      .map(normalizeGisHome)
      .filter((h) => h.price !== null && h.price <= MAX_PRICE && inCity(h, city))
      .filter(isSingleFamily) // no townhomes/condos/duplexes — houses only
      .filter((h) => h.sqft !== null && h.sqft > MIN_SQFT)
      .filter((h) => !/ready\s+to\s+build/i.test(h.mlsStatus || ''))
      .filter((h) => !/\bplan\b/i.test(h.address || '')), // exclude new-construction "Plan" listings
    failed: false,
  };
}

// ---------------------------------------------------------------------------
// 2. Recently sold listings (SSR HTML with embedded JSON cache)

export function soldPageUrl(city) {
  return `${BASE}/city/${city.regionId}/CA/${city.slug}/recently-sold`;
}

/**
 * Extract every embedded `{}&&{...}` JSON blob from a Redfin SSR page and
 * return the concatenated homes arrays. The blobs live inside
 * "text":"<escaped json>" fields of the page's request cache.
 */
export function extractEmbeddedHomes(html) {
  const homes = [];
  let idx = 0;
  while ((idx = html.indexOf('"text":"', idx)) !== -1) {
    const start = idx + 8;
    if (html.slice(start, start + 4) !== '{}&&') {
      idx = start;
      continue;
    }
    // Scan to the closing unescaped quote, keeping escape sequences verbatim
    // so the body can be decoded with JSON.parse('"'+body+'"').
    let k = start;
    const parts = [];
    while (k < html.length) {
      const c = html[k];
      if (c === '\\') {
        const len = html[k + 1] === 'u' ? 6 : 2;
        parts.push(html.slice(k, k + len));
        k += len;
        continue;
      }
      if (c === '"') break;
      parts.push(c);
      k++;
    }
    idx = k + 1;
    let raw;
    try {
      raw = JSON.parse('"' + parts.join('') + '"');
    } catch {
      continue;
    }
    if (!raw.includes('"homes"')) continue;
    try {
      const d = JSON.parse(raw.slice(raw.indexOf('{', 2)));
      const hs = (d.payload && d.payload.homes) || [];
      for (const h of hs) homes.push(h);
    } catch {
      /* skip malformed blob */
    }
  }
  return homes;
}

/** Fetch SOLD houses for a city from the recently-sold page (fail-fast). */
export async function fetchSoldHomes(city, budget) {
  const res = await fetchText(soldPageUrl(city), HTML_HEADERS, budget, { retries: 0 });
  if (!res.ok) {
    return { homes: [], failed: true, challenged: res.challenged || res.status === 202 || res.status === 403 || res.status === 0 };
  }
  const homes = extractEmbeddedHomes(res.text)
    .map(normalizeGisHome)
    .filter((h) => h.price !== null && h.price <= MAX_PRICE && inCity(h, city))
    .filter(isSingleFamily)
    .filter((h) => h.sqft !== null && h.sqft > MIN_SQFT)
    .filter((h) => !/\bplan\b/i.test(h.address || ''));
  return { homes, failed: false, challenged: false };
}

/** gis returns nearby-city homes too; keep only the queried city. */
function inCity(h, city) {
  return (h.city || '').toLowerCase() === city.name.toLowerCase();
}

// ---------------------------------------------------------------------------
// 3. Listing detail page (status confirmation + school zoning)

export async function fetchDetail(path, budget) {
  // Fail-fast: the WAF penalizes repeated hits on the same IP, so one attempt
  // per page; schools accumulate across the 2× daily scans instead.
  const res = await fetchText(BASE + path, HTML_HEADERS, budget, { retries: 0 });
  if (!res.ok) return { ok: false, status: res.status, challenged: res.challenged || res.status === 202 || res.status === 403 || res.status === 0 };
  const detail = parseDetail(res.text);
  return {
    ok: true,
    status: res.status,
    challenged: false,
    detail,
    // Diagnostics: shape of the page the worker actually received.
    bodyLen: res.text.length,
    hasSchoolMarker: res.text.includes('SchoolsListItem'),
  };
}

/**
 * Parse a Redfin listing page:
 *  - status from mlsStatusDisplay.displayValue ("Active" | "Pending" | "Sold" ...)
 *  - schools from the SSR SchoolsListItem DOM blocks (name, grades, rating)
 *  - sold price/date when present in the status banner
 */
export function parseDetail(html) {
  const out = { status: null, soldPrice: null, soldDate: null, schools: [] };

  // Status (handles both escaped cached-JSON and plain DOM forms).
  const m =
    html.match(/mlsStatusDisplay\\?":\\?\{\\?"displayValue\\?":\\?"([A-Za-z ]+)"/) ||
    html.match(/"displayValue":"([A-Za-z ]+)"/);
  if (m) {
    const v = m[1].toLowerCase();
    if (v.includes('ready') && v.includes('build')) out.status = 'ready_to_build';
    else if (v.includes('pending') || v.includes('contingent')) out.status = 'pending';
    else if (v.includes('sold')) out.status = 'sold';
    else if (v.includes('active') || v.includes('sale')) out.status = 'active';
  }
  if (!out.status) {
    const s = html.match(/searchStatusId\\?":(\d)/);
    if (s) out.status = s[1] === '1' ? 'active' : s[1] === '2' ? 'pending' : s[1] === '3' ? 'sold' : null;
  }

  // Sold price / date from banner text, e.g. "Sold for $4,250,000 on Jul 12, 2026"
  if (out.status === 'sold') {
    const sp = html.match(/Sold for \$([\d,]+)/i) || html.match(/sold[^$]{0,40}\$([\d,]+)/i);
    if (sp) out.soldPrice = parseInt(sp[1].replace(/,/g, ''), 10);
    const sd = html.match(/on ([A-Z][a-z]{2} \d{1,2}, \d{4})/);
    if (sd) out.soldDate = sd[1];
  }

  // Schools: split on list items and pull heading/description/rating.
  const items = html.split(/SchoolsListItem clickable/).slice(1);
  for (const item of items) {
    const name = (item.match(/SchoolsListItem__heading[^>]*>([^<]+)</) || [])[1];
    const desc = (item.match(/SchoolsListItem__description[^>]*>([^<]+)</) || [])[1];
    const rating = (item.match(/SchoolsListItem__schoolRating">([^<]+)</) || [])[1];
    if (!name) continue;
    out.schools.push({
      name: name.trim(),
      desc: (desc || '').trim(),
      rating: rating ? parseInt(rating.split('/')[0], 10) : null,
      level: classifySchool(name, desc || ''),
    });
  }
  return out;
}

/** Map a school name/grade span to elementary | middle | high. */
export function classifySchool(name, desc) {
  const n = (name + ' ' + desc).toLowerCase();
  // "junior high" is a middle school; check middle before high.
  if (/middle|junior|6-8|7-8|6-9|7-9/.test(n)) return 'middle';
  if (/high|9-12|9-13|10-12/.test(n)) return 'high';
  if (/elementary|k-5|k-6|k-8|1-5|1-6|1-8/.test(n)) return 'elementary';
  // K-8 spans are assigned as elementary (Redfin lists the middle separately
  // for these cities' attendance zones).
  return null;
}
