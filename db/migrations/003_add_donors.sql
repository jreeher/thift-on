-- Donors are tracked by phone number so a repeat donor reuses the same donor id
-- (registration is an upsert keyed on phone_number, see routes/admin.js POST /donations).
CREATE TABLE donors (
  id            SERIAL PRIMARY KEY,
  phone_number  TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE items ADD COLUMN donor_id INTEGER REFERENCES donors(id);
CREATE INDEX idx_items_donor ON items(donor_id);
