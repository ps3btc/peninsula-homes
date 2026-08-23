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

-- Community favorites: global list shared across all visitors.
-- Any visitor can star/unstar a property; all visitors see the same list.
CREATE TABLE IF NOT EXISTS favorites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(property_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_property ON favorites(property_id);

-- Open house dates extracted from the Redfin gis feed during scans.
CREATE TABLE IF NOT EXISTS open_houses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(property_id),
  date        TEXT NOT NULL,
  time        TEXT,
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_open_houses_property ON open_houses(property_id);
CREATE INDEX IF NOT EXISTS idx_open_houses_date ON open_houses(date);

-- Fair market valuations compiled manually via browser research on the
-- listing page (Redfin/Zillow), triggered by favoriting a property.
CREATE TABLE IF NOT EXISTS valuations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id      INTEGER NOT NULL REFERENCES properties(property_id),
  estimated_value  INTEGER NOT NULL,
  confidence       TEXT NOT NULL DEFAULT 'medium',
  reasoning        TEXT,
  price_per_sqft   INTEGER,
  comparables_used INTEGER DEFAULT 0,
  model            TEXT NOT NULL DEFAULT 'manual-browser',
  comps_json       TEXT,                            -- comparable sales detail captured during research
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(property_id)
);
CREATE INDEX IF NOT EXISTS idx_valuations_property ON valuations(property_id);

-- Queue of favorited properties awaiting a manually-compiled valuation.
-- A row is inserted when a property is favorited and marked done once the
-- browser-research valuation is posted back via POST /api/valuation.
CREATE TABLE IF NOT EXISTS valuation_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id  INTEGER NOT NULL REFERENCES properties(property_id),
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | done
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  completed_at TEXT,
  UNIQUE(property_id)
);
