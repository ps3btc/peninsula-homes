// Email notifications via Mailjet.
//
// When a new listing is found, send an email to the configured recipients
// with all property details. Uses Mailjet's transactional email API.

import { getUpcomingOpenHouses } from './db.js';

const MAILJET_API = 'https://api.mailjet.com/v3.1/send';
const RECIPIENTS = [
  'hareesh.nagarajan@gmail.com',
  'divya.ramamurthy@gmail.com',
];
const FROM_EMAIL = 'alerts@loglinearexplorations.online';
const FROM_NAME = 'Peninsula Homes';

/**
 * Send an email via Mailjet. Returns { ok, error? }.
 */
export async function sendMailjet(env, { to, subject, text, html }) {
  const auth = btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`);
  const body = {
    Messages: [
      {
        From: { Email: FROM_EMAIL, Name: FROM_NAME },
        To: to.map((email) => ({ Email: email })),
        Subject: subject,
        TextPart: text,
        HTMLPart: html,
      },
    ],
  };
  let res;
  try {
    res = await fetch(MAILJET_API, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.Messages || data.Messages[0]?.Status !== 'success') {
    return { ok: false, error: data.Messages?.[0]?.Errors?.[0]?.Message || `HTTP ${res.status}` };
  }
  return { ok: true };
}

/**
 * Format a home's details into a plain-text email body.
 */
export function formatHomeText(home) {
  const lines = [
    `Address: ${home.address}`,
    `${home.city}, CA ${home.zip || ''}`,
    '',
    `Price: $${(home.price || 0).toLocaleString('en-US')}`,
    `Beds: ${home.beds ?? '—'}`,
    `Baths: ${home.baths ?? '—'}`,
    `Sqft: ${home.sqft ? home.sqft.toLocaleString('en-US') : '—'}`,
    `Lot size: ${home.lot_size ? home.lot_size.toLocaleString('en-US') + ' sqft' : '—'}`,
    `Year built: ${home.year_built || '—'}`,
  ];
  if (home.dom) lines.push(`Days on market: ${home.dom}`);
  if (home.listed_date) lines.push(`Listed: ${home.listed_date}`);
  if (home.last_sold_year) lines.push(`Last sold: ${home.last_sold_year}`);
  if (home.school_elementary || home.school_middle || home.school_high) {
    lines.push('');
    lines.push('School zoning:');
    if (home.school_elementary) lines.push(`  Elementary: ${home.school_elementary}${home.school_elementary_rating ? ` (${home.school_elementary_rating}/10)` : ''}`);
    if (home.school_middle) lines.push(`  Middle: ${home.school_middle}${home.school_middle_rating ? ` (${home.school_middle_rating}/10)` : ''}`);
    if (home.school_high) lines.push(`  High: ${home.school_high}${home.school_high_rating ? ` (${home.school_high_rating}/10)` : ''}`);
  } else {
    lines.push('');
    lines.push('School zoning: (being collected — check dashboard shortly)');
  }
  lines.push('');
  lines.push(`View on Redfin: ${home.url}`);
  lines.push('View all listings: https://peninsula-homes.pages.dev/');
  lines.push('');
  lines.push('—');
  lines.push('Peninsula Homes — Los Altos · Mountain View · Palo Alto');
  lines.push('Houses ≤ $6M, refreshed daily from Redfin');
  return lines.join('\n');
}

/**
 * Format a home's details into an HTML email body.
 */
export function formatHomeHtml(home) {
  const rows = [
    ['Address', `<b>${esc(home.address)}</b><br>${esc(home.city)}, CA ${esc(home.zip || '')}`],
    ['Price', `$${(home.price || 0).toLocaleString('en-US')}`],
    ['Beds', home.beds ?? '—'],
    ['Baths', home.baths ?? '—'],
    ['Sqft', home.sqft ? home.sqft.toLocaleString('en-US') : '—'],
    ['Lot size', home.lot_size ? `${home.lot_size.toLocaleString('en-US')} sqft` : '—'],
    ['Year built', home.year_built || '—'],
  ];
  if (home.dom) rows.push(['Days on market', home.dom]);
  if (home.listed_date) rows.push(['Listed', home.listed_date]);
  if (home.last_sold_year) rows.push(['Last sold', home.last_sold_year]);

  let schoolHtml = '';
  if (home.school_elementary || home.school_middle || home.school_high) {
    const schools = [
      ['Elementary', home.school_elementary, home.school_elementary_rating],
      ['Middle', home.school_middle, home.school_middle_rating],
      ['High', home.school_high, home.school_high_rating],
    ];
    schoolHtml = '<h3 style="margin:20px 0 10px 0;font-size:14px;color:#555;">School Zoning</h3><table style="border-collapse:collapse;">';
    for (const [level, name, rating] of schools) {
      if (!name) continue;
      const ratingStr = rating ? ` <span style="color:${rating >= 8 ? '#2e7d32' : rating >= 5 ? '#f57c00' : '#c62828'}">(${rating}/10)</span>` : '';
      schoolHtml += `<tr><td style="padding:4px 12px 4px 0;color:#888;">${level}</td><td style="padding:4px 0;">${esc(name)}${ratingStr}</td></tr>`;
    }
    schoolHtml += '</table>';
  } else {
    schoolHtml = '<p style="margin:20px 0 10px 0;font-size:13px;color:#999;">School zoning: being collected — check dashboard shortly</p>';
  }

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#1976d2;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:20px;">🏡 New Listing</h2>
  </div>
  <div style="padding:20px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
    <table style="border-collapse:collapse;width:100%;">
      ${rows.map(([label, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#888;vertical-align:top;">${label}</td><td style="padding:6px 0;">${value}</td></tr>`).join('')}
    </table>
    ${schoolHtml}
    <div style="margin-top:20px;">
      <a href="${esc(home.url)}" style="display:inline-block;background:#1976d2;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;font-weight:500;">View on Redfin ↗</a>
      <a href="https://peninsula-homes.pages.dev/" style="display:inline-block;background:#fff;color:#1976d2;padding:10px 20px;text-decoration:none;border-radius:4px;font-weight:500;border:1px solid #1976d2;margin-left:8px;">View Dashboard ↗</a>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;color:#888;font-size:12px;">
      <a href="https://peninsula-homes.pages.dev/" style="color:#1976d2;text-decoration:none;">Peninsula Homes Dashboard</a> — Los Altos · Mountain View · Palo Alto<br>
      Houses ≤ $6M, refreshed daily from Redfin
    </div>
  </div>
</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Split valuation reasoning text into individual bullet points.
 * Tries newlines first; if the text is a single paragraph, splits on
 * sentence boundaries (period + space + uppercase letter or dollar amount).
 */
function splitReasoning(text) {
  if (!text) return [];
  // Try newline-separated first.
  const byLines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  if (byLines.length > 1) return byLines;
  // Single block: split on sentence boundaries.
  // Match ". " followed by an uppercase letter, a dollar amount, or a digit.
  const sentences = text.split(/(?<=\.\s)(?=[A-Z$0-9])/).map((s) => s.trim()).filter(Boolean);
  return sentences.length > 1 ? sentences : [text.trim()];
}

/** Format reasoning as an HTML bulleted list for mobile readability. */
function reasoningBulletsHtml(text) {
  const points = splitReasoning(text);
  if (points.length <= 1) return `<p style="margin:0;white-space:pre-wrap;">${esc(text || '')}</p>`;
  return `<ul style="margin:0;padding-left:20px;list-style:disc;">${
    points.map((p) => `<li style="margin-bottom:6px;line-height:1.5;">${esc(p)}</li>`).join('')
  }</ul>`;
}

/** Format reasoning as a plain-text bulleted list. */
function reasoningBulletsText(text) {
  const points = splitReasoning(text);
  if (points.length <= 1) return text || '';
  return points.map((p) => `  • ${p}`).join('\n');
}

/**
 * Called for every brand-new listing that matches the criteria
 * (house in one of the three cities, priced <= $6M).
 * Queries the full property row from the DB (correct snake_case field names,
 * school zoning collected by the scan) and sends an email to the configured
 * recipients with all property details.
 */
export async function onNewListing(db, propertyId, env) {
  // Query the full property row from the DB for correct field names
  // (lot_size, school_elementary, etc.) and any school data collected.
  const home = await db.prepare('SELECT * FROM properties WHERE property_id = ?').bind(propertyId).first();
  if (!home) {
    console.error('onNewListing: property not found:', propertyId);
    return;
  }

  // Record the event in the queue for audit/reliability.
  await db
    .prepare("INSERT INTO notification_queue (property_id, event, payload) VALUES (?,?,?)")
    .bind(propertyId, 'new_listing', JSON.stringify({ address: home.address, city: home.city, price: home.price }))
    .run();

  // Send the email immediately.
  if (!env || !env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY) {
    console.warn('Mailjet credentials not configured; skipping email');
    return;
  }

  const subject = `New Listing: ${home.address}, ${home.city} — $${(home.price || 0).toLocaleString('en-US')}`;
  const text = formatHomeText(home);
  const html = formatHomeHtml(home);

  const result = await sendMailjet(env, { to: RECIPIENTS, subject, text, html });
  if (!result.ok) {
    console.error('Failed to send new-listing email:', result.error);
  }
}

// ---------------------------------------------------------------------------
// Weekly open-house digest

/**
 * Format the weekly open-house digest as plain text.
 * @param {Array} favs – each entry: { property, openHouses: [{date, time, comment}] }
 */
export function formatDigestText(favs) {
  const lines = [
    'Your Peninsula Homes Weekly Open House Digest',
    '==============================================',
    '',
    `${favs.length} favorited propert${favs.length === 1 ? 'y' : 'ies'}:`,
    '',
  ];
  let ohCount = 0;
  for (const { property: p, openHouses: ohs } of favs) {
    lines.push(`${p.address}, ${p.city} — $${(p.price || 0).toLocaleString('en-US')}`);
    lines.push(`  ${p.beds ?? '—'} bd / ${p.baths ?? '—'} ba · ${p.sqft ? p.sqft.toLocaleString('en-US') : '—'} sqft`);
    if (ohs.length) {
      ohCount++;
      lines.push('  Open houses:');
      for (const oh of ohs) {
        const dateStr = formatDate(oh.date);
        lines.push(`    ${dateStr}${oh.time ? ' ' + oh.time : ''}${oh.comment ? ' — ' + oh.comment : ''}`);
      }
    } else {
      lines.push('  No upcoming open houses');
    }
    lines.push(`  Redfin: ${p.url}`);
    lines.push(`  Dashboard: https://peninsula-homes.pages.dev/`);
    lines.push('');
  }
  lines.push('—');
  lines.push(`Summary: ${ohCount} of ${favs.length} favorites have upcoming open houses.`);
  lines.push('Peninsula Homes — Los Altos · Mountain View · Palo Alto');
  return lines.join('\n');
}

/**
 * Format the weekly open-house digest as HTML.
 */
export function formatDigestHtml(favs) {
  let ohCount = 0;
  const cards = favs.map(({ property: p, openHouses: ohs }) => {
    let ohHtml = '';
    if (ohs.length) {
      ohCount++;
      ohHtml = '<div style="margin:8px 0;padding:8px;background:#e3f2fd;border-radius:6px;font-size:13px;">' +
        '<strong style="color:#1565c0;">🗓 Open Houses:</strong><br>' +
        ohs.map((oh) => {
          const dateStr = formatDate(oh.date);
          return `<div style="margin-left:12px;">${esc(dateStr)}${oh.time ? ' ' + esc(oh.time) : ''}${oh.comment ? ' — ' + esc(oh.comment) : ''}</div>`;
        }).join('') +
        '</div>';
    } else {
      ohHtml = '<div style="margin:8px 0;font-size:12px;color:#999;">No upcoming open houses</div>';
    }
    return `
<div style="border:1px solid #e0e0e0;border-radius:8px;padding:14px;margin-bottom:12px;">
  <div style="font-weight:700;font-size:15px;">${esc(p.address)}</div>
  <div style="color:#888;font-size:13px;margin-bottom:6px;">${esc(p.city)}, CA ${esc(p.zip || '')}</div>
  <div style="font-size:14px;margin-bottom:4px;">
    <strong>$${(p.price || 0).toLocaleString('en-US')}</strong>
    <span style="color:#888;margin-left:8px;">${p.beds ?? '—'} bd / ${p.baths ?? '—'} ba · ${p.sqft ? p.sqft.toLocaleString('en-US') : '—'} sqft</span>
  </div>
  ${ohHtml}
  <div style="margin-top:8px;">
    <a href="${esc(p.url)}" style="display:inline-block;background:#1976d2;color:#fff;padding:6px 14px;text-decoration:none;border-radius:4px;font-size:12px;font-weight:500;">View on Redfin ↗</a>
    <a href="https://peninsula-homes.pages.dev/" style="display:inline-block;color:#1976d2;padding:6px 14px;text-decoration:none;font-size:12px;margin-left:4px;">Dashboard ↗</a>
  </div>
</div>`;
  }).join('');

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#1976d2;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:18px;">📬 Weekly Open House Digest</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:.85;">${ohCount} of ${favs.length} favorites have upcoming open houses</p>
  </div>
  <div style="padding:20px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
    ${cards}
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e0e0e0;color:#888;font-size:12px;">
      <a href="https://peninsula-homes.pages.dev/" style="color:#1976d2;text-decoration:none;">Peninsula Homes Dashboard</a> — Los Altos · Mountain View · Palo Alto
    </div>
  </div>
</div>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Query all favorited properties with upcoming open houses, send digest email.
 * Returns { sent, error?, favoritesCount, openHouseCount }.
 */
export async function sendWeeklyDigest(db, env) {
  if (!env || !env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY) {
    return { sent: false, error: 'Mailjet credentials not configured' };
  }

  // Get all favorited properties (active only) — global community list.
  const { results: favRows } = await db
    .prepare(
      `SELECT DISTINCT property_id FROM favorites`
    )
    .all();

  if (!favRows.length) return { sent: true, favoritesCount: 0, openHouseCount: 0 };

  const propertyIds = favRows.map((r) => r.property_id);

  // Only include active listings in the digest.
  const placeholders = propertyIds.map(() => '?').join(',');
  const { results: properties } = await db
    .prepare(`SELECT * FROM properties WHERE property_id IN (${placeholders}) AND status = 'active'`)
    .bind(...propertyIds)
    .all();

  if (!properties.length) return { sent: true, favoritesCount: 0, openHouseCount: 0 };

  const activeIds = properties.map((p) => p.property_id);

  // Fetch upcoming open houses for these properties.
  const openHouses = await getUpcomingOpenHouses(db, activeIds);
  const ohByProp = {};
  for (const oh of openHouses) {
    (ohByProp[oh.property_id] = ohByProp[oh.property_id] || []).push(oh);
  }

  // Build the digest entries.
  const favs = properties.map((p) => ({
    property: p,
    openHouses: ohByProp[p.property_id] || [],
  }));

  const ohCount = favs.filter((f) => f.openHouses.length > 0).length;
  const subject = `📬 Weekly Open House Digest — ${ohCount} favorite${ohCount === 1 ? '' : 's'} with open houses`;

  const text = formatDigestText(favs);
  const html = formatDigestHtml(favs);

  const result = await sendMailjet(env, { to: RECIPIENTS, subject, text, html });
  return {
    sent: result.ok,
    error: result.error || null,
    favoritesCount: favs.length,
    openHouseCount: ohCount,
  };
}

/**
 * Placeholder for future batch delivery of queued notifications.
 * Currently a no-op since emails are sent immediately in onNewListing.
 */
export async function deliverPendingNotifications(_db, _env) {
  return 0;
}

// ---------------------------------------------------------------------------
// Valuation completion email (summary of ALL favorited properties)

/**
 * Send an email when a valuation has been compiled for a favorited property.
 * The email summarizes every currently favorited property's valuation in a
 * table (address, estimated value, list price, difference, confidence),
 * highlighting the property that was just valued.
 */
export async function sendValuationSummary(db, env, justValuedId) {
  if (!env || !env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY) {
    console.warn('Mailjet credentials not configured; skipping valuation email');
    return { sent: false, error: 'Mailjet not configured' };
  }

  // All favorited properties (any status) joined with their valuations.
  const { results: rows } = await db
    .prepare(
      `SELECT p.property_id, p.address, p.city, p.zip, p.price, p.status, p.url,
              v.estimated_value, v.confidence, v.reasoning, v.price_per_sqft, v.comparables_used
       FROM favorites f
       INNER JOIN properties p ON p.property_id = f.property_id
       LEFT JOIN valuations v ON v.property_id = p.property_id
       ORDER BY (v.estimated_value IS NULL), p.city, p.address`
    )
    .all();

  if (!rows.length) return { sent: false, error: 'no favorites' };
  const justValued = rows.find((r) => r.property_id === justValuedId) || null;
  const valuedCount = rows.filter((r) => r.estimated_value != null).length;

  const subject = justValued
    ? `Valuation Complete: ${justValued.address}, ${justValued.city} — $${justValued.estimated_value.toLocaleString('en-US')} (${valuedCount}/${rows.length} favorites valued)`
    : `Favorites Valuation Summary — ${valuedCount}/${rows.length} valued`;

  // --- Plain-text version ---
  const textLines = [
    'Favorites Valuation Summary',
    '===========================',
    '',
    `Address | Estimated | List Price | Difference | Confidence`,
  ];
  for (const r of rows) {
    const marker = r.property_id === justValuedId ? '* ' : '  ';
    if (r.estimated_value == null) {
      textLines.push(`${marker}${r.address}, ${r.city} | PENDING | $${(r.price || 0).toLocaleString('en-US')} | — | —`);
    } else {
      const diff = r.estimated_value - (r.price || 0);
      const diffLabel = (diff >= 0 ? '+' : '\u2212') + '$' + Math.abs(diff).toLocaleString('en-US');
      textLines.push(`${marker}${r.address}, ${r.city} | $${r.estimated_value.toLocaleString('en-US')} | $${(r.price || 0).toLocaleString('en-US')} | ${diffLabel} | ${r.confidence}`);
    }
  }
  if (justValued && justValued.reasoning) {
    textLines.push('', `Analysis for ${justValued.address}:`, reasoningBulletsText(justValued.reasoning));
  }
  textLines.push('', `Dashboard: https://peninsula-homes.pages.dev/`, '', '\u2014', 'Peninsula Homes — Los Altos \u00b7 Mountain View \u00b7 Palo Alto');

  // --- HTML version ---
  const confBadge = (c) => {
    const colors = { high: '#2e7d32', medium: '#f57c00', low: '#c62828' };
    const bg = colors[c] || '#757575';
    return `<span style="color:#fff;background:${bg};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:capitalize;">${esc(c)}</span>`;
  };
  const tableRows = rows.map((r) => {
    const isNew = r.property_id === justValuedId;
    const rowBg = isNew ? '#e8f5e9' : (r.status === 'active' ? '#fff' : '#fafafa');
    let est = '—', diff = '—', conf = '<span style="color:#999;font-size:12px;">Pending\u2026</span>';
    if (r.estimated_value != null) {
      const d = r.estimated_value - (r.price || 0);
      est = `<b>$${r.estimated_value.toLocaleString('en-US')}</b>`;
      diff = `<span style="color:${d >= 0 ? '#2e7d32' : '#c62828'};">${d >= 0 ? '+' : '\u2212'}$${Math.abs(d).toLocaleString('en-US')}</span>`;
      conf = confBadge(r.confidence);
    }
    return `<tr style="background:${rowBg};">
      <td style="padding:8px;border-bottom:1px solid #eee;">${isNew ? '\ud83c\udf1f ' : ''}<a href="${esc(r.url)}" style="color:#1565c0;text-decoration:none;">${esc(r.address)}</a><br><span style="color:#888;font-size:11px;">${esc(r.city)}, CA${r.status !== 'active' ? ' \u00b7 ' + esc(r.status) : ''}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${est}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">$${(r.price || 0).toLocaleString('en-US')}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${diff}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${conf}</td>
    </tr>`;
  }).join('');

  const reasoningBlock = justValued && justValued.reasoning
    ? `<div style="background:#f5f5f5;padding:12px;border-radius:6px;margin-top:16px;font-size:13px;color:#555;">
        <strong style="display:block;margin-bottom:8px;">Analysis \u2014 ${esc(justValued.address)}:</strong>
        ${reasoningBulletsHtml(justValued.reasoning)}
      </div>`
    : '';

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;">
  <div style="background:#2e7d32;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:20px;">\ud83c\udfe0 Valuation Complete</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:.85;">${valuedCount} of ${rows.length} favorited homes have valuations</p>
  </div>
  <div style="padding:20px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
    ${justValued ? `<p style="margin:0 0 12px;font-size:14px;">New valuation for <b>${esc(justValued.address)}, ${esc(justValued.city)}</b>: <b style="color:#2e7d32;">$${justValued.estimated_value.toLocaleString('en-US')}</b> ${confBadge(justValued.confidence)}</p>` : ''}
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <tr style="background:#f5f5f5;color:#666;">
        <th style="padding:8px;border-bottom:2px solid #ddd;text-align:left;">Property</th>
        <th style="padding:8px;border-bottom:2px solid #ddd;text-align:right;">Estimated</th>
        <th style="padding:8px;border-bottom:2px solid #ddd;text-align:right;">List Price</th>
        <th style="padding:8px;border-bottom:2px solid #ddd;text-align:right;">Diff</th>
        <th style="padding:8px;border-bottom:2px solid #ddd;text-align:center;">Confidence</th>
      </tr>
      ${tableRows}
    </table>
    ${reasoningBlock}
    <div style="margin-top:20px;">
      <a href="https://peninsula-homes.pages.dev/" style="display:inline-block;background:#1976d2;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;font-weight:500;">View Dashboard \u2197</a>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;color:#888;font-size:12px;">
      <a href="https://peninsula-homes.pages.dev/" style="color:#1976d2;text-decoration:none;">Peninsula Homes Dashboard</a> \u2014 Los Altos \u00b7 Mountain View \u00b7 Palo Alto
    </div>
  </div>
</div>`;

  const result = await sendMailjet(env, { to: RECIPIENTS, subject, text: textLines.join('\n'), html });
  if (!result.ok) console.error('Failed to send valuation summary email:', result.error);
  return { sent: result.ok, error: result.error || null, favorites: rows.length, valued: valuedCount };
}
