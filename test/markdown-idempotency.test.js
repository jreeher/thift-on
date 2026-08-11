// Verifies jobs/markdown.js is idempotent (Section 10) using a mocked db/pool. Unlike
// the cart-concurrency test, this doesn't need real Postgres locking to be meaningful —
// idempotency here is pure branching logic (does the computed price match what's already
// stored?), which a mock captures faithfully.
//
// Run with: node test/markdown-idempotency.test.js
const assert = require('assert');
const pool = require('../db/pool');
const { recalculatePrices } = require('../jobs/markdown');

let selectCalls = [];
let clientQueryCalls = [];

const fakeClient = {
  query: async (sql) => {
    clientQueryCalls.push(sql.trim());
    // A generic row is enough to satisfy transitionItem's RETURNING * check.
    return { rows: [{ id: 1, order_id: null }], rowCount: 1 };
  },
  release: () => {}
};

function mockPool(selectRows) {
  selectCalls = [];
  clientQueryCalls = [];
  pool.query = async (sql) => {
    selectCalls.push(sql);
    return { rows: selectRows };
  };
  pool.connect = async () => fakeClient;
}

async function run() {
  const listedAt = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000); // 3 weeks ago -> 40% of original

  // First run: stored price (1000) doesn't match the computed markdown price (400) for
  // 3 weeks elapsed — this must trigger a real update.
  mockPool([
    { id: 1, status: 'active', price_original_cents: 1000, price_current_cents: 1000, listed_at: listedAt }
  ]);
  const firstRun = await recalculatePrices();
  assert.strictEqual(firstRun.updatedCount, 1, 'first run should update the stale item');
  assert.ok(clientQueryCalls.some((s) => s.includes('UPDATE items')), 'first run should issue an UPDATE');
  assert.ok(
    clientQueryCalls.some((s) => s.includes('INSERT INTO price_history')),
    'first run should write a price_history row'
  );

  // Second run: simulate that the first run's update actually persisted — stored price
  // now equals the computed price. Re-running against unchanged data must be a no-op.
  mockPool([
    { id: 1, status: 'active', price_original_cents: 1000, price_current_cents: 400, listed_at: listedAt }
  ]);
  const secondRun = await recalculatePrices();
  assert.strictEqual(secondRun.updatedCount, 0, 'second run should update nothing');
  assert.strictEqual(clientQueryCalls.length, 0, 'second run should never even open a transaction');

  // Separately: an item 5+ weeks past listing should expire (active -> expired), not just
  // get a price update.
  const oldListedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 5+ weeks ago
  mockPool([
    { id: 2, status: 'active', price_original_cents: 1000, price_current_cents: 1000, listed_at: oldListedAt }
  ]);
  const expireRun = await recalculatePrices();
  assert.strictEqual(expireRun.expiredCount, 1, 'item past week 5 should be counted as expired');
  assert.ok(
    clientQueryCalls.some((s) => s.includes("price_current_cents = $2")),
    'expiring should set price_current_cents to 0 as part of the same transition'
  );

  console.log('PASS: markdown job updates stale items, expires week-5+ items, and is a true no-op on rerun.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
