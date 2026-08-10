// Email notifications via Mailjet.
//
// When a new listing is found, send an email to the configured recipients
// with all property details. Uses Mailjet's transactional email API.

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
  if (home.school_elementary) {
    lines.push('');
    lines.push('School zoning:');
    lines.push(`  Elementary: ${home.school_elementary}${home.school_elementary_rating ? ` (${home.school_elementary_rating}/10)` : ''}`);
    if (home.school_middle) lines.push(`  Middle: ${home.school_middle}${home.school_middle_rating ? ` (${home.school_middle_rating}/10)` : ''}`);
    if (home.school_high) lines.push(`  High: ${home.school_high}${home.school_high_rating ? ` (${home.school_high_rating}/10)` : ''}`);
  }
  lines.push('');
  lines.push(`View on Redfin: ${home.url}`);
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
  if (home.school_elementary) {
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
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;color:#888;font-size:12px;">
      Peninsula Homes — Los Altos · Mountain View · Palo Alto<br>
      Houses ≤ $6M, refreshed daily from Redfin
    </div>
  </div>
</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Called for every brand-new listing that matches the criteria
 * (house in one of the three cities, priced <= $6M).
 * Sends an email to the configured recipients with all property details.
 */
export async function onNewListing(db, home, env) {
  // Record the event in the queue for audit/reliability.
  await db
    .prepare("INSERT INTO notification_queue (property_id, event, payload) VALUES (?,?,?)")
    .bind(home.propertyId, 'new_listing', JSON.stringify({ address: home.address, city: home.city, price: home.price }))
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

/**
 * Placeholder for future batch delivery of queued notifications.
 * Currently a no-op since emails are sent immediately in onNewListing.
 */
export async function deliverPendingNotifications(_db, _env) {
  return 0;
}
