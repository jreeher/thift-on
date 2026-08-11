const pool = require('../db/pool');
const { deletePhoto } = require('../lib/storage');

const RETENTION_DAYS = 7;

// Runs daily at 03:30 (Section 10). Must be idempotent: the WHERE photo_deleted = FALSE
// guard, both in the candidate query and the update, means an item is only ever touched
// once — re-running finds nothing left to purge and does nothing.
async function purgePhotos() {
  // RETENTION_DAYS is passed as a parameter (multiplied against a 1-day interval) rather
  // than interpolated into the SQL string, keeping every query parameterized (Section 15).
  const { rows: candidates } = await pool.query(
    `SELECT id, photo_key
       FROM items
      WHERE photo_deleted = FALSE
        AND (
          (status = 'picked_up' AND picked_up_at < NOW() - ($1 * INTERVAL '1 day'))
          OR (status IN ('expired', 'removed') AND updated_at < NOW() - ($1 * INTERVAL '1 day'))
        )`,
    [RETENTION_DAYS]
  );

  let purgedCount = 0;

  for (const item of candidates) {
    try {
      if (item.photo_key) {
        await deletePhoto(item.photo_key);
      }

      await pool.query(
        `UPDATE items
            SET photo_deleted = TRUE, photo_deleted_at = NOW(), photo_url = NULL
          WHERE id = $1 AND photo_deleted = FALSE`,
        [item.id]
      );

      purgedCount += 1;
    } catch (err) {
      // Leave photo_deleted = FALSE so a future run retries — we'd rather retry a
      // purge than silently lose track of a photo still sitting in R2.
      console.error(`purgePhotos: failed to purge item ${item.id}:`, err.message);
    }
  }

  console.log(`purgePhotos: purged ${purgedCount} item(s)`);
  return purgedCount;
}

module.exports = { purgePhotos };
