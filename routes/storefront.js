const express = require('express');
const pool = require('../db/pool');
const { ALLOWED_CATEGORIES, nextMarkdown } = require('../lib/pricing');
const { ensureCartToken } = require('../middleware/cart');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.use(ensureCartToken);
router.use(express.urlencoded({ extended: false }));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const category = ALLOWED_CATEGORIES.includes(req.query.category) ? req.query.category : null;

    const { rows: items } = await pool.query(
      category
        ? `SELECT * FROM items WHERE status = 'active' AND category = $1 ORDER BY listed_at DESC`
        : `SELECT * FROM items WHERE status = 'active' ORDER BY listed_at DESC`,
      category ? [category] : []
    );

    res.render('storefront/index', { items, categories: ALLOWED_CATEGORIES, selectedCategory: category });
  })
);

router.get(
  '/item/:id',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) {
      return res.status(404).render('storefront/not-found', {
        message: "That item isn't available — it may have sold or been removed."
      });
    }

    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1 AND status = 'active'`, [itemId]);

    if (rows.length === 0) {
      const message =
        req.query.unavailable === '1'
          ? 'Sorry, someone just grabbed this one.'
          : "That item isn't available — it may have sold or been removed.";
      return res.status(404).render('storefront/not-found', { message });
    }

    const item = rows[0];
    const markdown = nextMarkdown(item.price_original_cents, item.listed_at);

    res.render('storefront/item', { item, markdown });
  })
);

router.get(
  '/cart',
  asyncHandler(async (req, res) => {
    const { rows: items } = await pool.query(
      `SELECT * FROM items WHERE reserved_by_cart = $1 AND status = 'reserved' ORDER BY created_at ASC`,
      [req.cartToken]
    );

    const subtotalCents = items.reduce((sum, item) => sum + (item.price_current_cents || 0), 0);

    res.render('storefront/cart', { items, subtotalCents });
  })
);

router.post(
  '/cart/add/:id',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) {
      return res.redirect('/');
    }

    // Adding to cart immediately reserves the item via an atomic conditional UPDATE —
    // two shoppers can never both reserve the same one-of-a-kind item (Section 2, 9).
    const { rows } = await pool.query(
      `UPDATE items
          SET status = 'reserved',
              reserved_by_cart = $1,
              reserved_until = NOW() + INTERVAL '20 minutes',
              updated_at = NOW()
        WHERE id = $2 AND status = 'active'
        RETURNING id`,
      [req.cartToken, itemId]
    );

    if (rows.length > 0) {
      return res.redirect('/cart');
    }

    // Zero rows can mean someone else grabbed it first, or this cart already holds it
    // (e.g. a double form submit) — only the first case should read as "sold out".
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM items WHERE id = $1 AND status = 'reserved' AND reserved_by_cart = $2`,
      [itemId, req.cartToken]
    );

    if (existing.length > 0) {
      return res.redirect('/cart');
    }

    res.redirect(`/item/${itemId}?unavailable=1`);
  })
);

router.post(
  '/cart/remove/:id',
  asyncHandler(async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) {
      return res.redirect('/cart');
    }

    // Scoped to this cart's own token, not just item id + status, so one shopper can't
    // release a reservation that belongs to someone else's cart.
    await pool.query(
      `UPDATE items
          SET status = 'active',
              reserved_by_cart = NULL,
              reserved_until = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = 'reserved' AND reserved_by_cart = $2`,
      [itemId, req.cartToken]
    );

    res.redirect('/cart');
  })
);

module.exports = router;
