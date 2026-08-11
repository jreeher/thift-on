// Proves the Section 2 guarantee against a REAL Postgres instance: two simultaneous
// "add to cart" requests for the same one-of-a-kind item can never both succeed. This
// requires a live DATABASE_URL — the conditional UPDATE ... WHERE status = 'active' is
// only meaningful under real row-level locking across two actual connections, which an
// in-memory mock cannot faithfully reproduce.
//
// Run with: node test/cart-concurrency.test.js
require('dotenv').config();
const assert = require('assert');
const pool = require('../db/pool');

const TEST_BIN_NUMBER = 999999;
const TRIALS = 10;

async function addToCart(itemId, cartToken) {
  return pool.query(
    `UPDATE items
        SET status = 'reserved',
            reserved_by_cart = $1,
            reserved_until = NOW() + INTERVAL '20 minutes',
            updated_at = NOW()
      WHERE id = $2 AND status = 'active'
      RETURNING id`,
    [cartToken, itemId]
  );
}

async function createTestItem() {
  const { rows } = await pool.query(
    `INSERT INTO items (bin_number, title, category, status, price_original_cents, price_current_cents, listed_at)
     VALUES ($1, 'Concurrency test item', 'other', 'active', 500, 500, NOW())
     RETURNING id`,
    [TEST_BIN_NUMBER]
  );
  return rows[0].id;
}

async function cleanupItem(itemId) {
  await pool.query('DELETE FROM price_history WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
}

async function runTrial(trialNumber) {
  const itemId = await createTestItem();

  const [resultA, resultB] = await Promise.all([
    addToCart(itemId, `cart-token-A-${trialNumber}`),
    addToCart(itemId, `cart-token-B-${trialNumber}`)
  ]);

  const successCount = [resultA, resultB].filter((r) => r.rowCount === 1).length;

  await cleanupItem(itemId);

  assert.strictEqual(
    successCount,
    1,
    `Trial ${trialNumber}: expected exactly one concurrent add to succeed, got ${successCount}`
  );
}

async function run() {
  await pool.query(`INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING`, [
    TEST_BIN_NUMBER
  ]);

  for (let i = 1; i <= TRIALS; i += 1) {
    await runTrial(i);
  }

  await pool.query('DELETE FROM bins WHERE bin_number = $1', [TEST_BIN_NUMBER]);

  console.log(`PASS: exactly one of two simultaneous adds succeeded, in all ${TRIALS} trials.`);
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('FAIL:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
