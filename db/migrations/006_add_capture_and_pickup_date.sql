-- Manual-capture checkout (authorize at checkout, capture only at confirmed pickup) needs
-- to record what was actually captured, since a customer can decline some items at the
-- counter and end up charged less than the original subtotal_cents.
ALTER TABLE orders ADD COLUMN captured_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN captured_amount_cents INTEGER;

-- Customer-selected pickup day, collected at checkout.
ALTER TABLE orders ADD COLUMN pickup_date DATE;
