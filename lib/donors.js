const pool = require('../db/pool');
const { getBalanceCents } = require('./store-credit');

// The Donations page's default view — most recently registered first, with a couple of
// at-a-glance stats so staff don't have to open each one just to see whether a donor has
// any real history.
async function getRecentDonors(limit = 20) {
  const { rows } = await pool.query(
    `SELECT d.id, d.phone_number, d.created_at,
            COUNT(i.id) AS items_donated_count,
            COALESCE(SUM(sc.amount_cents), 0)::int AS balance_cents
       FROM donors d
       LEFT JOIN items i ON i.donor_id = d.id
       LEFT JOIN store_credit_ledger sc ON sc.donor_id = d.id
      GROUP BY d.id
      ORDER BY d.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function findDonorByPhone(phoneDigitsOnly) {
  const { rows } = await pool.query('SELECT * FROM donors WHERE phone_number = $1', [phoneDigitsOnly]);
  return rows[0] || null;
}

// Full history for one donor: their info, current balance, every item they've ever
// donated (with its current status/price, so staff can see what sold vs. what's still on
// the floor), and the raw ledger entries (payouts + redemptions) behind that balance.
async function getDonorHistory(donorId) {
  const { rows: donorRows } = await pool.query('SELECT * FROM donors WHERE id = $1', [donorId]);
  if (donorRows.length === 0) return null;

  const balanceCents = await getBalanceCents(pool, donorId);

  const { rows: items } = await pool.query(
    `SELECT id, title, category, status, bin_number, price_original_cents, price_current_cents, created_at
       FROM items
      WHERE donor_id = $1
      ORDER BY created_at DESC`,
    [donorId]
  );

  const { rows: ledger } = await pool.query(
    `SELECT id, amount_cents, reason, item_id, order_id, created_at
       FROM store_credit_ledger
      WHERE donor_id = $1
      ORDER BY created_at DESC`,
    [donorId]
  );

  return { donor: donorRows[0], balanceCents, items, ledger };
}

module.exports = { getRecentDonors, findDonorByPhone, getDonorHistory };
