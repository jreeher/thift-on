-- Every credit/debit is its own row — a donor's balance is always SUM(amount_cents),
-- never a cached column, so it can't drift out of sync (see lib/store-credit.js).
CREATE TABLE store_credit_ledger (
  id            SERIAL PRIMARY KEY,
  donor_id      INTEGER NOT NULL REFERENCES donors(id),
  amount_cents  INTEGER NOT NULL,        -- positive = credit issued, negative = redeemed
  reason        TEXT NOT NULL,           -- 'consignment_payout' | 'redeemed_at_checkout'
  item_id       INTEGER REFERENCES items(id),   -- set for consignment_payout rows
  order_id      INTEGER REFERENCES orders(id),  -- set for redeemed_at_checkout rows
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_store_credit_ledger_donor_id ON store_credit_ledger(donor_id);

-- Records what credit (if any) was applied to an order, so payment confirmation knows
-- what ledger entry to write without re-deriving it from anything else.
ALTER TABLE orders ADD COLUMN credit_donor_id INTEGER REFERENCES donors(id);
ALTER TABLE orders ADD COLUMN credit_applied_cents INTEGER NOT NULL DEFAULT 0;
