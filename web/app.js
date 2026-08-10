// Peninsula Homes dashboard client.

// localStorage override lets dev/preview point at a local worker.
const API = (localStorage.getItem('peninsulaApi') || window.API_BASE || '').replace(/\/$/, '');
const $ = (sel) => document.querySelector(sel);

const state = { status: 'active' };

const fmtMoney = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US');
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path) {
  const res = await fetch(API + path);
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
    if (s.lastScan && s.lastScan.finished_at) {
      const d = new Date(s.lastScan.finished_at);
      $('#last-scan').textContent = 'Last scan ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  } catch {
    /* dashboard still renders listings */
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
      : `<span class="src">${l.status === 'pending' && l.status_source === 'inferred' ? 'pending (inferred)' : esc(l.status_source || '')}</span>`;

  return `<article class="card">
    <div class="row1">
      <span class="price">${fmtMoney(l.status === 'sold' ? l.sold_price : l.price)}<small>${
        l.sqft ? '$' + fmtNum(Math.round((l.status === 'sold' ? l.sold_price || l.price : l.price) / l.sqft)) + '/sqft' : ''
      }</small></span>
      <span class="badge ${esc(l.status)}">${l.status === 'active' ? 'Available' : esc(l.status)}</span>
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
    <div class="schools">${schools || '<span class="none">School zoning being collected…</span>'}</div>
    <div class="foot-row">
      ${soldLine}
      <a class="redfin-link" href="${esc(l.url)}" target="_blank" rel="noopener">Redfin listing ↗</a>
    </div>
  </article>`;
}

function render(listings) {
  const grid = $('#grid');
  $('#empty').classList.toggle('hidden', listings.length > 0);
  grid.innerHTML = listings.map(card).join('');
}

// --- wiring -----------------------------------------------------------------

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  state.status = btn.dataset.status;
  if (state.status === 'sold' && $('#f-sort').value === 'newest') $('#f-sort').value = 'sold_desc';
  loadListings();
});

for (const id of ['f-city', 'f-price', 'f-beds', 'f-sort']) {
  $('#' + id).addEventListener('change', () => {
    loadStats();
    loadListings();
  });
}
let qTimer;
$('#f-q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    loadStats();
    loadListings();
  }, 350);
});
$('#refresh').addEventListener('click', () => {
  loadStats();
  loadListings();
});

loadStats();
loadListings();
setInterval(() => {
  loadStats();
  loadListings();
}, 5 * 60 * 1000);
