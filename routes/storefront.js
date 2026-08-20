const express = require('express');
const pool = require('../db/pool');
const { ALLOWED_CATEGORIES } = require('../lib/pricing');
const { ensureCartToken } = require('../middleware/cart');
const { createCheckoutSession } = require('../lib/stripe');
const { getBalanceCents, completeOrderFullyWithCredit } = require('../lib/store-credit');
const {
  isSlotOpen,
  getAvailablePickupSlots,
  formatSlotTime,
  pickupDateBounds,
  pickupDateRange
} = require('../lib/pickup-schedule');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// The store credit lookup reveals whether a phone number belongs to a registered donor
// and their exact balance — worth a light rate limit so it can't be scripted into a
// phone-number enumeration tool. A single Railway instance is all this app runs on, so a
// per-process in-memory Map is enough; no shared store needed. Keyed by IP, a fixed
// window that lazily resets itself on the next request after it expires.
const CREDIT_LOOKUP_LIMIT = 3;
const CREDIT_LOOKUP_WINDOW_MS = 60 * 1000;
const creditLookupAttempts = new Map();

function isCreditLookupRateLimited(ip) {
  const now = Date.now();
  const entry = creditLookupAttempts.get(ip);

  if (!entry || now - entry.windowStart > CREDIT_LOOKUP_WINDOW_MS) {
    creditLookupAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > CREDIT_LOOKUP_LIMIT;
}

async function loadCartItems(cartToken) {
  const { rows: items } = await pool.query(
    `SELECT * FROM items WHERE reserved_by_cart = $1 AND status = 'reserved' ORDER BY created_at ASC`,
    [cartToken]
  );
  const subtotalCents = items.reduce((sum, item) => sum + (item.price_current_cents || 0), 0);
  return { items, subtotalCents };
}

// pickup_slot from the form is "YYYY-MM-DDTHH:MM" (date + slot start time combined into
// one dropdown value) — split apart here, validated together below.
function parsePickupSlot(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return match ? { date: match[1], time: match[2] } : null;
}

router.use(ensureCartToken);
router.use(express.urlencoded({ extended: false }));

// Available to every storefront view via res.locals, so the header's cart count doesn't
// need each route to remember to pass it in explicitly.
router.use(
  asyncHandler(async (req, res, next) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM items WHERE reserved_by_cart = $1 AND status = 'reserved'`,
      [req.cartToken]
    );
    res.locals.cartCount = rows[0].count;
    next();
  })
);

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

    res.render('storefront/item', { item: rows[0] });
  })
);

router.get('/about', (req, res) => {
  res.render('storefront/about');
});

router.get(
  '/cart',
  asyncHandler(async (req, res) => {
    const { items, subtotalCents } = await loadCartItems(req.cartToken);
    const bounds = pickupDateBounds();

    // A pure read — checking a balance never touches the ledger. The actual debit only
    // ever happens at payment confirmation (see the /checkout route and the webhook). The
    // same phone number doubles as the order's own contact phone at checkout below, so a
    // customer who checks their credit here never has to type it again.
    // String(...) guards against a repeated ?phone=&phone= query param, which Express
    // parses as an array — .replace would otherwise throw on that shape.
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    let donorBalanceCents = null;
    let creditLookupRateLimited = false;
    let previousName = null;
    if (phone) {
      if (isCreditLookupRateLimited(req.ip)) {
        creditLookupRateLimited = true;
      } else {
        const { rows: donorRows } = await pool.query('SELECT id FROM donors WHERE phone_number = $1', [phone]);
        if (donorRows.length > 0) {
          donorBalanceCents = await getBalanceCents(pool, donorRows[0].id);
        }

        // Best-effort convenience, not an account system — just reuses whatever name was
        // typed on this phone's most recent order so a repeat customer doesn't retype it.
        const { rows: nameRows } = await pool.query(
          `SELECT customer_name FROM orders
             WHERE customer_phone = $1 AND customer_name IS NOT NULL AND customer_name <> ''
             ORDER BY created_at DESC LIMIT 1`,
          [phone]
        );
        if (nameRows.length > 0) {
          previousName = nameRows[0].customer_name;
        }
      }
    }

    const availablePickupSlots = await getAvailablePickupSlots(pool, pickupDateRange(bounds));

    res.render('storefront/cart', {
      items,
      subtotalCents,
      error: null,
      phone: phone || null,
      customerName: null,
      previousName,
      donorBalanceCents,
      creditLookupRateLimited,
      availablePickupSlots
    });
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

    // Back to browsing rather than straight to the cart — the header's cart count is
    // what confirms the add, so there's no need to interrupt shopping to see it.
    if (rows.length > 0) {
      return res.redirect('/');
    }

    // Zero rows can mean someone else grabbed it first, or this cart already holds it
    // (e.g. a double form submit) — only the first case should read as "sold out".
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM items WHERE id = $1 AND status = 'reserved' AND reserved_by_cart = $2`,
      [itemId, req.cartToken]
    );

    if (existing.length > 0) {
      return res.redirect('/');
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

router.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const customerName = (req.body.name || '').trim();
    // The same phone doubles as the store-credit lookup key below and the order's own
    // contact phone — the customer only ever types it once, whether or not they end up
    // applying credit.
    const customerPhone = String(req.body.phone || '').replace(/\D/g, '');
    const bounds = pickupDateBounds();
    const slot = parsePickupSlot(req.body.pickup_slot);

    async function renderCartError(message, { rateLimited = false } = {}) {
      const { items, subtotalCents } = await loadCartItems(req.cartToken);
      const availablePickupSlots = await getAvailablePickupSlots(pool, pickupDateRange(bounds));
      return res.render('storefront/cart', {
        items,
        subtotalCents,
        error: message,
        phone: customerPhone || null,
        customerName: customerName || null,
        previousName: null,
        donorBalanceCents: null,
        // Otherwise the cart page's own "No store credit available" banner would render
        // alongside this error, misleadingly implying the customer has no credit at all
        // rather than that the check was simply blocked by the rate limit.
        creditLookupRateLimited: rateLimited,
        availablePickupSlots
      });
    }

    if (!customerName || customerPhone.length < 7 || !slot) {
      return renderCartError('Enter your name, a valid phone number, and a pickup time to check out.');
    }

    // Re-derived from scratch, never trusted from the hidden form field — the same
    // principle as price_current_cents never coming from the browser (Section 9).
    const slotStillOpen = await isSlotOpen(pool, slot.date, slot.time);
    if (!slotStillOpen) {
      return renderCartError('That pickup time is no longer available — please choose another.');
    }

    const { items, subtotalCents } = await loadCartItems(req.cartToken);
    if (items.length === 0) {
      return res.redirect('/cart');
    }

    // A slow checkout (entering card details, etc.) shouldn't lose the reservation out
    // from under the customer — refresh the clock right as they start (Section 9).
    await pool.query(
      `UPDATE items
          SET reserved_until = NOW() + INTERVAL '30 minutes', updated_at = NOW()
        WHERE reserved_by_cart = $1 AND status = 'reserved'`,
      [req.cartToken]
    );

    // Store credit, only if the customer explicitly opted in via the checkbox shown after
    // checking their balance on the cart page — always the full amount available, up to
    // the subtotal, since the ask is yes/no, not "how much." Re-derived from scratch here
    // — nothing from the form is trusted past this point. Gated by the same rate limiter
    // as the read-only balance check on /cart — this path doesn't just leak a balance, it
    // can actually spend it, so it needs at least the same protection against being
    // scripted to guess phone numbers.
    let donorId = null;
    let creditCentsToApply = 0;
    const wantsCredit = req.body.apply_credit === 'yes';

    if (wantsCredit) {
      if (isCreditLookupRateLimited(req.ip)) {
        // The customer explicitly asked to apply credit they already saw confirmed on the
        // cart page — silently charging full price instead would be a surprise. Surface it
        // the same way the cart page itself does, rather than falling through unannounced.
        return renderCartError('Too many attempts — please wait a moment and try checkout again.', {
          rateLimited: true
        });
      }

      const { rows: donorRows } = await pool.query('SELECT id FROM donors WHERE phone_number = $1', [
        customerPhone
      ]);
      if (donorRows.length > 0) {
        donorId = donorRows[0].id;
        const balanceCents = await getBalanceCents(pool, donorId);
        creditCentsToApply = Math.min(balanceCents, subtotalCents);
      }
    }

    const { rows: idRows } = await pool.query(`SELECT nextval('orders_id_seq') AS id`);
    const orderId = Number(idRows[0].id);
    const orderNumber = `TS-${orderId}`;

    if (creditCentsToApply > 0 && creditCentsToApply >= subtotalCents) {
      // Credit covers the whole order — nothing for Stripe to charge, so this completes
      // the order directly instead of ever creating a checkout session.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await completeOrderFullyWithCredit(client, {
          orderId,
          orderNumber,
          customerName,
          customerPhone,
          subtotalCents,
          items,
          donorId,
          creditCents: creditCentsToApply,
          pickupDate: slot.date,
          pickupTime: slot.time
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return res.redirect(`/order/success?order=${orderId}`);
    }

    // Stripe session is created before the order row exists, per Section 9 — its id is
    // embedded in the session metadata so the webhook (the source of truth for payment,
    // never this browser redirect) can find the order later. The ledger isn't debited
    // yet — only at payment confirmation (see routes/webhooks.js) — so an abandoned
    // checkout never wrongly consumes a donor's credit.
    const session = await createCheckoutSession({
      orderId,
      items,
      creditCentsToApply
    });

    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, customer_phone, subtotal_cents, stripe_session_id, status, credit_donor_id, credit_applied_cents, pickup_date, pickup_time)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)`,
      [
        orderId,
        orderNumber,
        customerName,
        customerPhone,
        subtotalCents,
        session.id,
        donorId,
        creditCentsToApply,
        slot.date,
        slot.time
      ]
    );

    res.redirect(303, session.url);
  })
);

router.get(
  '/order/success',
  asyncHandler(async (req, res) => {
    const orderId = Number(req.query.order);
    if (!Number.isInteger(orderId)) {
      return res.redirect('/');
    }

    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderRows.length === 0) {
      return res.redirect('/');
    }

    // The webhook (not this redirect) is what actually confirms payment, so it may not
    // have landed yet — items/order status here can still legitimately read as pending
    // (Section 2). The view is written to be honest about that.
    const { rows: items } = await pool.query('SELECT * FROM items WHERE order_id = $1', [orderId]);

    const order = orderRows[0];
    res.render('storefront/order-success', {
      order,
      items,
      pickupTimeLabel: order.pickup_time ? formatSlotTime(order.pickup_time) : null
    });
  })
);

router.get('/order/cancelled', (req, res) => {
  res.render('storefront/order-cancelled');
});

module.exports = router;
