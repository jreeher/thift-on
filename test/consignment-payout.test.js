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
