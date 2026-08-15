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
      customerName: 'Test',
      customerPhone: '5555550299',
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
