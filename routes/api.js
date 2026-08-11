const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { uploadPhoto } = require('../lib/storage');
const { analyzeItemPhoto } = require('../lib/ai');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Static bearer token for the Android intake app (Section 12) — separate from the
// signed-cookie session used by /admin and /staff.
function requireApiToken(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.use(requireApiToken);

router.post(
  '/items',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'photo file is required (multipart field "photo")' });
    }

    const binNumber = req.body.bin_number ? Number(req.body.bin_number) : NaN;
    if (!Number.isInteger(binNumber)) {
      return res.status(400).json({ error: 'bin_number is required and must be an integer' });
    }

    const { rows: binRows } = await pool.query('SELECT bin_number FROM bins WHERE bin_number = $1', [binNumber]);
    if (binRows.length === 0) {
      return res.status(400).json({ error: `bin ${binNumber} does not exist` });
    }

    const { key, url } = await uploadPhoto(req.file.buffer, req.file.mimetype);

    // AI output is a draft, never published automatically (Section 2) — status is
    // always 'draft' here regardless of how confident the model was.
    const { fields, raw } = await analyzeItemPhoto(req.file.buffer, req.file.mimetype);

    const { rows } = await pool.query(
      `INSERT INTO items (
         bin_number, photo_key, photo_url, title, category, description, condition_notes,
         ai_raw_response, ai_confidence, price_original_cents, price_current_cents, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'draft')
       RETURNING *`,
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

    res.status(201).json(rows[0]);
  })
);

module.exports = router;
