// Peninsula Homes API worker.
// Serves the listings API consumed by the Pages dashboard and runs the daily
// Redfin scan on a cron trigger. All state lives in D1.

import { CITIES, MAX_PRICE, MIN_SQFT, fetchActiveHomes, fetchSoldHomes, fetchDetail } from './redfin.js';
import * as db from './db.js';
import { onNewListing, sendMailjet, formatHomeText, formatHomeHtml } from './notify.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-scan-token',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' },
      });

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: 'peninsula-homes-api', now: new Date().toISOString() });
      }
      if (url.pathname === '/api/listings' && req.method === 'GET') {
        return json(await listListings(env.DB, url.searchParams));
      }
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        return json(await stats(env.DB, url.searchParams));
      }
      const propMatch = url.pathname.match(/^\/api\/property\/(\d+)$/);
      if (propMatch && req.method === 'GET') {
        return json(await propertyDetail(env.DB, Number(propMatch[1])));
      }
      if (url.pathname === '/api/scans' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 14').all();
        return json(results);
      }
      if (url.pathname === '/api/scan' && req.method === 'POST') {
        if (env.SCAN_TOKEN && req.headers.get('x-scan-token') !== env.SCAN_TOKEN) {
          return json({ error: 'unauthorized' }, 401);
        }
        const summary = await runScan(env, 'manual');
        return json(summary);
      }
      if (url.pathname === '/api/schools' && req.method === 'POST') {
        // Ingest school zoning collected by the local backfill script
        // (scripts/backfill-schools.mjs) without going through the
        // rate-limited Cloudflare D1 admin API.
        if (!env.SCAN_TOKEN || req.headers.get('x-scan-token') !== env.SCAN_TOKEN) {
          return json({ error: 'unauthorized' }, 401);
        }
        const body = await req.json().catch(() => null);
        const updates = Array.isArray(body && body.updates) ? body.updates : [];
        let saved = 0;
        for (const u of updates.slice(0, 100)) {
          if (!u || !u.property_id || !Array.isArray(u.schools) || !u.schools.length) continue;
          await db.saveSchools(env.DB, Number(u.property_id), u.schools);
          saved++;
        }
        return json({ saved });
      }
      if (url.pathname === '/api/test-email' && req.method === 'POST') {
        if (!env.SCAN_TOKEN || req.headers.get('x-scan-token') !== env.SCAN_TOKEN) {
          return json({ error: 'unauthorized' }, 401);
        }
        // Send a test email with sample data to verify Mailjet integration.
        const sampleHome = {
          propertyId: 12345,
          address: '123 Sample Street',
          city: 'Los Altos',
          zip: '94022',
          price: 2500000,
          beds: 4,
          baths: 3,
          sqft: 2200,
          lot_size: 7500,
          year_built: 1965,
          dom: 5,
          listed_date: '2026-08-04',
          last_sold_year: 2018,
          school_elementary: 'Loyola Elementary',
          school_elementary_rating: 10,
          school_middle: 'Egan Middle School',
          school_middle_rating: 9,
          school_high: 'Los Altos High School',
          school_high_rating: 10,
          url: 'https://www.redfin.com/CA/Los-Altos/123-Sample-St-94022/home/12345',
        };
        // Bypass the DB insert for the test; call the email logic directly.
        const subject = `TEST: New Listing: ${sampleHome.address}, ${sampleHome.city} — $${sampleHome.price.toLocaleString('en-US')}`;
        const text = `TEST EMAIL\n\n${formatHomeText(sampleHome)}`;
        const html = formatHomeHtml(sampleHome).replace('🏡 New Listing', '🏡 TEST: New Listing');
        const result = await sendMailjet(env, {
          to: ['hareesh.nagarajan@gmail.com', 'divya.ramamurthy@gmail.com'],
          subject,
          text,
          html,
        });
        return json({ sent: result.ok, error: result.error || null });
      }
      if (url.pathname === '/') {
        return json({
          service: 'peninsula-homes-api',
          endpoints: ['/api/health', '/api/listings?status=active|pending|sold', '/api/stats', '/api/property/:id', '/api/scans', 'POST /api/scan', 'POST /api/schools'],
          cities: CITIES.map((c) => c.name),
          maxPrice: MAX_PRICE,
          minSqft: MIN_SQFT,
        });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },

  async scheduled(_event, env) {
    await runScan(env, 'cron');
  },
};

// ---------------------------------------------------------------------------
// Scan orchestration. External-fetch budget keeps us under the Workers
// free-plan subrequest limit (50/invocation): 3 gis + 3 sold pages + the rest
// spent on per-property detail checks.

async function runScan(env, trigger) {
  const startedAt = new Date().toISOString();
  const budget = { used: 0, cap: 48 };
  const summary = {
    trigger,
    started_at: startedAt,
    active_seen: 0,
    new_listings: 0,
    pending_now: 0,
    sold_now: 0,
    detail_checks: 0,
    notes: [],
  };

  // Phase 1 — active listings per city (source of truth for the Available tab).
  for (const city of CITIES) {
    const { homes, failed } = await fetchActiveHomes(city, budget);
    if (failed) {
      summary.notes.push(`gis failed for ${city.name}`);
      continue;
    }
    summary.active_seen += homes.length;
    for (const h of homes) {
      const r = await db.upsertActiveHome(env.DB, h, 'redfin-active', (nh) => onNewListing(env.DB, nh, env));
      if (r === 'new') summary.new_listings++;
    }
  }

  // Phase 1b — remove any "Ready to Build" or other excluded statuses.
  const removedExcluded = await db.deleteExcludedStatuses(env.DB);
  if (removedExcluded > 0) summary.notes.push(`removed ${removedExcluded} excluded (Ready to Build)`);

  // Phase 1c — remove properties below minimum sqft.
  const removedSqft = await db.deleteBelowMinSqft(env.DB, MIN_SQFT);
  if (removedSqft > 0) summary.notes.push(`removed ${removedSqft} below ${MIN_SQFT} sqft`);

  // Phase 1d — remove new-construction "Plan" listings.
  const removedPlans = await db.deletePlanListings(env.DB);
  if (removedPlans > 0) summary.notes.push(`removed ${removedPlans} new-construction plans`);

  // Phase 1e — remove non-single-family properties (condos/townhomes/multi).
  const removedMulti = await db.deleteNonSingleFamily(env.DB);
  if (removedMulti > 0) summary.notes.push(`removed ${removedMulti} non-single-family properties`);

  // WAF circuit breaker: Redfin's AWS WAF rate-limits per IP and penalizes
  // repeated hits, so detail/sold fetches are fail-fast and abort the rest of
  // the HTML phase after a few consecutive challenges. Coverage accumulates
  // across the 2× daily scans instead (schools are cached permanently).
  let wafStreak = 0;
  const wafOpen = () => wafStreak >= 3;
  const detailStatuses = [];
  const trackChallenge = (r) => {
    if (r) detailStatuses.push(r.status);
    if (r && r.ok) wafStreak = 0;
    else if (r && r.challenged) wafStreak++;
  };

  // Phase 2 — properties that vanished from the active set: confirm their new
  // status on the listing page (pending / sold / still active), else infer pending.
  const disappeared = await db.getDisappeared(env.DB, startedAt);
  for (const p of disappeared) {
    if (budget.used >= budget.cap || wafOpen()) break;
    const path = pathOf(p.url);
    const r = path ? await fetchDetail(path, budget) : { ok: false, challenged: false };
    trackChallenge(r);
    summary.detail_checks++;
    const detail = r.ok ? r.detail : null;
    if (detail && detail.status === 'ready_to_build') {
      // Excluded status: remove the property entirely.
      await db.deleteProperty(env.DB, p.property_id);
    } else if (detail && detail.status === 'sold') {
      if (await db.setStatus(env.DB, p.property_id, 'sold', 'redfin-detail', { soldPrice: detail.soldPrice, soldDate: detail.soldDate })) summary.sold_now++;
    } else if (detail && detail.status === 'pending') {
      if (await db.setStatus(env.DB, p.property_id, 'pending', 'redfin-detail')) summary.pending_now++;
    } else if (detail && detail.status === 'active') {
      // Transient gis miss; keep it active and refresh its seen timestamp.
      await db.markSeenActive(env.DB, p.property_id);
    } else {
      // Unreachable (WAF) or unknown: conservatively mark pending; a later scan
      // upgrades to sold once the sold page or detail page confirms it.
      if (await db.setStatus(env.DB, p.property_id, 'pending', 'inferred')) summary.pending_now++;
    }
    if (detail && detail.schools.length) {
      await db.saveSchools(env.DB, p.property_id, detail.schools);
      summary.schools_found = (summary.schools_found || 0) + 1;
    }
    await db.touchChecked(env.DB, p.property_id);
  }

  // Phase 3 — opportunistic school-zoning backfill with remaining budget.
  if (!wafOpen()) {
    const missing = await db.getMissingSchools(env.DB, Math.max(0, budget.cap - budget.used));
    for (const p of missing) {
      if (budget.used >= budget.cap || wafOpen()) break;
      const path = pathOf(p.url);
      if (!path) continue;
      const r = await fetchDetail(path, budget);
      trackChallenge(r);
      summary.detail_checks++;
      const detail = r.ok ? r.detail : null;
      if (detail) {
        if (detail.schools.length) {
          await db.saveSchools(env.DB, p.property_id, detail.schools);
          summary.schools_found = (summary.schools_found || 0) + 1;
        }
        if (detail.status === 'pending' && (await db.setStatus(env.DB, p.property_id, 'pending', 'redfin-detail'))) summary.pending_now++;
        if (detail.status === 'sold' && (await db.setStatus(env.DB, p.property_id, 'sold', 'redfin-detail', { soldPrice: detail.soldPrice, soldDate: detail.soldDate }))) summary.sold_now++;
      }
      await db.touchChecked(env.DB, p.property_id);
    }
  }
  if (wafOpen()) summary.notes.push('detail pages WAF-challenged; school/status checks deferred');
  if (detailStatuses.length) summary.notes.push(`detail page statuses: ${detailStatuses.slice(0, 12).join(',')}`);
  if (summary.schools_found) summary.notes.push(`collected school zoning for ${summary.schools_found} properties`);

  // Phase 4 — recently-sold pages feed the Sold tab and confirm sales.
  if (!wafOpen()) {
    for (const city of CITIES) {
      if (wafOpen()) break;
      const { homes, failed, challenged } = await fetchSoldHomes(city, budget);
      if (challenged) wafStreak++;
      else wafStreak = 0;
      if (failed) {
        summary.notes.push(`sold page challenged for ${city.name}`);
        continue;
      }
      for (const h of homes) {
        const r = await db.insertSoldHome(env.DB, h, 'redfin-sold');
        if (r === 'sold' || r === 'new') summary.sold_now++;
      }
    }
  }

  summary.finished_at = new Date().toISOString();
  summary.fetches = budget.used;
  await db.writeScanLog(env.DB, summary);
  return summary;
}

function pathOf(url) {
  if (!url) return null;
  return url.startsWith('https://www.redfin.com') ? url.slice('https://www.redfin.com'.length) : url;
}

// ---------------------------------------------------------------------------
// API queries

async function listListings(d1, params) {
  const status = ['active', 'pending', 'sold'].includes(params.get('status')) ? params.get('status') : 'active';
  const sort = params.get('sort') || (status === 'sold' ? 'sold_desc' : 'listed');

  const { where, binds } = filterClauses(params);
  where.unshift('status = ?');
  binds.unshift(status);

  const orderBy = {
    price_asc: 'price ASC',
    price_desc: 'price DESC',
    newest: 'first_seen DESC',
    listed: 'listed_date DESC', // SQLite puts NULLs last on DESC
    sqft: 'sqft DESC',
    sold_desc: "COALESCE(sold_date, status_changed_at) DESC",
  }[sort] || 'listed_date DESC';

  const { results } = await d1
    .prepare(`SELECT * FROM properties WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT 500`)
    .bind(...binds)
    .all();
  return { count: results.length, listings: results };
}

async function stats(d1, params = new URLSearchParams()) {
  const { where, binds } = filterClauses(params);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const counts = await d1
    .prepare(`SELECT status, COUNT(*) AS n FROM properties ${filter} GROUP BY status`)
    .bind(...binds)
    .all();
  const last = await d1.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').first();
  const weekWhere = where.length ? `AND ${where.join(' AND ')}` : '';
  const week = await d1
    .prepare(`SELECT COUNT(*) AS n FROM properties WHERE first_seen >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days') ${weekWhere}`)
    .bind(...binds)
    .first();
  const byCityWhere = where.length ? `AND ${where.join(' AND ')}` : '';
  const byCity = await d1
    .prepare(`SELECT city, status, COUNT(*) AS n FROM properties WHERE status != 'sold' ${byCityWhere} GROUP BY city, status`)
    .bind(...binds)
    .all();
  return {
    counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
    byCity: byCity.results,
    newLast7Days: week ? week.n : 0,
    lastScan: last || null,
  };
}

// Shared WHERE-clause builder so /api/listings and /api/stats filter
// identically (city, maxPrice, minBeds, address search).
function filterClauses(params) {
  const city = params.get('city');
  const maxPrice = Number(params.get('maxPrice')) || null;
  const minBeds = Number(params.get('minBeds')) || null;
  const q = (params.get('q') || '').trim().toLowerCase();
  const where = [];
  const binds = [];
  if (city && CITIES.some((c) => c.name === city)) {
    where.push('city = ?');
    binds.push(city);
  }
  if (maxPrice) {
    where.push('price <= ?');
    binds.push(maxPrice);
  }
  if (minBeds) {
    where.push('beds >= ?');
    binds.push(minBeds);
  }
  if (q) {
    where.push('lower(address) LIKE ?');
    binds.push(`%${q}%`);
  }
  return { where, binds };
}

async function propertyDetail(d1, propertyId) {
  const property = await d1.prepare('SELECT * FROM properties WHERE property_id = ?').bind(propertyId).first();
  if (!property) return { error: 'not found' };
  const { results: history } = await d1
    .prepare('SELECT * FROM status_history WHERE property_id = ? ORDER BY id ASC')
    .bind(propertyId)
    .all();
  return { property, history };
}
