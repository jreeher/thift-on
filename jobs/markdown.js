const pool = require('../db/pool');
const { transitionItem } = require('../db/transitions');
const { weeksElapsedSince, currentPriceCents, isExpired } = require('../lib/pricing');

// Runs daily at 03:00 (Section 10). Must be idempotent: the price is always recomputed
// fresh from listed_at + now, never decremented incrementally, and an item whose computed
// price already matches its stored price is skipped entirely — so running this twice (or
// twenty times) in the same day writes nothing extra the second time (Section 7).
async function recalculatePrices() {
  const { rows: items } = await pool.query(
    `SELECT id, status, price_original_cents, price_current_cents, listed_at
       FROM items
      WHERE status IN ('active', 'reserved') AND listed_at IS NOT NULL`
  );

  let updatedCount = 0;
  let expiredCount = 0;

  for (const item of items) {
    const weeksElapsed = weeksElapsedSince(item.listed_at);
    const newPriceCents = currentPriceCents(item.price_original_cents, weeksElapsed);

    if (newPriceCents === item.price_current_cents) {
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let priceChanged;

      if (item.status === 'active' && isExpired(weeksElapsed)) {
        // The only lifecycle exit that happens without a human tapping a button — the
        // 5-week markdown clock running out is itself the confirmed event (Section 6/7).
        await transitionItem(client, item.id, 'active', 'expired', { price_current_cents: 0 });
        expiredCount += 1;
        priceChanged = true;
      } else {
        // Reserved items still get their price kept current (Section 9's checkout uses
        // "the item's current price at that moment"), but status itself doesn't change.
        const { rowCount } = await client.query(
          `UPDATE items SET price_current_cents = $1, updated_at = NOW() WHERE id = $2 AND status = $3`,
          [newPriceCents, item.id, item.status]
        );
        // rowCount is 0 if the item moved on (e.g. just got sold) between the SELECT
        // above and now — nothing to record in that case.
        priceChanged = rowCount > 0;
      }

      if (priceChanged) {
        await client.query(
          `INSERT INTO price_history (item_id, price_cents, reason) VALUES ($1, $2, 'weekly_markdown')`,
          [item.id, newPriceCents]
        );
        await client.query('COMMIT');
        updatedCount += 1;
      } else {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`recalculatePrices: failed to update item ${item.id}:`, err.message);
    } finally {
      client.release();
    }
  }

  console.log(`recalculatePrices: updated ${updatedCount} item(s), ${expiredCount} expired`);
  return { updatedCount, expiredCount };
}

module.exports = { recalculatePrices };
