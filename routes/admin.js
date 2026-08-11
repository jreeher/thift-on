const express = require('express');
const pool = require('../db/pool');
const { requireStaffAuth } = require('../middleware/auth');
const { transitionItem } = require('../db/transitions');
const { ALLOWED_CATEGORIES, clampSuggestedPrice, basePriceForCategory } = require('../lib/pricing');
const { isConsolidationCandidate } = require('../lib/bins');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.use(requireStaffAuth);
router.use(express.urlencoded({ extended: false }));

router.get(
  '/review',
  asyncHandler(async (req, res) => {
    const { rows: items } = await pool.query(
      `SELECT * FROM items WHERE status = 'draft' ORDER BY created_at ASC`
    );
    res.render('admin/review', { items, categories: ALLOWED_CATEGORIES, error: null });
  })
);

router.post(
  '/review/:id/approve',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    const {
      title,
      category,
      description,
      condition_notes: conditionNotes,
      price_cents: priceCentsRaw,
      bin_number: binNumberRaw
    } = req.body;

    const finalCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'other';
    const parsedPrice = Number(priceCentsRaw);
    const priceCents = clampSuggestedPrice(
      finalCategory,
      Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : basePriceForCategory(finalCategory)
    );
    const binNumber = binNumberRaw ? Number(binNumberRaw) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // A human must approve every item before it goes live (Section 2) — this route is
      // the only path that moves an item from draft to active.
      const item = await transitionItem(client, itemId, 'draft', 'active', {
        title: title || null,
        category: finalCategory,
        description: description || null,
        condition_notes: conditionNotes || null,
        bin_number: binNumber,
        price_original_cents: priceCents,
        price_current_cents: priceCents,
        listed_at: new Date(),
        human_edited: true
      });

      await client.query(
        `INSERT INTO price_history (item_id, price_cents, reason) VALUES ($1, $2, 'initial')`,
        [item.id, priceCents]
      );

      await client.query('COMMIT');
      res.redirect('/admin/review');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

router.get(
  '/bins',
  asyncHandler(async (req, res) => {
    const { rows: bins } = await pool.query(`
      SELECT b.*, COUNT(i.id) FILTER (
               WHERE i.status NOT IN ('picked_up', 'expired', 'removed')
             ) AS occupied_count
        FROM bins b
        LEFT JOIN items i ON i.bin_number = b.bin_number
       GROUP BY b.id
       ORDER BY b.bin_number ASC
    `);

    // Consolidation is only ever a suggestion computed here from live occupancy — nothing
    // physical moves and no status changes until a human taps "Flag for Consolidation"
    // below (Section 2).
    const binsWithSuggestions = bins.map((bin) => ({
      ...bin,
      consolidationSuggested: isConsolidationCandidate(bin)
    }));

    res.render('admin/bins', { bins: binsWithSuggestions, error: null });
  })
);

router.post(
  '/bins',
  asyncHandler(async (req, res) => {
    const binNumber = Number(req.body.bin_number);
    const capacity = req.body.capacity ? Number(req.body.capacity) : 20;

    if (!Number.isInteger(binNumber) || binNumber <= 0) {
      const { rows: bins } = await pool.query('SELECT * FROM bins ORDER BY bin_number ASC');
      return res.render('admin/bins', { bins, error: 'Bin number must be a positive integer.' });
    }

    await pool.query(
      `INSERT INTO bins (bin_number, capacity) VALUES ($1, $2) ON CONFLICT (bin_number) DO NOTHING`,
      [binNumber, capacity]
    );
    res.redirect('/admin/bins');
  })
);

router.post(
  '/bins/:id/retire',
  asyncHandler(async (req, res) => {
    // Retiring/consolidating a bin is a human decision made by tapping a button here —
    // software never moves a physical item or infers bin state changes (Section 2).
    await pool.query(`UPDATE bins SET status = 'retired' WHERE id = $1`, [req.params.id]);
    res.redirect('/admin/bins');
  })
);

router.post(
  '/bins/:id/flag-consolidation',
  asyncHandler(async (req, res) => {
    // Acknowledging a consolidation suggestion is itself the human confirmation — the
    // suggestion alone never changes bin status (Section 2).
    await pool.query(`UPDATE bins SET status = 'needs_consolidation' WHERE id = $1 AND status = 'active'`, [
      req.params.id
    ]);
    res.redirect('/admin/bins');
  })
);

router.post(
  '/bins/:id/resolve-consolidation',
  asyncHandler(async (req, res) => {
    // Tapped once staff have physically moved the bin's items elsewhere — the bin itself
    // is now empty and available for reuse. This does not move any item; reassigning an
    // item's bin_number remains a separate, explicit edit.
    await pool.query(
      `UPDATE bins
          SET status = 'active', last_consolidated_at = NOW()
        WHERE id = $1 AND status = 'needs_consolidation'`,
      [req.params.id]
    );
    res.redirect('/admin/bins');
  })
);

module.exports = router;
