const pool = require('../db/pool');
const { transitionItem } = require('../db/transitions');

// Runs every 5 minutes (Section 9). Must be safe to run twice in a row: an item is only
// touched if it's still 'reserved' with an expired reserved_until, so re-running finds
// nothing left to release and does nothing.
async function releaseExpiredCarts() {
  const { rows: expired } = await pool.query(
    `SELECT id FROM items WHERE status = 'reserved' AND reserved_until < NOW()`
  );

  let releasedCount = 0;

  for (const { id } of expired) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await transitionItem(client, id, 'reserved', 'active', {
        reserved_by_cart: null,
        reserved_until: null
      });
      await client.query('COMMIT');
      releasedCount += 1;
    } catch (err) {
      // Another process may have already moved this item on (e.g. a payment webhook
      // beat the job to it) — that's fine, skip it and keep going.
      await client.query('ROLLBACK');
      console.error(`releaseExpiredCarts: failed to release item ${id}:`, err.message);
    } finally {
      client.release();
    }
  }

  if (releasedCount > 0) {
    console.log(`releaseExpiredCarts: released ${releasedCount} item(s)`);
  }

  return releasedCount;
}

module.exports = { releaseExpiredCarts };
