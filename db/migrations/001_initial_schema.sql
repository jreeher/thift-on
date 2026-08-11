CREATE TABLE bins (
  id              SERIAL PRIMARY KEY,
  bin_number      INTEGER UNIQUE NOT NULL,
  capacity        INTEGER NOT NULL DEFAULT 20,
  status          TEXT NOT NULL DEFAULT 'active',
                  -- active | needs_consolidation | retired
  last_consolidated_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id                     SERIAL PRIMARY KEY,
  order_number           TEXT UNIQUE NOT NULL,   -- human-friendly, e.g. "TS-1042"
  customer_email         TEXT NOT NULL,
  customer_name          TEXT,
  customer_phone         TEXT,
  subtotal_cents         INTEGER NOT NULL,
  stripe_session_id      TEXT UNIQUE,
  stripe_payment_intent  TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
                         -- pending | paid | ready_for_pickup | completed | cancelled
  paid_at                TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE items (
  id                 SERIAL PRIMARY KEY,
  bin_number         INTEGER REFERENCES bins(bin_number),
  -- media
  photo_key          TEXT,            -- R2 object key
  photo_url          TEXT,            -- public URL
  photo_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  photo_deleted_at   TIMESTAMPTZ,
  -- AI-generated, human-editable
  title              TEXT,
  category           TEXT,
  description        TEXT,
  condition_notes    TEXT,
  ai_raw_response    JSONB,           -- keep the full model output for later tuning
  ai_confidence      TEXT,            -- high | medium | low
  human_edited       BOOLEAN NOT NULL DEFAULT FALSE,
  -- pricing
  price_original_cents INTEGER,       -- ALL money is stored in integer cents
  price_current_cents  INTEGER,
  listed_at            TIMESTAMPTZ,   -- when it went live; markdown clock starts here
  -- lifecycle
  status             TEXT NOT NULL DEFAULT 'draft',
                     -- draft | active | reserved | sold_pending_pull
                     -- | pulled | picked_up | expired | removed
  reserved_by_cart   TEXT,            -- cart session token holding it
  reserved_until     TIMESTAMPTZ,
  order_id           INTEGER REFERENCES orders(id),
  pulled_at          TIMESTAMPTZ,
  picked_up_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_bin ON items(bin_number);
CREATE INDEX idx_items_reserved_until ON items(reserved_until)
  WHERE status = 'reserved';

CREATE TABLE price_history (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  price_cents   INTEGER NOT NULL,
  reason        TEXT NOT NULL,    -- initial | weekly_markdown | manual_edit
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE processed_webhook_events (
  event_id     TEXT PRIMARY KEY,      -- Stripe event id, for idempotency
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
