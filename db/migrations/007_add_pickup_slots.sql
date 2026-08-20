-- Pickup moves from a date-only picker to a date + 1-hour time slot. Slots default to
-- 4pm-8pm every day (see lib/pickup-schedule.js); this table stores only exceptions
-- (closing a default slot, or an admin-added extra one) rather than every future slot.
CREATE TABLE pickup_slot_overrides (
  id          SERIAL PRIMARY KEY,
  slot_date   DATE NOT NULL,
  start_time  TIME NOT NULL,
  is_open     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slot_date, start_time)
);

ALTER TABLE orders ADD COLUMN pickup_time TIME;
