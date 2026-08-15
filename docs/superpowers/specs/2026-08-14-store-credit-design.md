# Store credit (consignment payouts + redemption) — design

## Context

This is sub-project 1 of the store-credit brainstorm: the credit ledger foundation, plus the first real consumer of it — automatic consignment payouts to donors when their donated item sells. A second sub-project (refunds-as-credit for declined-at-pickup and post-pickup returns) reuses this same ledger and is deliberately out of scope here — it gets its own spec later.

The `donors` table (phone-number keyed) and `items.donor_id` already exist from earlier work. This spec adds the ledger, the automatic payout trigger, and checkout redemption on top of that.

## Goals

- When a donated item is picked up by its buyer, automatically credit the donor 50% of the sale price as store credit.
- Let a customer apply their store credit balance toward a purchase at checkout, by phone number.
- Full audit trail — every credit/debit is an inspectable row, not just a mutable balance.

## Non-goals

- Refunds-as-credit (declined at pickup, post-pickup returns) — separate follow-on spec.
- Manual staff-issued credit adjustments unrelated to a sale.
- Donor-facing balance lookup outside the checkout flow.
- Solving the race condition of the same donor's credit being checked out twice concurrently (see "Accepted risks" below) — low-probability given this is a single small store, not worth the complexity for v1.

## Schema

New migration (`004_add_store_credit.sql`):

```sql
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

ALTER TABLE orders ADD COLUMN credit_donor_id INTEGER REFERENCES donors(id);
ALTER TABLE orders ADD COLUMN credit_applied_cents INTEGER NOT NULL DEFAULT 0;
```

A donor's balance is never stored directly — always computed as `SELECT COALESCE(SUM(amount_cents), 0) FROM store_credit_ledger WHERE donor_id = $1`. This keeps the ledger the single source of truth; nothing can drift out of sync with a cached balance column.

The two new `orders` columns record what credit (if any) was applied to that order, so the payment-confirmation step (webhook, or the zero-remainder direct-paid path below) knows what ledger entry to write — without needing to re-derive it from anything else.

## `lib/store-credit.js` (new)

- `CONSIGNMENT_PAYOUT_RATE = 0.5` — the donor's cut. A plain constant, same spirit as `lib/bins.js`'s `CONSOLIDATION_THRESHOLD_RATIO` — easy to tune later, nothing else depends on its exact value.
- `getBalanceCents(client, donorId)` — runs the `SUM` query above.
- `issuePayout(client, item)` — called from the pickup flow for each item on an order. No-op if `item.donor_id` is null (pre-donor-tracking inventory, or a donation where no phone was captured). Otherwise inserts a `consignment_payout` row: `amount_cents = Math.round(item.price_current_cents * CONSIGNMENT_PAYOUT_RATE)`.
- `redeemCredit(client, donorId, amountCents, orderId)` — inserts a negative `redeemed_at_checkout` row. Caller is responsible for having already clamped `amountCents` to the donor's actual balance; this function just records the debit.

## Automatic payout trigger

Hooks into the existing `pulled → picked_up` transition (the "Mark Picked Up" action in fulfillment). For every item on that order, call `issuePayout` inside the same transaction as the pickup transition — if the pickup transition rolls back for any reason, the payout never happened either. This is the *only* place payouts are issued; nothing else in the app writes a `consignment_payout` row.

## Checkout redemption flow

**Checking a balance (cart page):** the existing `GET /cart` route gains an optional `donor_phone` query param. When present, it looks up the donor by phone and computes their balance, passing both into the cart template. The cart page gets a small "Have store credit?" phone field with its own submit button (a plain `GET` form back to `/cart?donor_phone=...`, not a POST — this is a pure lookup, no mutation) that re-renders the same page now showing the balance and an "apply up to $X" amount field alongside the existing email + checkout form. No credit is touched yet at this point — this is read-only.

**At checkout (`POST /checkout`):** the form now optionally carries `donor_phone` and a requested `credit_cents`. The route re-validates from scratch — looks up the donor fresh, recomputes their real balance, and clamps the requested amount to `min(requestedCents, balanceCents, subtotalCents)`. That clamped amount is what actually gets used; nothing from the client is trusted past this point (matches how `price_current_cents` is already handled server-side for the rest of checkout).

The clamped amount is stored on the new `orders.credit_donor_id` / `orders.credit_applied_cents` columns when the order row is created (the existing code already creates that row before talking to Stripe). **The ledger redemption entry itself is not written yet** — it's deferred to actual payment confirmation, for the same reason the rest of this app treats the Stripe webhook as the source of truth: if we debited the donor's credit the moment checkout *started*, an abandoned checkout (customer never completes payment) would wrongly consume their credit. So:

- **Partial credit (remainder > $0):** proceeds through Stripe as today, but for the *reduced* amount. `lib/stripe.js`'s `createCheckoutSession` gains an optional `creditCentsToApply` param — when set, it creates a one-time Stripe coupon (`stripe.coupons.create({ amount_off, currency: 'usd', duration: 'once' })`) and passes it via the session's `discounts` array, rather than trying to manipulate individual line-item prices. When the webhook later confirms payment and marks the order paid, it also calls `redeemCredit` (using `orders.credit_donor_id`/`credit_applied_cents`) in the same transaction that transitions the items to `sold_pending_pull`.
- **Full credit (remainder = $0):** there's nothing for Stripe to charge, so no Stripe session is created at all. Instead, the checkout route directly does what the webhook normally does — in one transaction: create the order as `paid` (skipping `pending`), transition every cart item `reserved → sold_pending_pull`, write `price_history` rows, and call `redeemCredit`. Then redirects straight to `/order/success`, same destination as a real Stripe return. This is the only new path that duplicates webhook-handler logic — worth flagging in the plan so it's kept in sync with `routes/webhooks.js` if that ever changes.

## Error handling

- Phone number matches no donor, or matches a donor with $0 balance: cart page just shows no credit available (not an error, a normal empty state).
- Requested credit exceeds actual balance or subtotal: silently clamped, and the checkout confirmation shows the amount that was *actually* applied, not what was requested.

## Accepted risks (v1)

- **Concurrent redemption race:** if the same donor's phone number is used to start two separate checkouts at the same time, both could see the same starting balance and both complete, over-spending the ledger balance (going negative). Given this is a single small store and the odds of the same donor's phone being used twice in that narrow a window are very low, this isn't being solved now — a future fix would need a stronger lock spanning the entire Stripe redirect round-trip, which is a bigger undertaking than this feature warrants today.

## Testing

Following this codebase's existing convention (tests only for atomicity-sensitive paths — cart reservation, webhook, cron jobs): the payout-on-pickup transaction and the zero-remainder direct-paid path both belong in that category, since they move real money/credit atomically. Both should get an idempotency/concurrency test similar to `test/cart-concurrency.test.js`, added during implementation.
