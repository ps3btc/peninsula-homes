// Peninsula Homes dashboard client.

// localStorage override lets dev/preview point at a local worker.
const API = (localStorage.getItem('peninsulaApi') || window.API_BASE || '').replace(/\/$/, '');
const $ = (sel) => document.querySelector(sel);

const state = { status: 'favorites', favoriteIds: new Set(), valuations: {} };

const fmtMoney = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US');
const fmtMoneyCompact = (n) =>
  n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2).replace(/0$/, '') + 'M' : fmtMoney(n);
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiMutate(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiDelete(path, body) {
  const res = await fetch(API + path, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// Filters shared by the listings request and the stats (tab counts) request,
// so the counts always match what is actually shown.
function filterParams() {
  const p = new URLSearchParams();
  const city = $('#f-city').value; if (city) p.set('city', city);
  const price = $('#f-price').value; if (price) p.set('maxPrice', price);
  const beds = $('#f-beds').value; if (beds) p.set('minBeds', beds);
  const q = $('#f-q').value.trim(); if (q) p.set('q', q);
  return p;
}

async function loadStats() {
  try {
    const s = await api('/api/stats?' + filterParams().toString());
    $('#count-active').textContent = s.counts.active ?? 0;
    $('#count-pending').textContent = s.counts.pending ?? 0;
    $('#count-sold').textContent = s.counts.sold ?? 0;
    $('#count-favorites').textContent = state.favoriteIds.size;
    if (s.lastScan && s.lastScan.finished_at) {
      const d = new Date(s.lastScan.finished_at);
      $('#last-scan').textContent = 'Last scan ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  } catch {
    /* dashboard still renders listings */
  }
}

/** Fetch the global favorited property IDs from the server. */
async function loadFavoriteIds() {
  try {
    const data = await api('/api/favorite-ids');
    const newIds = new Set(data.favoriteIds || []);
    const changed = !setsEqual(newIds, state.favoriteIds);
    state.favoriteIds = newIds;
    $('#count-favorites').textContent = state.favoriteIds.size;
    // Load valuations for all favorited properties.
    if (newIds.size) loadValuations([...newIds]);
    return changed;
  } catch {
    return false;
  }
}

/** Fetch valuations for a set of property IDs. */
async function loadValuations(ids) {
  try {
    const data = await api('/api/valuations?ids=' + ids.join(','));
    const map = {};
    for (const v of (data.valuations || [])) {
      map[v.property_id] = v;
    }
    state.valuations = map;
    // Re-render if we're on the favorites tab to show valuation badges
    // (but never while the detailed valuation page is open).
    if (state.status === 'favorites' && !inDetailView()) loadFavorites();
  } catch {
    /* non-critical */
  }
}

/** Compare two Sets for equality. */
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Fetch and render the Favorites tab (active listings only). */
async function loadFavorites() {
  const grid = $('#grid');
  grid.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const data = await api('/api/favorites');
    const listings = data.listings || [];
    $('#count-favorites').textContent = listings.length;
    render(listings);
  } catch (e) {
    grid.innerHTML = `<p class="empty">Could not load favorites (${esc(e.message)}).</p>`;
  }
}

async function loadListings() {
  const p = filterParams();
  p.set('status', state.status);
  p.set('sort', $('#f-sort').value);

  const grid = $('#grid');
  grid.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const data = await api('/api/listings?' + p.toString());
    render(data.listings || []);
  } catch (e) {
    grid.innerHTML = `<p class="empty">Could not reach the API (${esc(e.message)}). Is the worker deployed?</p>`;
  }
}

function schoolRow(level, name, rating) {
  if (!name) return '';
  const cls = rating == null ? '' : rating >= 8 ? 'hi' : rating >= 5 ? 'mid' : 'lo';
  return `<div class="school"><span class="lvl">${level}</span><span class="name">${esc(name)}</span>${
    rating != null ? `<span class="rating ${cls}">${rating}/10</span>` : ''
  }</div>`;
}

function card(l) {
  const schools =
    schoolRow('Elem', l.school_elementary, l.school_elementary_rating) +
    schoolRow('Middle', l.school_middle, l.school_middle_rating) +
    schoolRow('High', l.school_high, l.school_high_rating);
  const soldLine =
    l.status === 'sold'
      ? `<span class="soldinfo">Sold ${fmtMoney(l.sold_price)}${l.sold_date ? ' · ' + esc(l.sold_date) : ''}</span>`
      : '';
  const sourceLine =
    l.status === 'pending' && l.status_source === 'inferred'
      ? `<span class="src">pending (inferred)</span>`
      : '';
  const isFav = state.favoriteIds.has(l.property_id);
  const val = state.valuations[l.property_id];
  let valBadge = '';
  if (isFav && l.status === 'active') {
    if (val) {
      const confLabel = val.confidence === 'high' ? 'High' : val.confidence === 'low' ? 'Low' : 'Medium';
      const confCls = val.confidence === 'high' ? 'hi' : val.confidence === 'low' ? 'lo' : 'mid';
      valBadge = `<a class="val-badge" href="#valuation/${l.property_id}" title="View full valuation report"><span class="val-label">Est. Value</span> ${fmtMoneyCompact(val.estimated_value)} &middot; <span class="val-conf ${confCls}">${confLabel} Confidence</span></a>`;
    } else {
      valBadge = `<span class="val-badge pending" title="Valuation queued \u2014 compiled after browser research on the listing page"><span class="val-label">Est. Value</span> pending\u2026</span>`;
    }
  }

  return `<article class="card" data-pid="${l.property_id}">
    <div class="row1">
      <span class="price">${fmtMoney(l.status === 'sold' ? l.sold_price : l.price)}<small>${
        l.sqft ? '$' + fmtNum(Math.round((l.status === 'sold' ? l.sold_price || l.price : l.price) / l.sqft)) + '/sqft' : ''
      }</small></span>
      <span class="badge ${esc(l.status)}">${l.status === 'active' ? 'Available' : esc(l.status)}</span>
      <button class="fav-btn${isFav ? ' active' : ''}" data-fav="${l.property_id}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '♥' : '♡'}</button>
    </div>
    <div>
      <div class="addr">${esc(l.address)}</div>
      <div class="cityline">${esc(l.city)}, CA ${esc(l.zip)}${l.dom ? ` · ${l.dom} days on market` : ''}${l.year_built ? ` · built ${l.year_built}` : ''}${l.last_sold_year ? ` · last sold ${l.last_sold_year}` : ''}</div>
    </div>
    <div class="chips">
      <span class="chip"><b>${l.beds ?? '—'}</b> bd</span>
      <span class="chip"><b>${l.baths ?? '—'}</b> ba</span>
      <span class="chip"><b>${fmtNum(l.sqft)}</b> sqft</span>
      <span class="chip"><b>${fmtNum(l.lot_size)}</b> lot</span>
    </div>
    <div class="schools">${schools || '<span class="none">School zoning being collected\u2026</span>'}</div>
    ${valBadge ? `<div>${valBadge}</div>` : ''}
    <div class="foot-row">
      ${soldLine}${sourceLine}
      <a class="redfin-link" href="${esc(l.url)}" target="_blank" rel="noopener">Redfin listing ↗</a>
    </div>
  </article>`;
}

function render(listings) {
  const grid = $('#grid');
  $('#empty').classList.toggle('hidden', listings.length > 0);
  grid.innerHTML = listings.map(card).join('');
}

// --- valuation detail page ---------------------------------------------------
// Full-page view at #valuation/<propertyId>: estimated value, confidence,
// price/sqft, comparable sales used, reasoning, and listing links.

/** Slugify a string for URL construction (lowercase, hyphens, no special chars). */
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Get the Redfin URL for a comparable — use stored URL or construct from address. */
function compRedfinUrl(c) {
  if (c.url) return c.url;
  if (c.address && c.city) {
    return `https://www.redfin.com/CA/${slugify(c.city)}/${slugify(c.address)}`;
  }
  return null;
}

function compRow(c) {
  const price = c.price != null ? fmtMoney(c.price) : '—';
  const ppsf = c.price != null && c.sqft ? '$' + fmtNum(Math.round(c.price / c.sqft)) : '—';
  const typeLabel = c.type === 'sold' ? `Sold${c.sold_date ? ' ' + esc(c.sold_date) : ''}` : c.type === 'active' ? 'Active' : esc(c.type || 'Comp');
  const addrHtml = c.url
    ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.address || '—')}</a>`
    : esc(c.address || '—');
  const redfinUrl = compRedfinUrl(c);
  const viewLink = redfinUrl
    ? `<a class="comp-view-link" href="${esc(redfinUrl)}" target="_blank" rel="noopener" title="View on Redfin">View &nearr;</a>`
    : '<span class="muted" style="font-size:11px;">—</span>';
  return `<tr>
    <td>${addrHtml}<span class="comp-city">${esc(c.city || '')}</span></td>
    <td class="num">${typeLabel}</td>
    <td class="num">${price}</td>
    <td class="num">${c.beds ?? '—'} bd / ${c.baths ?? '—'} ba</td>
    <td class="num">${fmtNum(c.sqft)}</td>
    <td class="num">${ppsf}</td>
    <td class="num comp-view-cell">${viewLink}</td>
  </tr>`;
}

/** Render a comparable as a compact card for mobile. */
function compCard(c) {
  const price = c.price != null ? fmtMoney(c.price) : '—';
  const ppsf = c.price != null && c.sqft ? '$' + fmtNum(Math.round(c.price / c.sqft)) : '—';
  const typeLabel = c.type === 'sold' ? `Sold${c.sold_date ? ' ' + esc(c.sold_date) : ''}` : c.type === 'active' ? 'Active' : esc(c.type || 'Comp');
  const redfinUrl = compRedfinUrl(c);
  const viewLink = redfinUrl
    ? `<a class="comp-view-link" href="${esc(redfinUrl)}" target="_blank" rel="noopener">View on Redfin &nearr;</a>`
    : '';
  return `<div class="comp-card">
    <div class="comp-card-header">
      <span class="comp-card-addr">${esc(c.address || '—')}, ${esc(c.city || '')}</span>
      <span class="comp-card-type">${typeLabel}</span>
    </div>
    <div class="comp-card-stats">
      <span class="comp-card-price">${price}</span>
      <span class="comp-card-detail">${c.beds ?? '—'} bd / ${c.baths ?? '—'} ba &middot; ${fmtNum(c.sqft)} sqft</span>
      <span class="comp-card-ppsf">${ppsf}/sqft</span>
    </div>
    ${viewLink ? `<div class="comp-card-link">${viewLink}</div>` : ''}
  </div>`;
}

function valuationDetailHtml({ property: p, valuation: v, comps }) {
  const listPrice = p.price || 0;
  const diff = v.estimated_value - listPrice;
  const diffPct = listPrice > 0 ? ((diff / listPrice) * 100).toFixed(1) : null;
  const diffCls = diff >= 0 ? 'above' : 'below';
  const confLabel = v.confidence === 'high' ? 'High Confidence' : v.confidence === 'low' ? 'Low Confidence' : 'Medium Confidence';
  const confCls = v.confidence === 'high' ? 'hi' : v.confidence === 'low' ? 'lo' : 'mid';
  const zillowSearch = `https://www.zillow.com/homes/${encodeURIComponent(`${p.address}, ${p.city}, CA ${p.zip || ''}`)}`;
  const valuedDate = v.created_at ? new Date(v.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

  const compsHtml = comps.length
    ? `<div class="comp-table-wrap"><table class="comp-table">
        <thead><tr><th>Comparable</th><th>Status</th><th>Price</th><th>Bd/Ba</th><th>Sqft</th><th>$/Sqft</th><th></th></tr></thead>
        <tbody>${comps.map(compRow).join('')}</tbody>
      </table></div>
      <div class="comp-cards">${comps.map(compCard).join('')}</div>`
    : '<p class="empty">No comparables recorded for this valuation.</p>';

  return `<div class="val-detail">
    <a class="back-link" href="#">&larr; Back to listings</a>
    <div class="vd-header">
      <div>
        <h2 class="vd-addr">${esc(p.address)}</h2>
        <div class="vd-cityline">${esc(p.city)}, CA ${esc(p.zip || '')} &middot; ${p.beds ?? '—'} bd / ${p.baths ?? '—'} ba &middot; ${fmtNum(p.sqft)} sqft${p.lot_size ? ` &middot; ${fmtNum(p.lot_size)} sqft lot` : ''}${p.year_built ? ` &middot; built ${p.year_built}` : ''}</div>
      </div>
      <span class="vd-conf ${confCls}">${confLabel}</span>
    </div>
    <div class="vd-stats">
      <div class="vd-stat">
        <span class="vd-label">Estimated Market Value</span>
        <span class="vd-value green">${fmtMoney(v.estimated_value)}</span>
        ${listPrice ? `<span class="vd-diff ${diffCls}">${diff >= 0 ? '+' : '\u2212'}$${Math.abs(diff).toLocaleString('en-US')} vs list${diffPct != null ? ` (${diff >= 0 ? '+' : '\u2212'}${Math.abs(diffPct)}%)` : ''}</span>` : ''}
      </div>
      <div class="vd-stat">
        <span class="vd-label">List Price</span>
        <span class="vd-value">${fmtMoney(listPrice)}</span>
      </div>
      <div class="vd-stat">
        <span class="vd-label">Price / Sqft</span>
        <span class="vd-value">${v.price_per_sqft ? '$' + fmtNum(v.price_per_sqft) : '—'}</span>
        <span class="vd-sub">estimated</span>
      </div>
      <div class="vd-stat">
        <span class="vd-label">Comparables Used</span>
        <span class="vd-value">${v.comparables_used ?? comps.length}</span>
      </div>
    </div>
    <h3>Comparable Sales Analysis</h3>
    ${compsHtml}
    <h3>Valuation Reasoning</h3>
    ${reasoningBullets(v.reasoning)}
    <div class="vd-meta">
      Valuation compiled ${valuedDate} &middot; via browser research (${esc(v.model || 'manual-browser')})
    </div>
    <div class="vd-links">
      <a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">Redfin listing &nearr;</a>
      <a class="btn ghost" href="${esc(zillowSearch)}" target="_blank" rel="noopener">Search on Zillow &nearr;</a>
    </div>
  </div>`;
}

async function showValuationDetail(pid) {
  const grid = $('#grid');
  $('#empty').classList.add('hidden');
  grid.innerHTML = '<p class="empty">Loading valuation&hellip;</p>';
  try {
    const data = await api('/api/valuation/' + pid);
    grid.innerHTML = valuationDetailHtml(data);
  } catch {
    grid.innerHTML = `<div class="val-detail"><a class="back-link" href="#">&larr; Back to listings</a><p class="empty">No valuation available for this property yet — it shows as pending on the dashboard.</p></div>`;
  }
}

// Hash routing: #valuation/<id> opens the detailed valuation page.
const inDetailView = () => /^#valuation\/\d+$/.test(location.hash);

/** Split valuation reasoning into bullet points for readable display. */
function reasoningBullets(text) {
  if (!text) return '<p class="vd-reasoning">No reasoning recorded.</p>';
  const byLines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const points = byLines.length > 1
    ? byLines
    : text.split(/(?<=\.\s)(?=[A-Z$0-9])/).map((s) => s.trim()).filter(Boolean);
  if (points.length <= 1) return `<p class="vd-reasoning">${esc(text)}</p>`;
  return `<ul class="vd-reasoning-list">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
}
function routeFromHash() {
  const m = location.hash.match(/^#valuation\/(\d+)$/);
  if (m) showValuationDetail(Number(m[1]));
  return !!m;
}
window.addEventListener('hashchange', () => {
  if (!routeFromHash()) {
    // Returning to the main view: re-render the current tab.
    if (state.status === 'favorites') loadFavorites();
    else loadListings();
    loadStats();
  }
});

// --- wiring -----------------------------------------------------------------

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  state.status = btn.dataset.status;
  if (state.status === 'sold' && $('#f-sort').value === 'newest') $('#f-sort').value = 'sold_desc';
  if (state.status === 'favorites') {
    loadFavorites();
  } else {
    loadListings();
  }
});

// Heart toggle via event delegation on the grid.
$('#grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('.fav-btn');
  if (!btn) return;
  const pid = Number(btn.dataset.fav);
  if (!pid) return;
  const isFav = state.favoriteIds.has(pid);
  try {
    if (isFav) {
      await apiDelete('/api/favorite', { propertyId: pid });
      state.favoriteIds.delete(pid);
    } else {
      await apiMutate('/api/favorite', { propertyId: pid });
      state.favoriteIds.add(pid);
    }
    // Update the button appearance in-place.
    btn.classList.toggle('active', !isFav);
    btn.textContent = !isFav ? '♥' : '♡';
    btn.title = !isFav ? 'Remove from favorites' : 'Add to favorites';
    btn.setAttribute('aria-label', btn.title);
    $('#count-favorites').textContent = state.favoriteIds.size;
    // If on the Favorites tab, remove cards that were just unfavorited.
    if (state.status === 'favorites' && isFav) {
      const cardEl = btn.closest('.card');
      if (cardEl) cardEl.remove();
      // Show empty message if no cards left.
      const remaining = $('#grid').querySelectorAll('.card').length;
      $('#empty').classList.toggle('hidden', remaining > 0);
    }
  } catch (err) {
    console.error('Favorite toggle failed:', err);
  }
});

for (const id of ['f-city', 'f-price', 'f-beds', 'f-sort']) {
  $('#' + id).addEventListener('change', () => {
    loadStats();
    if (state.status === 'favorites') loadFavorites();
    else loadListings();
  });
}
let qTimer;
$('#f-q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    loadStats();
    if (state.status === 'favorites') loadFavorites();
    else loadListings();
  }, 350);
});
$('#refresh').addEventListener('click', () => {
  loadStats();
  if (state.status === 'favorites') loadFavorites();
  else loadListings();
});

loadFavoriteIds().then(() => {
  loadStats();
  if (!routeFromHash()) {
    // Default to Favorites tab on initial load.
    document.querySelector('.tab[data-status="favorites"]').classList.add('active');
    document.querySelector('.tab[data-status="active"]').classList.remove('active');
    loadFavorites();
  }
});

// Poll for global favorites changes every 10 seconds so all visitors
// see updates in near-real-time (anyone favoriting/unfavoriting propagates).
setInterval(async () => {
  const changed = await loadFavoriteIds();
  if (inDetailView()) {
    loadStats();
    return; // don't clobber the detailed valuation page
  }
  if (changed) {
    // Re-render the current view so heart icons stay in sync.
    if (state.status === 'favorites') {
      loadFavorites();
    } else {
      loadListings();
    }
  } else if (state.favoriteIds.size) {
    // Even if favorites didn't change, refresh valuations (they may have completed).
    loadValuations([...state.favoriteIds]);
  }
  loadStats();
}, 10 * 1000);

// Full refresh every 5 minutes (listings + stats + favorites).
setInterval(() => {
  if (inDetailView()) return;
  loadStats();
  if (state.status === 'favorites') {
    loadFavorites();
  } else {
    loadListings();
  }
}, 5 * 60 * 1000);
