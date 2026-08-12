const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireStaffAuth } = require('../middleware/auth');
const { transitionItem } = require('../db/transitions');
const { ALLOWED_CATEGORIES, clampSuggestedPrice, basePriceForCategory } = require('../lib/pricing');
const { isConsolidationCandidate } = require('../lib/bins');
const { uploadPhoto } = require('../lib/storage');
const { analyzeItemPhoto } = require('../lib/ai');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const INTAKE_BIN_COOKIE = 'intake_bin';
const LAST_INTAKE_BIN_COOKIE = 'last_intake_bin';

function intakeCookieOptions(maxAgeMs) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeMs
  };
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
  '/intake',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.render('admin/intake-open', {
        lastBin: req.signedCookies[LAST_INTAKE_BIN_COOKIE] || '',
        error: null
      });
    }
    res.render('admin/intake-upload', { binNumber: openBin, error: null });
  })
);

router.post(
  '/intake/open',
  asyncHandler(async (req, res) => {
    const binNumber = req.body.bin_number ? Number(req.body.bin_number) : NaN;
    if (!Number.isInteger(binNumber)) {
      return res.render('admin/intake-open', {
        lastBin: req.body.bin_number || '',
        error: 'Bin number must be an integer.'
      });
    }

    // Bins are no longer pre-created on a separate page — any bin number works, and
    // opening it here creates the row on first use (no-op if it already exists).
    await pool.query('INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING', [binNumber]);

    res.cookie(INTAKE_BIN_COOKIE, String(binNumber), intakeCookieOptions(12 * 60 * 60 * 1000));
    res.cookie(LAST_INTAKE_BIN_COOKIE, String(binNumber), intakeCookieOptions(30 * 24 * 60 * 60 * 1000));
    res.redirect('/admin/intake');
  })
);

router.post(
  '/intake/close',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (openBin) {
      const binNumber = Number(openBin);
      // Snapshot how full this bin got during the session that's ending, so the
      // consolidation suggestion (lib/bins.js) has a self-computed baseline instead of a
      // manually-typed capacity. Only ever ratchets up (GREATEST), never down.
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS occupied_count
           FROM items
          WHERE bin_number = $1 AND status NOT IN ('picked_up', 'expired', 'removed')`,
        [binNumber]
      );
      await pool.query('UPDATE bins SET peak_item_count = GREATEST(peak_item_count, $1) WHERE bin_number = $2', [
        rows[0].occupied_count,
        binNumber
      ]);
    }

    res.clearCookie(INTAKE_BIN_COOKIE);
    res.redirect('/admin/intake');
  })
);

router.post(
  '/intake',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.redirect('/admin/intake');
    }
    const binNumber = Number(openBin);

    if (!req.file) {
      return res.render('admin/intake-upload', { binNumber, error: 'A photo is required.' });
    }

    // Bins are never deleted (only retired via status), and /intake/open already created
    // this row — this is just a self-healing no-op guard, not an error path.
    await pool.query('INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING', [binNumber]);

    const { key, url } = await uploadPhoto(req.file.buffer, req.file.mimetype);

    // AI output is a draft, never published automatically (Section 2).
    const { fields, raw } = await analyzeItemPhoto(req.file.buffer, req.file.mimetype);

    const { rows } = await pool.query(
      `INSERT INTO items (
         bin_number, photo_key, photo_url, title, category, description, condition_notes,
         ai_raw_response, ai_confidence, price_original_cents, price_current_cents, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'draft')
       RETURNING id`,
      [
        binNumber,
        key,
        url,
        fields.title,
        fields.category,
        fields.description,
        fields.conditionNotes,
        raw ? JSON.stringify(raw) : null,
        fields.confidence,
        fields.priceCents
      ]
    );

    res.redirect(`/admin/intake/${rows[0].id}`);
  })
);

router.get(
  '/intake/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1 AND status = 'draft'`, [req.params.id]);
    if (rows.length === 0) {
      return res.redirect('/admin/intake');
    }
    res.render('admin/intake-review', { item: rows[0], categories: ALLOWED_CATEGORIES });
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
    // item's bin_number remains a separate, explicit edit. peak_item_count resets since a
    // reused bin starts a fresh filling cycle — the old high-water mark no longer applies.
    await pool.query(
      `UPDATE bins
          SET status = 'active', last_consolidated_at = NOW(), peak_item_count = 0
        WHERE id = $1 AND status = 'needs_consolidation'`,
      [req.params.id]
    );
    res.redirect('/admin/bins');
  })
);

module.exports = router;
