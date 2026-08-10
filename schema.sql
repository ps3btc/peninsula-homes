-- Peninsula Homes D1 schema
-- Properties tracked across active -> pending -> sold lifecycle with full history.

CREATE TABLE IF NOT EXISTS properties (
  property_id        INTEGER PRIMARY KEY,          -- Redfin propertyId
  listing_id         INTEGER,
  mls_id             TEXT,
  address            TEXT NOT NULL,
  city               TEXT NOT NULL,
  state              TEXT DEFAULT 'CA',
  zip                TEXT,
  url                TEXT NOT NULL,                -- full Redfin listing URL
  price              INTEGER,                      -- current list price (cents-free dollars)
  beds               REAL,
  baths              REAL,
  sqft               INTEGER,
  lot_size           INTEGER,                      -- sqft
  year_built         INTEGER,
  lat                REAL,
  lng                REAL,
  dom                INTEGER,                      -- days on market
  listed_date        TEXT,                         -- approx. listing date (scan day minus dom)
  mls_status         TEXT,                         -- Redfin mlsStatus (e.g. "Active", "Ready to Build")
  property_type      INTEGER,                      -- Redfin uiPropertyType (1 = single-family house; only 1 is kept)
  last_sold_year     INTEGER,                      -- year of the most recent prior public sale (Redfin soldDate)
  status             TEXT NOT NULL DEFAULT 'active',  -- active | pending | sold
  status_source      TEXT,                         -- redfin-active | redfin-sold | redfin-detail | inferred
  sold_price         INTEGER,
  sold_date          TEXT,
  school_elementary         TEXT,
  school_elementary_rating  INTEGER,
  school_middle             TEXT,
  school_middle_rating      INTEGER,
  school_high               TEXT,
  school_high_rating        INTEGER,
  first_seen         TEXT NOT NULL,
  last_seen_active   TEXT,
  last_checked       TEXT,
  status_changed_at  TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_city   ON properties(city);
CREATE INDEX IF NOT EXISTS idx_properties_price  ON properties(price);

-- Every status transition (active -> pending, pending -> sold, relists, etc.)
CREATE TABLE IF NOT EXISTS status_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   INTEGER NOT NULL REFERENCES properties(property_id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  price_at_change INTEGER,
  source        TEXT,
  changed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_history_property ON status_history(property_id);

-- One row per scraper run for observability.
CREATE TABLE IF NOT EXISTS scan_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger      TEXT NOT NULL,                     -- cron | manual
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  active_seen  INTEGER DEFAULT 0,
  new_listings INTEGER DEFAULT 0,
  pending_now  INTEGER DEFAULT 0,
  sold_now     INTEGER DEFAULT 0,
  detail_checks INTEGER DEFAULT 0,
  fetches      INTEGER DEFAULT 0,
  notes        TEXT
);

-- Reserved for the future notification integration (email/push when new
-- listings match criteria). The scraper enqueues events; a future sender
-- worker will consume them.
CREATE TABLE IF NOT EXISTS notification_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  event       TEXT NOT NULL,                      -- new_listing | status_change | price_drop
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notify_unsent ON notification_queue(sent_at) WHERE sent_at IS NULL;
