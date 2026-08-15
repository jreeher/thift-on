# Store Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically credit a donor 50% of an item's sale price when it's picked up, and let a customer apply their accumulated store credit (looked up by phone number) toward a purchase at checkout.

**Architecture:** A new `store_credit_ledger` table is the single source of truth for every donor's balance (computed via `SUM`, never cached). `lib/store-credit.js` holds the ledger operations. Payout hooks into the existing `markOrderPickedUp` transaction in `lib/fulfillment.js`. Redemption is looked up read-only on the cart page, re-validated from scratch at checkout, and only actually debited from the ledger at payment-confirmation time (the webhook, or — when credit covers the whole order — a new same-transaction path that completes the order without ever involving Stripe).

**Tech Stack:** Express, PostgreSQL (`pg`), Stripe (one-time dynamic coupons via `stripe.coupons.create`), EJS.

**Spec:** `docs/superpowers/specs/2026-08-14-store-credit-design.md`. One correction made during planning: the spec's redemption section mentioned writing `price_history` rows in the full-credit completion path — the real webhook handler (`routes/webhooks.js`) doesn't do this on sale (only `POST /admin/review/:id/approve` writes an initial `price_history` row, at publish time), so the implementation below matches that existing behavior instead, for parity with the webhook path it's meant to mirror.

No automated tests exist in this codebase except for atomicity-sensitive paths (see `test/cart-concurrency.test.js`, `test/markdown-idempotency.test.js`, `test/purge-photos-idempotency.test.js`). The payout-on-pickup transaction and the full-credit checkout path both move real money/credit atomically, so both get a test in that same style — a real Postgres instance, not mocks. Everything else in this plan (schema, simple helper queries, view/route wiring) follows the existing convention of no test.

---

### Task 1: Schema and the store-credit ledger library

**Files:**
- Create: `db/migrations/004_add_store_credit.sql`
- Create: `lib/store-credit.js`

- [ ] **Step 1: Write the migration**

```sql
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
```

Save this as `db/migrations/004_add_store_credit.sql` (matches the existing numbered-migration convention — `db/migrate.js` runs files in this directory in numeric order and tracks which have been applied).

- [ ] **Step 2: Write `lib/store-credit.js`**

```js
const { transitionItem } = require('../db/transitions');

// The donor's cut of the sale price. A plain constant, same spirit as
// lib/bins.js's CONSOLIDATION_THRESHOLD_RATIO — easy to tune later, nothing else
// depends on its exact value.
const CONSIGNMENT_PAYOUT_RATE = 0.5;

async function getBalanceCents(client, donorId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS balance_cents FROM store_credit_ledger WHERE donor_id = $1`,
    [donorId]
  );
  return rows[0].balance_cents;
}

// Called from the pickup flow for each item on an order (lib/fulfillment.js's
// markOrderPickedUp). A no-op for items with no donor_id — pre-donor-tracking
// inventory, or a donation where no phone was ever captured, has no one to pay.
async function issuePayout(client, item) {
  if (!item.donor_id) return;

  const amountCents = Math.round(item.price_current_cents * CONSIGNMENT_PAYOUT_RATE);

  await client.query(
    `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason, item_id) VALUES ($1, $2, 'consignment_payout', $3)`,
    [item.donor_id, amountCents, item.id]
  );
}

// Records a debit. The caller must have already clamped amountCents to the donor's
// actual balance — this function just writes the row, it doesn't re-check anything.
async function redeemCredit(client, donorId, amountCents, orderId) {
  await client.query(
    `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason, order_id) VALUES ($1, $2, 'redeemed_at_checkout', $3)`,
    [donorId, -amountCents, orderId]
  );
}

// The "credit covers the whole order" checkout path — there's nothing for Stripe to
// charge, so this completes the order directly in one transaction instead of ever
// creating a checkout session: mark the order paid, transition every item to
// sold_pending_pull (mirroring what the Stripe webhook does for a normal payment), and
// debit the ledger. Pulled into its own function (rather than living inline in the
// route) so it can be tested directly against a real transaction without going through
// HTTP.
async function completeOrderFullyWithCredit(
  client,
  { orderId, orderNumber, customerEmail, subtotalCents, items, donorId, creditCents }
) {
  await client.query(
    `INSERT INTO orders (id, order_number, customer_email, subtotal_cents, status, paid_at, credit_donor_id, credit_applied_cents)
     VALUES ($1, $2, $3, $4, 'paid', NOW(), $5, $6)`,
    [orderId, orderNumber, customerEmail, subtotalCents, donorId, creditCents]
  );

  for (const item of items) {
    // An item must never be sold twice — same conditional transition the webhook uses
    // for a real payment (Section 2, 6).
    await transitionItem(client, item.id, 'reserved', 'sold_pending_pull', { order_id: orderId });
  }

  await redeemCredit(client, donorId, creditCents, orderId);
}

module.exports = {
  CONSIGNMENT_PAYOUT_RATE,
  getBalanceCents,
  issuePayout,
  redeemCredit,
  completeOrderFullyWithCredit
};
```

- [ ] **Step 3: Verify**

```bash
node -c lib/store-credit.js
```

Expected: no output (syntax OK).

If a local `DATABASE_URL` is available:

```bash
npm run migrate
```

Expected: `apply 004_add_store_credit.sql` in the output. Then confirm the new table and columns exist:

```bash
node -e "require('./db/pool').query(\"SELECT column_name FROM information_schema.columns WHERE table_name IN ('store_credit_ledger','orders') ORDER BY table_name, ordinal_position\").then(r => { console.log(r.rows.map(x => x.column_name).join(', ')); process.exit(0); })"
```

Expected: includes `credit_donor_id`, `credit_applied_cents` (from `orders`) and `id, donor_id, amount_cents, reason, item_id, order_id, created_at` (from `store_credit_ledger`).

If no local `DATABASE_URL` is available, skip the live checks — applying this migration to the real database is a deployment step (via `railway ssh -- npm run migrate`, same as every prior migration in this project), not part of writing the code.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/004_add_store_credit.sql lib/store-credit.js
git commit -m "Add store credit ledger schema and library"
```

---

### Task 2: Automatic payout on pickup

**Files:**
- Modify: `lib/fulfillment.js:99-105`
- Test: `test/consignment-payout.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/consignment-payout.test.js
// Proves the store-credit payout on pickup is correct and idempotent: marking an order
// picked up issues exactly one 50% payout per donor-owned item, and a repeat call (e.g.
// a double-tap of "Mark Picked Up") does not double-pay. Requires a live DATABASE_URL —
// this exercises markOrderPickedUp's real conditional-UPDATE guard against a real
// Postgres instance, the same way test/cart-concurrency.test.js does.
//
// Run with: node test/consignment-payout.test.js
require('dotenv').config();
const assert = require('assert');
const pool = require('../db/pool');
const { markOrderPickedUp } = require('../lib/fulfillment');
const { getBalanceCents } = require('../lib/store-credit');

const TEST_BIN_NUMBER = 999998;
const TEST_PHONE = '5555550199';

async function setup() {
  await pool.query(`INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING`, [
    TEST_BIN_NUMBER
  ]);

  const { rows: donorRows } = await pool.query(
    `INSERT INTO donors (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING id`,
    [TEST_PHONE]
  );
  const donorId = donorRows[0].id;

  const { rows: orderRows } = await pool.query(
    `INSERT INTO orders (order_number, customer_email, subtotal_cents, status)
     VALUES ('TEST-PAYOUT-1', 'test@example.com', 2000, 'ready_for_pickup')
     RETURNING id`
  );
  const orderId = orderRows[0].id;

  const { rows: itemRows } = await pool.query(
    `INSERT INTO items (bin_number, donor_id, order_id, title, category, status, price_original_cents, price_current_cents, listed_at)
     VALUES ($1, $2, $3, 'Payout test item', 'other', 'pulled', 2000, 2000, NOW())
     RETURNING id`,
    [TEST_BIN_NUMBER, donorId, orderId]
  );

  return { donorId, orderId, itemId: itemRows[0].id };
}

async function cleanup({ donorId, orderId, itemId }) {
  await pool.query('DELETE FROM store_credit_ledger WHERE donor_id = $1', [donorId]);
  await pool.query('DELETE FROM price_history WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
  await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
  await pool.query('DELETE FROM donors WHERE id = $1', [donorId]);
  await pool.query('DELETE FROM bins WHERE bin_number = $1', [TEST_BIN_NUMBER]);
}

async function run() {
  const ctx = await setup();

  await markOrderPickedUp(ctx.orderId);
  const balanceAfterFirst = await getBalanceCents(pool, ctx.donorId);
  assert.strictEqual(
    balanceAfterFirst,
    1000,
    `Expected $10.00 payout (50% of $20.00), got ${balanceAfterFirst} cents`
  );

  // A second call must be a no-op: the order is no longer 'ready_for_pickup', so
  // markOrderPickedUp's own atomic guard throws before any payout logic runs again.
  await assert.rejects(() => markOrderPickedUp(ctx.orderId), /was not in status 'ready_for_pickup'/);
  const balanceAfterSecond = await getBalanceCents(pool, ctx.donorId);
  assert.strictEqual(balanceAfterSecond, balanceAfterFirst, 'Repeat pickup must not double-pay');

  await cleanup(ctx);
  console.log('PASS: pickup issues exactly one 50% payout, repeat pickup does not double-pay.');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('FAIL:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/consignment-payout.test.js`
Expected: FAIL — balance is `0`, not `1000`, since `issuePayout` isn't wired in yet.

If no local `DATABASE_URL` is available, skip running it here and note that in your report — the code in Step 3 is still correct and reviewable without execution, matching how earlier work in this codebase was verified when no local DB was reachable.

- [ ] **Step 3: Wire `issuePayout` into `markOrderPickedUp`**

In `lib/fulfillment.js`, add the import at the top:

```js
const pool = require('../db/pool');
const { transitionItem, TransitionConflictError } = require('../db/transitions');
const { issuePayout } = require('./store-credit');
```

Then change this block (currently at `lib/fulfillment.js:99-105`):

```js
    const { rows: items } = await client.query(`SELECT id FROM items WHERE order_id = $1 AND status = 'pulled'`, [
      orderId
    ]);

    for (const { id } of items) {
      await transitionItem(client, id, 'pulled', 'picked_up', {});
    }
```

to:

```js
    const { rows: items } = await client.query(
      `SELECT id, donor_id, price_current_cents FROM items WHERE order_id = $1 AND status = 'pulled'`,
      [orderId]
    );

    for (const item of items) {
      await transitionItem(client, item.id, 'pulled', 'picked_up', {});
      // Consignment payout happens in the same transaction as the pickup transition —
      // if the transition rolls back, the payout never happened either.
      await issuePayout(client, item);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/consignment-payout.test.js`
Expected: `PASS: pickup issues exactly one 50% payout, repeat pickup does not double-pay.`

- [ ] **Step 5: Commit**

```bash
git add lib/fulfillment.js test/consignment-payout.test.js
git commit -m "Issue automatic consignment payout when an order is picked up"
```

---

### Task 3: Store credit lookup on the cart page

**Files:**
- Modify: `routes/storefront.js:82-88`
- Modify: `views/storefront/cart.ejs`

- [ ] **Step 1: Update `GET /cart` to accept an optional phone lookup**

In `routes/storefront.js`, add this import at the top alongside the existing ones:

```js
const { getBalanceCents } = require('../lib/store-credit');
```

Then replace the existing `GET /cart` route (currently `routes/storefront.js:82-88`):

```js
router.get(
  '/cart',
  asyncHandler(async (req, res) => {
    const { items, subtotalCents } = await loadCartItems(req.cartToken);
    res.render('storefront/cart', { items, subtotalCents, error: null });
  })
);
```

with:

```js
router.get(
  '/cart',
  asyncHandler(async (req, res) => {
    const { items, subtotalCents } = await loadCartItems(req.cartToken);

    // A pure read — checking a balance never touches the ledger. The actual debit only
    // ever happens at payment confirmation (see the /checkout route and the webhook).
    const donorPhone = (req.query.donor_phone || '').replace(/\D/g, '');
    let donorBalanceCents = null;
    if (donorPhone) {
      const { rows: donorRows } = await pool.query('SELECT id FROM donors WHERE phone_number = $1', [donorPhone]);
      if (donorRows.length > 0) {
        donorBalanceCents = await getBalanceCents(pool, donorRows[0].id);
      }
    }

    res.render('storefront/cart', {
      items,
      subtotalCents,
      error: null,
      donorPhone: donorPhone || null,
      donorBalanceCents
    });
  })
);
```

- [ ] **Step 2: Add the credit lookup and apply-amount UI to `views/storefront/cart.ejs`**

The current file (unchanged parts omitted — this only touches the section between the item list and the checkout form):

```html
      <div class="cart-summary">
        <span class="cart-subtotal">Subtotal: $<%= (subtotalCents / 100).toFixed(2) %></span>
      </div>

      <% if (error) { %>
        <p class="error"><%= error %></p>
      <% } %>

      <form method="POST" action="/checkout" class="checkout-form">
        <label>
          Email (for your receipt and pickup confirmation)
          <input type="email" name="email" required placeholder="you@example.com">
        </label>
        <button type="submit" class="checkout-btn">Checkout</button>
      </form>
```

Replace it with:

```html
      <div class="cart-summary">
        <span class="cart-subtotal">Subtotal: $<%= (subtotalCents / 100).toFixed(2) %></span>
      </div>

      <form method="GET" action="/cart" class="bin-create-form">
        <label>
          Have store credit? Enter phone number
          <input type="tel" name="donor_phone" value="<%= donorPhone || '' %>" placeholder="(555) 555-5555">
        </label>
        <button type="submit" class="secondary-btn">Check</button>
      </form>

      <% if (donorPhone && donorBalanceCents === null) { %>
        <p class="admin-hint">No store credit found for that number.</p>
      <% } else if (donorBalanceCents > 0) { %>
        <p class="success-banner">You have $<%= (donorBalanceCents / 100).toFixed(2) %> in store credit available.</p>
      <% } %>

      <% if (error) { %>
        <p class="error"><%= error %></p>
      <% } %>

      <form method="POST" action="/checkout" class="checkout-form">
        <% if (donorBalanceCents > 0) { %>
          <input type="hidden" name="donor_phone" value="<%= donorPhone %>">
          <label>
            Apply credit ($)
            <input
              type="number"
              name="credit_dollars"
              min="0"
              step="0.01"
              max="<%= (Math.min(donorBalanceCents, subtotalCents) / 100).toFixed(2) %>"
              value="<%= (Math.min(donorBalanceCents, subtotalCents) / 100).toFixed(2) %>"
            >
          </label>
        <% } %>
        <label>
          Email (for your receipt and pickup confirmation)
          <input type="email" name="email" required placeholder="you@example.com">
        </label>
        <button type="submit" class="checkout-btn">Checkout</button>
      </form>
```

This reuses existing CSS classes (`bin-create-form`, `secondary-btn`, `admin-hint`, `success-banner`, `checkout-form`) — no new styles needed.

Also update the two other places `storefront/cart` gets rendered in `routes/storefront.js` (the email-validation-error branch of `POST /checkout`, and nowhere else) to pass `donorPhone: null, donorBalanceCents: null` so the template doesn't break when those locals are missing — this is handled in Task 4, since that's the same route being modified there.

- [ ] **Step 3: Verify**

```bash
node -e "
const ejs = require('ejs');
const fs = require('fs');
const render = (data) => ejs.render(fs.readFileSync('views/storefront/cart.ejs', 'utf8'), data, { filename: 'views/storefront/cart.ejs' });

// No phone checked yet
render({ items: [], subtotalCents: 0, error: null, donorPhone: null, donorBalanceCents: null, cartCount: 0 });

// Phone checked, no match
const noMatch = render({ items: [{ id: 1, photo_url: null, title: 'X', price_current_cents: 500, reserved_until: new Date() }], subtotalCents: 500, error: null, donorPhone: '5555550199', donorBalanceCents: null, cartCount: 1 });
if (!noMatch.includes('No store credit found')) throw new Error('missing no-match message');

// Phone checked, has balance
const hasBalance = render({ items: [{ id: 1, photo_url: null, title: 'X', price_current_cents: 500, reserved_until: new Date() }], subtotalCents: 500, error: null, donorPhone: '5555550199', donorBalanceCents: 1000, cartCount: 1 });
if (!hasBalance.includes('credit_dollars')) throw new Error('missing credit amount field');
if (!hasBalance.includes('max=\"5.00\"')) throw new Error('credit should be capped at subtotal, got: ' + hasBalance.match(/max=\"[^\"]*\"/));

console.log('cart.ejs renders correctly in all three states');
"
```

Expected: `cart.ejs renders correctly in all three states`

- [ ] **Step 4: Commit**

```bash
git add routes/storefront.js views/storefront/cart.ejs
git commit -m "Add store credit balance lookup to the cart page"
```

---

### Task 4: Redeem credit at checkout (Stripe coupon + full-credit path)

**Files:**
- Modify: `lib/stripe.js:14-39`
- Modify: `routes/storefront.js:156-197` (the `POST /checkout` route)
- Modify: `routes/webhooks.js:58-76`
- Test: `test/store-credit-full-redemption.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/store-credit-full-redemption.test.js
// Proves the "credit covers the whole order" path (lib/store-credit.js's
// completeOrderFullyWithCredit) is atomic: the order is marked paid, the item is sold,
// and the ledger is debited all together. Requires a live DATABASE_URL.
//
// Run with: node test/store-credit-full-redemption.test.js
require('dotenv').config();
const assert = require('assert');
const pool = require('../db/pool');
const { completeOrderFullyWithCredit, getBalanceCents } = require('../lib/store-credit');

const TEST_BIN_NUMBER = 999997;
const TEST_PHONE = '5555550299';

async function setup() {
  await pool.query(`INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING`, [
    TEST_BIN_NUMBER
  ]);

  const { rows: donorRows } = await pool.query(
    `INSERT INTO donors (phone_number) VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING id`,
    [TEST_PHONE]
  );
  const donorId = donorRows[0].id;

  // Give the donor $10.00 credit directly — this test is about redemption, not payout
  // math (that's test/consignment-payout.test.js).
  await pool.query(
    `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason) VALUES ($1, 1000, 'consignment_payout')`,
    [donorId]
  );

  const { rows: itemRows } = await pool.query(
    `INSERT INTO items (bin_number, title, category, status, price_original_cents, price_current_cents, listed_at)
     VALUES ($1, 'Redemption test item', 'other', 'reserved', 1000, 1000, NOW())
     RETURNING id`,
    [TEST_BIN_NUMBER]
  );

  return { donorId, itemId: itemRows[0].id };
}

async function cleanup({ donorId, itemId, orderId }) {
  await pool.query('DELETE FROM store_credit_ledger WHERE donor_id = $1', [donorId]);
  await pool.query('DELETE FROM price_history WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
  if (orderId) await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
  await pool.query('DELETE FROM donors WHERE id = $1', [donorId]);
  await pool.query('DELETE FROM bins WHERE bin_number = $1', [TEST_BIN_NUMBER]);
}

async function run() {
  const ctx = await setup();
  const { rows: idRows } = await pool.query(`SELECT nextval('orders_id_seq') AS id`);
  const orderId = Number(idRows[0].id);
  ctx.orderId = orderId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await completeOrderFullyWithCredit(client, {
      orderId,
      orderNumber: `TEST-${orderId}`,
      customerEmail: 'test@example.com',
      subtotalCents: 1000,
      items: [{ id: ctx.itemId }],
      donorId: ctx.donorId,
      creditCents: 1000
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: orderRows } = await pool.query('SELECT status, credit_applied_cents FROM orders WHERE id = $1', [
    orderId
  ]);
  assert.strictEqual(orderRows[0].status, 'paid', 'Order should be marked paid');
  assert.strictEqual(orderRows[0].credit_applied_cents, 1000, 'Order should record the credit applied');

  const { rows: itemRows } = await pool.query('SELECT status FROM items WHERE id = $1', [ctx.itemId]);
  assert.strictEqual(itemRows[0].status, 'sold_pending_pull', 'Item should transition to sold_pending_pull');

  const balance = await getBalanceCents(pool, ctx.donorId);
  assert.strictEqual(balance, 0, 'Full $10.00 credit should be spent, leaving a $0 balance');

  await cleanup(ctx);
  console.log('PASS: full-credit checkout atomically pays the order, sells the item, and debits the ledger.');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('FAIL:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/store-credit-full-redemption.test.js`
Expected: FAIL — `completeOrderFullyWithCredit` already exists from Task 1, so this should actually PASS already if Task 1 was completed correctly. Run it now to confirm that baseline before touching the routes in the steps below, so any later failure is clearly attributable to this task's route/webhook changes, not the underlying function.

If no local `DATABASE_URL` is available, skip running it and note that in your report.

- [ ] **Step 3: Add the Stripe coupon to `createCheckoutSession`**

Replace `lib/stripe.js` in full:

```js
const Stripe = require('stripe');

let stripeClient = null;

function getClient() {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// price_data is always built from the item's current price_current_cents in our DB,
// never trusted from the browser (Section 9) — the client can't influence what gets charged.
async function createCheckoutSession({ orderId, items, customerEmail, creditCentsToApply = 0 }) {
  const lineItems = items.map((item) => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.title || `Item #${item.id}` },
      unit_amount: item.price_current_cents
    },
    // Always 1 — every item is one-of-a-kind. This is Stripe's required line-item field,
    // not the restockable-SKU "quantity" concept that's banned from this app (Section 2).
    quantity: 1
  }));

  const sessionParams = {
    mode: 'payment',
    line_items: lineItems,
    customer_email: customerEmail,
    success_url: `${process.env.BASE_URL}/order/success?order=${orderId}`,
    cancel_url: `${process.env.BASE_URL}/order/cancelled?order=${orderId}`,
    // The order id lets the webhook find the order; item_ids lets it know exactly which
    // items to transition to sold_pending_pull once payment is confirmed (Section 9).
    metadata: {
      order_id: String(orderId),
      item_ids: items.map((item) => item.id).join(',')
    }
  };

  if (creditCentsToApply > 0) {
    // A one-time dynamic discount for exactly the credit being applied — simpler than
    // trying to shrink individual line-item prices to add up to the right remainder.
    const coupon = await getClient().coupons.create({
      amount_off: creditCentsToApply,
      currency: 'usd',
      duration: 'once',
      name: `Store credit applied to order ${orderId}`
    });
    sessionParams.discounts = [{ coupon: coupon.id }];
  }

  return getClient().checkout.sessions.create(sessionParams);
}

module.exports = { getClient, createCheckoutSession };
```

- [ ] **Step 4: Update `POST /checkout` to validate and apply credit**

Task 3 added `const { getBalanceCents } = require('../lib/store-credit');` to `routes/storefront.js`. Replace that single line with:

```js
const { getBalanceCents, completeOrderFullyWithCredit } = require('../lib/store-credit');
```

(One import line total for this module — don't add a second, separate `require('../lib/store-credit')` line.)

Replace the existing `POST /checkout` route (currently `routes/storefront.js:156-197`):

```js
router.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const email = (req.body.email || '').trim();

    if (!email || !email.includes('@')) {
      const { items, subtotalCents } = await loadCartItems(req.cartToken);
      return res.render('storefront/cart', { items, subtotalCents, error: 'Enter a valid email to check out.' });
    }

    const { items, subtotalCents } = await loadCartItems(req.cartToken);
    if (items.length === 0) {
      return res.redirect('/cart');
    }

    // A slow checkout (entering card details, etc.) shouldn't lose the reservation out
    // from under the customer — refresh the clock right as they start (Section 9).
    await pool.query(
      `UPDATE items
          SET reserved_until = NOW() + INTERVAL '30 minutes', updated_at = NOW()
        WHERE reserved_by_cart = $1 AND status = 'reserved'`,
      [req.cartToken]
    );

    const { rows: idRows } = await pool.query(`SELECT nextval('orders_id_seq') AS id`);
    const orderId = Number(idRows[0].id);
    const orderNumber = `TS-${orderId}`;

    // Stripe session is created before the order row exists, per Section 9 — its id is
    // embedded in the session metadata so the webhook (the source of truth for payment,
    // never this browser redirect) can find the order later.
    const session = await createCheckoutSession({ orderId, items, customerEmail: email });

    await pool.query(
      `INSERT INTO orders (id, order_number, customer_email, subtotal_cents, stripe_session_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [orderId, orderNumber, email, subtotalCents, session.id]
    );

    res.redirect(303, session.url);
  })
);
```

with:

```js
router.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const email = (req.body.email || '').trim();

    if (!email || !email.includes('@')) {
      const { items, subtotalCents } = await loadCartItems(req.cartToken);
      return res.render('storefront/cart', {
        items,
        subtotalCents,
        error: 'Enter a valid email to check out.',
        donorPhone: null,
        donorBalanceCents: null
      });
    }

    const { items, subtotalCents } = await loadCartItems(req.cartToken);
    if (items.length === 0) {
      return res.redirect('/cart');
    }

    // A slow checkout (entering card details, etc.) shouldn't lose the reservation out
    // from under the customer — refresh the clock right as they start (Section 9).
    await pool.query(
      `UPDATE items
          SET reserved_until = NOW() + INTERVAL '30 minutes', updated_at = NOW()
        WHERE reserved_by_cart = $1 AND status = 'reserved'`,
      [req.cartToken]
    );

    // Store credit, if the shopper checked a balance and chose to apply some. Re-derived
    // from scratch here — nothing from the form is trusted past this point, the same way
    // price_current_cents (not a client-supplied price) is what Stripe actually charges.
    let donorId = null;
    let creditCentsToApply = 0;
    const donorPhone = (req.body.donor_phone || '').replace(/\D/g, '');
    const requestedCreditCents = req.body.credit_dollars ? Math.round(Number(req.body.credit_dollars) * 100) : 0;

    if (donorPhone && requestedCreditCents > 0) {
      const { rows: donorRows } = await pool.query('SELECT id FROM donors WHERE phone_number = $1', [donorPhone]);
      if (donorRows.length > 0) {
        donorId = donorRows[0].id;
        const balanceCents = await getBalanceCents(pool, donorId);
        creditCentsToApply = Math.min(requestedCreditCents, balanceCents, subtotalCents);
      }
    }

    const { rows: idRows } = await pool.query(`SELECT nextval('orders_id_seq') AS id`);
    const orderId = Number(idRows[0].id);
    const orderNumber = `TS-${orderId}`;

    if (creditCentsToApply > 0 && creditCentsToApply >= subtotalCents) {
      // Credit covers the whole order — nothing for Stripe to charge, so this completes
      // the order directly instead of ever creating a checkout session.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await completeOrderFullyWithCredit(client, {
          orderId,
          orderNumber,
          customerEmail: email,
          subtotalCents,
          items,
          donorId,
          creditCents: creditCentsToApply
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return res.redirect(`/order/success?order=${orderId}`);
    }

    // Stripe session is created before the order row exists, per Section 9 — its id is
    // embedded in the session metadata so the webhook (the source of truth for payment,
    // never this browser redirect) can find the order later. The ledger isn't debited
    // yet — only at payment confirmation (see routes/webhooks.js) — so an abandoned
    // checkout never wrongly consumes a donor's credit.
    const session = await createCheckoutSession({
      orderId,
      items,
      customerEmail: email,
      creditCentsToApply
    });

    await pool.query(
      `INSERT INTO orders (id, order_number, customer_email, subtotal_cents, stripe_session_id, status, credit_donor_id, credit_applied_cents)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [orderId, orderNumber, email, subtotalCents, session.id, donorId, creditCentsToApply]
    );

    res.redirect(303, session.url);
  })
);
```

- [ ] **Step 5: Debit the ledger in the webhook when payment confirms**

In `routes/webhooks.js`, add this import alongside the existing ones:

```js
const { redeemCredit } = require('../lib/store-credit');
```

Change this block (currently `routes/webhooks.js:58-76`):

```js
      const { rows: orderRows } = await client.query(
        `UPDATE orders
            SET status = 'paid', paid_at = NOW(), stripe_payment_intent = $1
          WHERE id = $2 AND status = 'pending'
          RETURNING *`,
        [session.payment_intent, orderId]
      );

      if (orderRows.length === 0) {
        throw new Error(`checkout.session.completed for unknown or already-paid order ${orderId}`);
      }

      for (const itemId of itemIds) {
        // An item must never be sold twice — this conditional transition is the only
        // path from reserved to sold_pending_pull in the whole app (Section 2, 6).
        await transitionItem(client, itemId, 'reserved', 'sold_pending_pull', { order_id: orderId });
      }

      await client.query('COMMIT');
```

to:

```js
      const { rows: orderRows } = await client.query(
        `UPDATE orders
            SET status = 'paid', paid_at = NOW(), stripe_payment_intent = $1
          WHERE id = $2 AND status = 'pending'
          RETURNING *`,
        [session.payment_intent, orderId]
      );

      if (orderRows.length === 0) {
        throw new Error(`checkout.session.completed for unknown or already-paid order ${orderId}`);
      }

      for (const itemId of itemIds) {
        // An item must never be sold twice — this conditional transition is the only
        // path from reserved to sold_pending_pull in the whole app (Section 2, 6).
        await transitionItem(client, itemId, 'reserved', 'sold_pending_pull', { order_id: orderId });
      }

      // Credit was only noted on the order at checkout time — it's actually debited now,
      // at the same moment payment is confirmed, so an abandoned checkout never wrongly
      // consumes a donor's balance.
      const order = orderRows[0];
      if (order.credit_donor_id && order.credit_applied_cents > 0) {
        await redeemCredit(client, order.credit_donor_id, order.credit_applied_cents, orderId);
      }

      await client.query('COMMIT');
```

- [ ] **Step 6: Run test to verify it still passes**

Run: `node test/store-credit-full-redemption.test.js`
Expected: `PASS: full-credit checkout atomically pays the order, sells the item, and debits the ledger.`

- [ ] **Step 7: Verify syntax on everything touched**

```bash
node -c lib/stripe.js && node -c routes/storefront.js && node -c routes/webhooks.js && echo "all OK"
```

Expected: `all OK`

- [ ] **Step 8: Commit**

```bash
git add lib/stripe.js routes/storefront.js routes/webhooks.js test/store-credit-full-redemption.test.js
git commit -m "Redeem store credit at checkout, via Stripe coupon or a full-credit direct path"
```

---

## Self-review notes

- **Spec coverage:** schema (Task 1), automatic payout on pickup (Task 2), cart balance lookup (Task 3), checkout redemption for both partial (Stripe coupon) and full (direct path) credit (Task 4), webhook debiting credit only at payment confirmation (Task 4 Step 5) — every section of the spec has a corresponding task.
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code.
- **Type/name consistency:** `getBalanceCents(client, donorId)`, `issuePayout(client, item)`, `redeemCredit(client, donorId, amountCents, orderId)`, and `completeOrderFullyWithCredit(client, {...})` are defined once in Task 1 and used with matching signatures in Tasks 2–4. `donor_phone` / `credit_dollars` form field names match between the view (Task 3) and the route that reads `req.body`/`req.query` for them (Tasks 3–4).
- **Correction from the spec:** removed the mention of writing `price_history` rows in the full-credit path, since the real webhook it mirrors doesn't do that either (see the note under Architecture above).
