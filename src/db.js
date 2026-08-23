// D1 persistence layer: upserts, status transitions with history, queries.

const NOW = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Auto-migration: ensure new tables exist (safe to run repeatedly).

let _migrated = null;
export function migrate(db) {
  if (!_migrated) {
    _migrated = (async () => {
      // Favorites: global community list (no per-visitor scoping).
      // If the old table had visitor_id, recreate it.
      const info = await db.prepare("PRAGMA table_info('favorites')").all();
      const hasVisitorId = info.results.some((c) => c.name === 'visitor_id');
      if (hasVisitorId) {
        await db.prepare(`CREATE TABLE IF NOT EXISTS community_favorites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          property_id INTEGER NOT NULL REFERENCES properties(property_id),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          UNIQUE(property_id))`).run();
        await db.prepare(`INSERT OR IGNORE INTO community_favorites (property_id)
          SELECT DISTINCT property_id FROM favorites`).run();
        await db.prepare(`DROP TABLE favorites`).run();
        await db.prepare(`ALTER TABLE community_favorites RENAME TO favorites`).run();
      } else {
        await db.prepare(`CREATE TABLE IF NOT EXISTS favorites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          property_id INTEGER NOT NULL REFERENCES properties(property_id),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          UNIQUE(property_id))`).run();
      }
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_favorites_property ON favorites(property_id)`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS open_houses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL REFERENCES properties(property_id),
        date TEXT NOT NULL, time TEXT, comment TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_open_houses_property ON open_houses(property_id)`).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_open_houses_date ON open_houses(date)`).run();
      // Valuations: fair market value estimates compiled by the manual
      // browser-research workflow (no external AI API).
      await db.prepare(`CREATE TABLE IF NOT EXISTS valuations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(property_id),
        estimated_value INTEGER NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'medium',
        reasoning TEXT,
        price_per_sqft INTEGER,
        comparables_used INTEGER DEFAULT 0,
        model TEXT NOT NULL DEFAULT 'manual-browser',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        UNIQUE(property_id))`).run();
      // Add comps_json (comparable-sales detail captured during research).
      const valInfo = await db.prepare("PRAGMA table_info('valuations')").all();
      if (!valInfo.results.some((c) => c.name === 'comps_json')) {
        await db.prepare(`ALTER TABLE valuations ADD COLUMN comps_json TEXT`).run();
      }
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_valuations_property ON valuations(property_id)`).run();
      // Valuation requests: queue of favorited properties awaiting a
      // manually-compiled valuation (processed via the browser research flow).
      await db.prepare(`CREATE TABLE IF NOT EXISTS valuation_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(property_id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        completed_at TEXT,
        UNIQUE(property_id))`).run();
    })();
  }
  return _migrated;
}

// ---------------------------------------------------------------------------
// Favorites (global community list — shared across all visitors)

export async function addFavorite(db, propertyId) {
  await db
    .prepare('INSERT OR IGNORE INTO favorites (property_id) VALUES (?)')
    .bind(propertyId)
    .run();
}

export async function removeFavorite(db, propertyId) {
  await db
    .prepare('DELETE FROM favorites WHERE property_id = ?')
    .bind(propertyId)
    .run();
}

/** All favorited properties (only active listings), global for all visitors. */
export async function getFavorites(db) {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM properties p
       INNER JOIN favorites f ON f.property_id = p.property_id
       WHERE p.status = 'active'
       ORDER BY p.listed_date DESC`
    )
    .all();
  return results;
}

/** Set of all globally favorited property_ids. */
export async function getFavoritePropertyIds(db) {
  const { results } = await db
    .prepare('SELECT property_id FROM favorites')
    .all();
  return new Set(results.map((r) => r.property_id));
}

/** Count of favorites per property (for display). */
export async function getFavoriteCounts(db, propertyIds) {
  if (!propertyIds.length) return {};
  const placeholders = propertyIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT property_id, COUNT(*) AS n FROM favorites WHERE property_id IN (${placeholders}) GROUP BY property_id`)
    .bind(...propertyIds)
    .all();
  return Object.fromEntries(results.map((r) => [r.property_id, r.n]));
}

export async function upsertActiveHome(db, h, source) {
  const now = NOW();
  const existing = await db
    .prepare('SELECT property_id, status, price FROM properties WHERE property_id = ?')
    .bind(h.propertyId)
    .first();

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO properties (property_id, listing_id, mls_id, address, city, state, zip, url,
          price, beds, baths, sqft, lot_size, year_built, lat, lng, dom, listed_date, mls_status, property_type, last_sold_year,
          status, status_source, first_seen, last_seen_active, last_checked, status_changed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active',?,?,?,?,?)`
      )
      .bind(
        h.propertyId, h.listingId, h.mlsId, h.address, h.city, h.state, h.zip, h.url,
        h.price, h.beds, h.baths, h.sqft, h.lotSize, h.yearBuilt, h.lat, h.lng, h.dom, h.listedDate ?? null, h.mlsStatus, h.uiPropertyType ?? null, h.lastSoldYear ?? null,
        source, now, now, now, now
      )
      .run();
    await db
      .prepare('INSERT INTO status_history (property_id, from_status, to_status, price_at_change, source) VALUES (?,?,?,?,?)')
      .bind(h.propertyId, null, 'active', h.price, source)
      .run();
    return 'new';
  }

  // Existing row: refresh listing data; handle relists and price drops.
  const updates = [];
  const binds = [];
  const push = (col, val) => {
    updates.push(`${col} = ?`);
    binds.push(val);
  };
  push('listing_id', h.listingId);
  push('mls_id', h.mlsId);
  push('address', h.address);
  push('price', h.price);
  push('beds', h.beds);
  push('baths', h.baths);
  push('sqft', h.sqft);
  push('lot_size', h.lotSize);
  push('year_built', h.yearBuilt);
  push('lat', h.lat);
  push('lng', h.lng);
  push('dom', h.dom);
  if (h.listedDate) push('listed_date', h.listedDate);
  push('mls_status', h.mlsStatus);
  if (h.uiPropertyType != null) push('property_type', h.uiPropertyType);
  if (h.lastSoldYear != null) push('last_sold_year', h.lastSoldYear);
  push('last_seen_active', now);
  push('last_checked', now);
  push('updated_at', now);

  if (existing.status !== 'active') {
    // Relisted after pending/sold.
    push('status', 'active');
    push('status_source', source);
    push('status_changed_at', now);
  } else {
    push('status_source', source);
  }

  binds.push(h.propertyId);
  await db.prepare(`UPDATE properties SET ${updates.join(', ')} WHERE property_id = ?`).bind(...binds).run();

  if (existing.status !== 'active') {
    await db
      .prepare('INSERT INTO status_history (property_id, from_status, to_status, price_at_change, source) VALUES (?,?,?,?,?)')
      .bind(h.propertyId, existing.status, 'active', h.price, source)
      .run();
  } else if (existing.price !== null && h.price !== null && existing.price !== h.price) {
    await db
      .prepare("INSERT INTO notification_queue (property_id, event, payload) VALUES (?,?,?)")
      .bind(h.propertyId, 'price_drop', JSON.stringify({ from: existing.price, to: h.price }))
      .run();
  }
  return existing.status === 'active' ? 'seen' : 'relisted';
}

export async function insertSoldHome(db, h, source) {
  const now = NOW();
  const soldDate = h.soldDate ? new Date(h.soldDate).toISOString().slice(0, 10) : null;
  const soldYear = h.soldDate ? new Date(h.soldDate).getUTCFullYear() : null;
  const existing = await db
    .prepare('SELECT property_id, status FROM properties WHERE property_id = ?')
    .bind(h.propertyId)
    .first();
  if (existing) {
    if (existing.status !== 'sold') {
      await db
        .prepare('UPDATE properties SET status = ?, status_source = ?, sold_price = ?, sold_date = ?, status_changed_at = ?, last_checked = ?, updated_at = ? WHERE property_id = ?')
        .bind('sold', source, h.price, soldDate, now, now, now, h.propertyId)
        .run();
      await db
        .prepare('INSERT INTO status_history (property_id, from_status, to_status, price_at_change, source) VALUES (?,?,?,?,?)')
        .bind(h.propertyId, existing.status, 'sold', h.price, source)
        .run();
      return 'sold';
    }
    return 'seen';
  }
  await db
    .prepare(
      `INSERT INTO properties (property_id, listing_id, mls_id, address, city, state, zip, url, price, beds, baths, sqft, lot_size, year_built, lat, lng, listed_date, property_type, last_sold_year, status, status_source, sold_price, sold_date, first_seen, last_checked, status_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sold',?,?,?,?,?,?)`
    )
    .bind(
      h.propertyId, h.listingId, h.mlsId, h.address, h.city, h.state, h.zip, h.url,
      h.price, h.beds, h.baths, h.sqft, h.lotSize, h.yearBuilt, h.lat, h.lng, h.listedDate ?? null, h.uiPropertyType ?? null, soldYear,
      source, h.price, soldDate, now, now, now
    )
    .run();
  await db
    .prepare('INSERT INTO status_history (property_id, from_status, to_status, price_at_change, source) VALUES (?,?,?,?,?)')
    .bind(h.propertyId, null, 'sold', h.price, source)
    .run();
  return 'new';
}

export async function setStatus(db, propertyId, toStatus, source, { soldPrice = null, soldDate = null } = {}) {
  const now = NOW();
  const existing = await db
    .prepare('SELECT status FROM properties WHERE property_id = ?')
    .bind(propertyId)
    .first();
  if (!existing || existing.status === toStatus) return false;
  await db
    .prepare('UPDATE properties SET status = ?, status_source = ?, sold_price = COALESCE(?, sold_price), sold_date = COALESCE(?, sold_date), status_changed_at = ?, last_checked = ?, updated_at = ? WHERE property_id = ?')
    .bind(toStatus, source, soldPrice, soldDate, now, now, now, propertyId)
    .run();
  await db
    .prepare('INSERT INTO status_history (property_id, from_status, to_status, price_at_change, source) VALUES (?,?,?,?,?)')
    .bind(propertyId, existing.status, toStatus, soldPrice, source)
    .run();
  await db
    .prepare("INSERT INTO notification_queue (property_id, event, payload) VALUES (?,?,?)")
    .bind(propertyId, 'status_change', JSON.stringify({ from: existing.status, to: toStatus }))
    .run();
  // Cancel any pending valuation request when the property goes off-market.
  if (toStatus === 'pending' || toStatus === 'sold') {
    await cancelValuationRequest(db, propertyId);
  }
  return true;
}

export async function saveSchools(db, propertyId, schools) {
  const pick = (level) => schools.find((s) => s.level === level);
  const e = pick('elementary');
  const m = pick('middle');
  const h = pick('high');
  await db
    .prepare(
      `UPDATE properties SET
        school_elementary = COALESCE(?, school_elementary),
        school_elementary_rating = COALESCE(?, school_elementary_rating),
        school_middle = COALESCE(?, school_middle),
        school_middle_rating = COALESCE(?, school_middle_rating),
        school_high = COALESCE(?, school_high),
        school_high_rating = COALESCE(?, school_high_rating),
        updated_at = ?
       WHERE property_id = ?`
    )
    .bind(
      e ? e.name : null, e ? e.rating : null,
      m ? m.name : null, m ? m.rating : null,
      h ? h.name : null, h ? h.rating : null,
      NOW(), propertyId
    )
    .run();
}

/** Active properties not seen in the current scan (disappeared from Redfin). */
export async function getDisappeared(db, scanStartIso) {
  const { results } = await db
    .prepare("SELECT property_id, url FROM properties WHERE status = 'active' AND last_seen_active < ?")
    .bind(scanStartIso)
    .all();
  return results;
}

/** Tracked properties missing school zoning (for opportunistic enrichment). */
export async function getMissingSchools(db, limit) {
  const { results } = await db
    .prepare(
      "SELECT property_id, url FROM properties WHERE school_high IS NULL AND status != 'sold' ORDER BY last_checked ASC LIMIT ?"
    )
    .bind(limit)
    .all();
  return results;
}

/** Refresh seen timestamps without touching listing data (transient gis miss). */
export async function markSeenActive(db, propertyId) {
  const now = NOW();
  await db
    .prepare('UPDATE properties SET last_seen_active = ?, last_checked = ?, updated_at = ? WHERE property_id = ?')
    .bind(now, now, now, propertyId)
    .run();
}

/** Remove properties with excluded MLS statuses (e.g. "Ready to Build"). */
export async function deleteExcludedStatuses(db) {
  const { meta } = await db
    .prepare("DELETE FROM notification_queue WHERE property_id IN (SELECT property_id FROM properties WHERE mls_status LIKE '%Ready to Build%')")
    .run();
  const deletedNotif = meta?.changes || 0;
  const { meta: m2 } = await db
    .prepare("DELETE FROM status_history WHERE property_id IN (SELECT property_id FROM properties WHERE mls_status LIKE '%Ready to Build%')")
    .run();
  const { meta: m3 } = await db
    .prepare("DELETE FROM properties WHERE mls_status LIKE '%Ready to Build%'")
    .run();
  return m3?.changes || 0;
}

/** Remove properties that don't meet the minimum sqft requirement. */
export async function deleteBelowMinSqft(db, minSqft) {
  await db.prepare('DELETE FROM notification_queue WHERE property_id IN (SELECT property_id FROM properties WHERE sqft IS NULL OR sqft <= ?)').bind(minSqft).run();
  await db.prepare('DELETE FROM status_history WHERE property_id IN (SELECT property_id FROM properties WHERE sqft IS NULL OR sqft <= ?)').bind(minSqft).run();
  const { meta } = await db
    .prepare('DELETE FROM properties WHERE sqft IS NULL OR sqft <= ?')
    .bind(minSqft)
    .run();
  return meta?.changes || 0;
}

/** Remove new-construction "Plan" listings. */
export async function deletePlanListings(db) {
  await db.prepare("DELETE FROM notification_queue WHERE property_id IN (SELECT property_id FROM properties WHERE address LIKE '%Plan%')").run();
  await db.prepare("DELETE FROM status_history WHERE property_id IN (SELECT property_id FROM properties WHERE address LIKE '%Plan%')").run();
  const { meta } = await db
    .prepare("DELETE FROM properties WHERE address LIKE '%Plan%'")
    .run();
  return meta?.changes || 0;
}

/**
 * Delete every non-single-family property (condos, townhomes, duplexes,
 * multi-family). Rows seen since the property_type column was added carry
 * Redfin uiPropertyType (1 = single-family house); legacy rows where it is
 * NULL fall back to address patterns: unit designators (#123, Unit A),
 * address ranges ("2609-2617 Alma St") and paired lots ("637 & 639 Keats").
 */
export async function deleteNonSingleFamily(db) {
  const cond = `(property_type IS NOT NULL AND property_type != 1
    OR (property_type IS NULL AND (
      address LIKE '%#%' OR address LIKE '% Unit %' OR address LIKE '% Unit#%'
      OR address GLOB '[0-9]*-[0-9]* *'
      OR address GLOB '[0-9]* & [0-9]*'
    )))`;
  await db.prepare(`DELETE FROM notification_queue WHERE property_id IN (SELECT property_id FROM properties WHERE ${cond})`).run();
  await db.prepare(`DELETE FROM status_history WHERE property_id IN (SELECT property_id FROM properties WHERE ${cond})`).run();
  const { meta } = await db.prepare(`DELETE FROM properties WHERE ${cond}`).run();
  return meta?.changes || 0;
}

/** Delete a single property and its related rows. */
export async function deleteProperty(db, propertyId) {
  await db.prepare('DELETE FROM notification_queue WHERE property_id = ?').bind(propertyId).run();
  await db.prepare('DELETE FROM status_history WHERE property_id = ?').bind(propertyId).run();
  await db.prepare('DELETE FROM properties WHERE property_id = ?').bind(propertyId).run();
}

export async function touchChecked(db, propertyId) {
  await db
    .prepare('UPDATE properties SET last_checked = ?, updated_at = ? WHERE property_id = ?')
    .bind(NOW(), NOW(), propertyId)
    .run();
}

// ---------------------------------------------------------------------------
// Open houses

/** Replace all open-house rows for a property with fresh data from the gis feed. */
export async function upsertOpenHouses(db, propertyId, openHouses) {
  await db.prepare('DELETE FROM open_houses WHERE property_id = ?').bind(propertyId).run();
  for (const oh of openHouses) {
    await db
      .prepare('INSERT INTO open_houses (property_id, date, time, comment) VALUES (?,?,?,?)')
      .bind(propertyId, oh.date, oh.time || null, oh.comment || null)
      .run();
  }
}

/** Upcoming open houses (from today onwards) for a set of property IDs. */
export async function getUpcomingOpenHouses(db, propertyIds) {
  if (!propertyIds.length) return [];
  const today = new Date().toISOString().slice(0, 10);
  const placeholders = propertyIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM open_houses WHERE property_id IN (${placeholders}) AND date >= ? ORDER BY date ASC, time ASC`)
    .bind(...propertyIds, today)
    .all();
  return results;
}

// ---------------------------------------------------------------------------
// Valuations (manually compiled via browser research on the listing page)

/** Store or replace a valuation for a property. */
export async function saveValuation(db, propertyId, valuation, comps = []) {
  await db
    .prepare(
      `INSERT INTO valuations (property_id, estimated_value, confidence, reasoning, price_per_sqft, comparables_used, model, comps_json)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(property_id) DO UPDATE SET
         estimated_value=excluded.estimated_value, confidence=excluded.confidence,
         reasoning=excluded.reasoning, price_per_sqft=excluded.price_per_sqft,
         comparables_used=excluded.comparables_used, model=excluded.model,
         comps_json=excluded.comps_json,
         created_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`
    )
    .bind(
      propertyId, valuation.estimated_value, valuation.confidence, valuation.reasoning,
      valuation.price_per_sqft ?? null, valuation.comparables_used ?? comps.length,
      valuation.model || 'manual-browser', JSON.stringify(comps)
    )
    .run();
}

/** Get the valuation for a property (null if none). */
export async function getValuation(db, propertyId) {
  return db.prepare('SELECT * FROM valuations WHERE property_id = ?').bind(propertyId).first();
}

/** Get valuations for multiple properties. */
export async function getValuations(db, propertyIds) {
  if (!propertyIds.length) return [];
  const placeholders = propertyIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM valuations WHERE property_id IN (${placeholders})`)
    .bind(...propertyIds)
    .all();
  return results;
}

// ---------------------------------------------------------------------------
// Valuation requests (queue of favorited properties awaiting research)

/** Queue a manual valuation when a property is newly favorited. */
export async function addValuationRequest(db, propertyId) {
  await db
    .prepare(`INSERT OR IGNORE INTO valuation_requests (property_id) VALUES (?)`)
    .bind(propertyId)
    .run();
}

/** Drop a pending request when the property is unfavorited. */
export async function cancelValuationRequest(db, propertyId) {
  await db
    .prepare(`DELETE FROM valuation_requests WHERE property_id = ? AND status = 'pending'`)
    .bind(propertyId)
    .run();
}

/** Mark a request complete once its valuation has been saved. */
export async function completeValuationRequest(db, propertyId) {
  await db
    .prepare(`UPDATE valuation_requests SET status = 'done', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE property_id = ?`)
    .bind(propertyId)
    .run();
}

/** All pending requests joined with property info (for the research flow). */
export async function getPendingValuationRequests(db) {
  const { results } = await db
    .prepare(
      `SELECT r.property_id, r.created_at AS requested_at, p.address, p.city, p.zip, p.price,
              p.beds, p.baths, p.sqft, p.lot_size, p.year_built, p.url
       FROM valuation_requests r
       INNER JOIN properties p ON p.property_id = r.property_id
       WHERE r.status = 'pending' AND p.status = 'active'
       ORDER BY r.created_at ASC`
    )
    .all();
  return results;
}

/** Find comparable sold properties in the same city (for valuation context). */
export async function getSoldComps(db, property, limit = 5) {
  const { results } = await db
    .prepare(
      `SELECT * FROM properties
       WHERE city = ? AND status = 'sold' AND property_id != ?
         AND sold_price IS NOT NULL AND sold_price > 0
         AND sqft IS NOT NULL AND sqft > 0
       ORDER BY ABS(sqft - ?) + ABS(COALESCE(beds, 0) - COALESCE(?, 0)) * 100
       LIMIT ?`
    )
    .bind(property.city, property.property_id, property.sqft || 2000, property.beds || 3, limit)
    .all();
  return results;
}

/** Find similar active listings in the same city (for valuation context). */
export async function getActiveComps(db, property, limit = 5) {
  const { results } = await db
    .prepare(
      `SELECT * FROM properties
       WHERE city = ? AND status = 'active' AND property_id != ?
         AND price IS NOT NULL AND price > 0
         AND sqft IS NOT NULL AND sqft > 0
       ORDER BY ABS(sqft - ?) + ABS(COALESCE(beds, 0) - COALESCE(?, 0)) * 100
       LIMIT ?`
    )
    .bind(property.city, property.property_id, property.sqft || 2000, property.beds || 3, limit)
    .all();
  return results;
}

export async function writeScanLog(db, entry) {
  await db
    .prepare(
      `INSERT INTO scan_log (trigger, started_at, finished_at, active_seen, new_listings, pending_now, sold_now, detail_checks, fetches, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      entry.trigger, entry.started_at, entry.finished_at, entry.active_seen, entry.new_listings,
      entry.pending_now, entry.sold_now, entry.detail_checks, entry.fetches,
      Array.isArray(entry.notes) ? entry.notes.join('; ') : entry.notes || null
    )
    .run();
}
