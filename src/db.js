// D1 persistence layer: upserts, status transitions with history, queries.

const NOW = () => new Date().toISOString();

export async function upsertActiveHome(db, h, source, onNew) {
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
    if (onNew) await onNew(h);
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
      `INSERT INTO properties (property_id, listing_id, mls_id, address, city, state, zip, url,
        price, beds, baths, sqft, lot_size, year_built, lat, lng, listed_date, property_type, last_sold_year,
        status, status_source, sold_price, sold_date, first_seen, last_checked, status_changed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,???, 'sold', ?,?,?,?, ?, ?)`
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
