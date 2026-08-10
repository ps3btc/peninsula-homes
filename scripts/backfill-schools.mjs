// Local backfill: fetch Redfin detail pages from this machine (residential IP
// passes the WAF periodically; the Worker's datacenter IP mostly does not) and
// POST the collected school zoning to the worker's /api/schools endpoint,
// which writes straight into remote D1 (avoids the rate-limited Cloudflare
// `wrangler d1 execute --remote` admin API).
//
// Redfin's AWS WAF alternates ~10-15 min hard blocks with short open bursts,
// so the script cycles through the queue, rests when blocked, and keeps going
// unattended until everything is collected (or --max-minutes is reached).
//
// Usage: node scripts/backfill-schools.mjs [--limit N] [--max-minutes M]

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseDetail, isChallenge } from '../src/redfin.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_BASE = 'https://peninsula-homes-api.flyingokapi.workers.dev';
const SCAN_TOKEN = (() => {
  try {
    const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const m = vars.match(/SCAN_TOKEN=(.+)/);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
})();
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const LIMIT = arg('--limit', Infinity);
const MAX_MINUTES = arg('--max-minutes', 480);
const started = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single attempt per call: immediate retries waste the WAF's open bursts.
async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const text = await res.text();
    const challenged = isChallenge(text) || text.includes('The request could not be satisfied');
    if (res.status === 200 && !challenged) return { ok: true, text };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function queryRows(sql) {
  const out = execSync(`npx wrangler d1 execute peninsula-homes --remote --json --command=${JSON.stringify(sql)}`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results || [];
}

const queue = queryRows(
  "SELECT property_id, url FROM properties WHERE school_high IS NULL AND status != 'sold' ORDER BY last_checked ASC"
).map((t) => ({ ...t, tries: 0 }));
const urlById = new Map(queue.map((t) => [t.property_id, t.url]));
console.log(`${queue.length} properties missing school zoning`);

let done = 0;
const pending = []; // { property_id, schools: [{ level, name, rating }] }

async function flush() {
  if (!pending.length) return;
  // Transient network/API failures must not kill the run — retry with pauses,
  // then requeue so the data is collected again.
  const batch = pending.slice();
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API_BASE + '/api/schools', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(SCAN_TOKEN ? { 'x-scan-token': SCAN_TOKEN } : {}) },
        body: JSON.stringify({ updates: batch }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const j = await res.json();
      console.log(`-- saved ${j.saved} school updates via API`);
      pending.length = 0;
      return;
    } catch (e) {
      console.log(`  API write failed (attempt ${attempt}/4): ${String(e.message).slice(0, 120)}`);
      if (attempt < 4) await sleep(15000 * attempt);
    }
  }
  console.log(`  API write failed 4x; requeueing ${pending.length} properties`);
  for (const u of batch) queue.push({ property_id: u.property_id, url: urlById.get(u.property_id), tries: 0 });
  pending.length = 0;
}

while (queue.length && done < LIMIT && (Date.now() - started) / 60000 < MAX_MINUTES) {
  const t = queue.shift();

  const r = await fetchPage(t.url);
  if (!r.ok) {
    t.tries++;
    if (t.tries >= 20) {
      console.log(`  giving up on ${t.property_id} after ${t.tries} tries`);
    } else {
      queue.push(t);
    }
    // Every challenged request extends the block, so rest immediately and let
    // the WAF cycle (~10-15 min) fully pass before the next attempt.
    console.log(`  challenged; resting 12.5min — ${queue.length} left in queue`);
    await sleep(750000);
    continue;
  }

  const d = parseDetail(r.text);
  if (d.schools.length) {
    const byLevel = {};
    for (const s of d.schools) if (s.level && !byLevel[s.level]) byLevel[s.level] = s;
    const e = byLevel.elementary, m = byLevel.middle, h = byLevel.high;
    pending.push({
      property_id: t.property_id,
      schools: [
        ...(e ? [{ level: 'elementary', name: e.name, rating: e.rating ?? null }] : []),
        ...(m ? [{ level: 'middle', name: m.name, rating: m.rating ?? null }] : []),
        ...(h ? [{ level: 'high', name: h.name, rating: h.rating ?? null }] : []),
      ],
    });
    done++;
    console.log(`[${done}] ${t.property_id}: ${[e?.name, m?.name, h?.name].filter(Boolean).join(' / ')}`);
    if (pending.length >= 2) await flush();
  } else {
    console.log(`  ${t.property_id}: page loaded but no schools block (status=${d.status})`);
  }
  await sleep(20000); // conservative pacing inside an open burst
}

await flush();
console.log(`done: ${done} collected, ${queue.length} remaining`);
