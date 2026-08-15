// Proves the full-credit checkout path can't double-process a double-submitted form: two
// concurrent completeOrderFullyWithCredit calls for the same reserved item can only ever
// have one succeed, and the loser's entire transaction (including its ledger debit) rolls
// back rather than leaving a partial charge. Requires a live DATABASE_URL — this exercises
// transitionItem's real conditional-UPDATE guard against a real Postgres instance, the
// same way test/cart-concurrency.test.js does.
//
// Run with: node test/store-credit-concurrent-redemption.test.js
require('dotenv').config();
const assert = require('assert');
const pool = require('../db/pool');
const { completeOrderFullyWithCredit, getBalanceCents } = require('../lib/store-credit');

const TEST_BIN_NUMBER = 999996;
const TEST_PHONE = '5555550399';

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

  // Enough credit to cover the item twice over, so a double-charge (if the guard failed)
  // wouldn't be masked by simply running out of balance first.
  await pool.query(
    `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason) VALUES ($1, 2000, 'consignment_payout')`,
    [donorId]
  );

  const { rows: itemRows } = await pool.query(
    `INSERT INTO items (bin_number, title, category, status, price_original_cents, price_current_cents, listed_at)
     VALUES ($1, 'Concurrent redemption test item', 'other', 'reserved', 1000, 1000, NOW())
     RETURNING id`,
    [TEST_BIN_NUMBER]
  );

  return { donorId, itemId: itemRows[0].id };
}

async function cleanup({ donorId, itemId, orderIds }) {
  await pool.query('DELETE FROM store_credit_ledger WHERE donor_id = $1', [donorId]);
  await pool.query('DELETE FROM price_history WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
  for (const orderId of orderIds) {
    await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
  }
  await pool.query('DELETE FROM donors WHERE id = $1', [donorId]);
  await pool.query('DELETE FROM bins WHERE bin_number = $1', [TEST_BIN_NUMBER]);
}

async function attemptCompletion(ctx, orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await completeOrderFullyWithCredit(client, {
      orderId,
      orderNumber: `TEST-CONCURRENT-${orderId}`,
      customerEmail: 'test@example.com',
      subtotalCents: 1000,
      items: [{ id: ctx.itemId }],
      donorId: ctx.donorId,
      creditCents: 1000
    });
    await client.query('COMMIT');
    return { succeeded: true };
  } catch (err) {
    await client.query('ROLLBACK');
    return { succeeded: false, error: err };
  } finally {
    client.release();
  }
}

async function run() {
  const ctx = await setup();

  const { rows: idRowsA } = await pool.query(`SELECT nextval('orders_id_seq') AS id`);
  const { rows: idRowsB } = await pool.query(`SELECT nextval('orders_id_seq') AS id`);
  const orderIdA = Number(idRowsA[0].id);
  const orderIdB = Number(idRowsB[0].id);
  ctx.orderIds = [orderIdA, orderIdB];

  const [resultA, resultB] = await Promise.all([
    attemptCompletion(ctx, orderIdA),
    attemptCompletion(ctx, orderIdB)
  ]);

  const successCount = [resultA, resultB].filter((r) => r.succeeded).length;
  assert.strictEqual(
    successCount,
    1,
    `Expected exactly one of two concurrent completions to succeed, got ${successCount}`
  );

  const balance = await getBalanceCents(pool, ctx.donorId);
  assert.strictEqual(
    balance,
    1000,
    'Only one $10.00 debit should have gone through, leaving $10.00 of the original $20.00'
  );

  const { rows: itemRows } = await pool.query('SELECT status FROM items WHERE id = $1', [ctx.itemId]);
  assert.strictEqual(itemRows[0].status, 'sold_pending_pull', 'Item should be sold exactly once');

  await cleanup(ctx);
  console.log('PASS: concurrent full-credit completions for the same item — exactly one succeeds, no double-charge.');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('FAIL:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
