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
const INTAKE_DONOR_COOKIE = 'intake_donor';

function intakeCookieOptions(maxAgeMs) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeMs
  };
}

async function loadCurrentDonor(req) {
  const donorId = req.signedCookies[INTAKE_DONOR_COOKIE];
  if (!donorId) return null;
  const { rows } = await pool.query('SELECT * FROM donors WHERE id = $1', [Number(donorId)]);
  return rows[0] || null;
}

router.use(requireStaffAuth);
router.use(express.urlencoded({ extended: false }));

router.get('/', (req, res) => {
  res.render('admin/home');
});

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
      price_dollars: priceDollarsRaw,
      bin_number: binNumberRaw
    } = req.body;

    const finalCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'other';
    // Staff type a dollar amount (the form is never allowed to show raw cents) — this is
    // the one place that boundary-converts it to the integer cents everything else uses.
    const parsedDollars = Number(priceDollarsRaw);
    const parsedCents = Number.isFinite(parsedDollars) && parsedDollars > 0 ? Math.round(parsedDollars * 100) : NaN;
    const priceCents = clampSuggestedPrice(
      finalCategory,
      Number.isFinite(parsedCents) && parsedCents > 0 ? parsedCents : basePriceForCategory(finalCategory)
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
    const donor = await loadCurrentDonor(req);
    res.render('admin/intake-upload', { binNumber: openBin, donor, error: null });
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
  '/intake/donor',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.redirect('/admin/intake');
    }

    // An empty submission is how "Change Donor" clears the current donor back to none.
    const donorIdRaw = (req.body.donor_id || '').trim();
    if (donorIdRaw === '') {
      res.clearCookie(INTAKE_DONOR_COOKIE);
      return res.redirect('/admin/intake');
    }

    const donorId = Number(donorIdRaw);
    if (!Number.isInteger(donorId)) {
      const donor = await loadCurrentDonor(req);
      return res.render('admin/intake-upload', {
        binNumber: openBin,
        donor,
        error: 'Donor ID must be an integer.'
      });
    }

    // Donor ids come from the Donations page, not typed freely like a bin number — a
    // donor row must already exist, so a typo doesn't silently attach items to nobody.
    const { rows } = await pool.query('SELECT id FROM donors WHERE id = $1', [donorId]);
    if (rows.length === 0) {
      const donor = await loadCurrentDonor(req);
      return res.render('admin/intake-upload', {
        binNumber: openBin,
        donor,
        error: `Donor #${donorId} not found — register them on the Donations page first.`
      });
    }

    res.cookie(INTAKE_DONOR_COOKIE, String(donorId), intakeCookieOptions(12 * 60 * 60 * 1000));
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
    const donorIdCookie = req.signedCookies[INTAKE_DONOR_COOKIE];
    const donorId = donorIdCookie ? Number(donorIdCookie) : null;

    if (!req.file) {
      const donor = await loadCurrentDonor(req);
      return res.render('admin/intake-upload', { binNumber, donor, error: 'A photo is required.' });
    }

    // Bins are never deleted (only retired via status), and /intake/open already created
    // this row — this is just a self-healing no-op guard, not an error path.
    await pool.query('INSERT INTO bins (bin_number) VALUES ($1) ON CONFLICT (bin_number) DO NOTHING', [binNumber]);

    const { key, url } = await uploadPhoto(req.file.buffer, req.file.mimetype);

    // AI output is a draft, never published automatically (Section 2).
    const { fields, raw } = await analyzeItemPhoto(req.file.buffer, req.file.mimetype);

    const { rows } = await pool.query(
      `INSERT INTO items (
         bin_number, donor_id, photo_key, photo_url, title, category, description, condition_notes,
         ai_raw_response, ai_confidence, price_original_cents, price_current_cents, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'draft')
       RETURNING id`,
      [
        binNumber,
        donorId,
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

router.get(
  '/donations',
  asyncHandler(async (req, res) => {
    const registeredDonorId = req.query.donor_id ? Number(req.query.donor_id) : NaN;
    let registeredDonor = null;
    if (Number.isInteger(registeredDonorId)) {
      const { rows } = await pool.query('SELECT * FROM donors WHERE id = $1', [registeredDonorId]);
      registeredDonor = rows[0] || null;
    }
    res.render('admin/donations', { registeredDonor, error: null });
  })
);

router.post(
  '/donations',
  asyncHandler(async (req, res) => {
    const normalizedPhone = (req.body.phone_number || '').replace(/\D/g, '');

    if (normalizedPhone.length < 7) {
      return res.render('admin/donations', {
        registeredDonor: null,
        error: 'Enter a valid phone number.'
      });
    }

    // Keyed on phone_number so a repeat donor reuses their existing donor id instead of
    // getting a second one — this UPDATE is a no-op, just here so RETURNING still fires
    // on a conflict.
    const { rows } = await pool.query(
      `INSERT INTO donors (phone_number) VALUES ($1)
       ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
       RETURNING id`,
      [normalizedPhone]
    );

    res.redirect(`/admin/donations?donor_id=${rows[0].id}`);
  })
);

module.exports = router;
