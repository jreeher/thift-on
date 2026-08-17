// Verifies jobs/markdown.js is idempotent (Section 10) using a mocked db/pool. Unlike
// the cart-concurrency test, this doesn't need real Postgres locking to be meaningful —
// idempotency here is pure branching logic (does the computed price match what's already
// stored?), which a mock captures faithfully.
//
// Run with: node test/markdown-idempotency.test.js
const assert = require('assert');
const pool = require('../db/pool');
const { recalculatePrices } = require('../jobs/markdown');

let clientQueryCalls = [];

const fakeClient = {
  query: async (sql) => {
    clientQueryCalls.push(sql.trim());
    return { rows: [{ id: 1 }], rowCount: 1 };
  },
  release: () => {}
};

function mockPool(selectRows) {
  clientQueryCalls = [];
  pool.query = async () => ({ rows: selectRows });
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

  // An item well past the week-4 floor should land at exactly 20% of original, not lower,
  // and stay 'active' — items no longer expire out of the shop on their own.
  const veryOldListedAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // ~13 weeks ago
  mockPool([
    { id: 2, status: 'active', price_original_cents: 1000, price_current_cents: 1000, listed_at: veryOldListedAt }
  ]);
  const floorRun = await recalculatePrices();
  assert.strictEqual(floorRun.updatedCount, 1, 'far-past-floor item should still get its price updated once');
  assert.ok(
    clientQueryCalls.some((s) => s.includes('SET price_current_cents')),
    'should be a plain price update'
  );
  assert.ok(
    !clientQueryCalls.some((s) => s.includes('SET status') || s.includes("'expired'")),
    'should never transition status — items no longer expire'
  );

  // Re-running against the now-floored price must again be a true no-op — proves the
  // floor actually holds instead of continuing to decay.
  mockPool([
    { id: 2, status: 'active', price_original_cents: 1000, price_current_cents: 200, listed_at: veryOldListedAt }
  ]);
  const floorRerun = await recalculatePrices();
  assert.strictEqual(floorRerun.updatedCount, 0, 'price at the 20% floor should never be touched again');
  assert.strictEqual(clientQueryCalls.length, 0);

  console.log('PASS: markdown job updates stale items, holds at the 20% floor indefinitely, and is a true no-op on rerun.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
