// Verifies jobs/purge-photos.js is idempotent (Section 10) using mocked db/pool and
// lib/storage — a real run's idempotency comes from the WHERE photo_deleted = FALSE
// guard in the actual SQL; this test proves the job's own logic doesn't do anything
// extra on a rerun once that guard has correctly excluded an item.
//
// Run with: node test/purge-photos-idempotency.test.js
const assert = require('assert');
const pool = require('../db/pool');
const storage = require('../lib/storage');

const deleteCalls = [];
// Patched before requiring jobs/purge-photos.js so its destructured `deletePhoto`
// binding picks up this mock instead of the real R2 client.
storage.deletePhoto = async (key) => {
  deleteCalls.push(key);
};

const { purgePhotos } = require('../jobs/purge-photos');

let updateCalls = [];

function mockPool(candidateRows) {
  updateCalls = [];
  pool.query = async (sql, params) => {
    if (sql.includes('SELECT id, photo_key')) {
      return { rows: candidateRows };
    }
    if (sql.includes('UPDATE items')) {
      updateCalls.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };
}

async function run() {
  // First run: one eligible photo to purge.
  mockPool([{ id: 1, photo_key: 'items/abc.jpg' }]);
  const firstCount = await purgePhotos();
  assert.strictEqual(firstCount, 1, 'first run should purge the one eligible item');
  assert.strictEqual(deleteCalls.length, 1, 'first run should delete the R2 object once');
  assert.strictEqual(updateCalls.length, 1, 'first run should mark photo_deleted once');

  // Second run: the item is now photo_deleted = TRUE, so against a real database the
  // WHERE photo_deleted = FALSE guard means the SELECT no longer returns it.
  mockPool([]);
  const secondCount = await purgePhotos();
  assert.strictEqual(secondCount, 0, 'second run should find nothing left to purge');
  assert.strictEqual(deleteCalls.length, 1, 'second run should not call deletePhoto again');

  console.log('PASS: purge-photos job purges once, then is a true no-op on rerun.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
