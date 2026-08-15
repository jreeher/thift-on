const express = require('express');
const pool = require('../db/pool');
const { getClient } = require('../lib/stripe');
const { transitionItem } = require('../db/transitions');
const { redeemCredit } = require('../lib/store-credit');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Stripe webhooks are the source of truth for payment, never the browser redirect
// (Section 2) — this is the ONLY place an item is ever transitioned to sold_pending_pull.
// Must be mounted with express.raw (not express.json) or signature verification fails,
// since Stripe signs the exact raw request body.
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;
    try {
      event = getClient().webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== 'checkout.session.completed') {
      return res.status(200).send('ignored');
    }

    const session = event.data.object;
    const orderId = Number(session.metadata && session.metadata.order_id);
    const itemIds = session.metadata && session.metadata.item_ids
      ? session.metadata.item_ids.split(',').map(Number).filter(Number.isInteger)
      : [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Idempotency: Stripe retries deliveries, and a retried or duplicate event must
      // never double-fulfill an order (Section 2). This claim lives INSIDE the same
      // transaction as the fulfillment below, so if fulfillment fails and rolls back,
      // the claim rolls back with it — a later retry from Stripe can then reprocess
      // from scratch instead of being silently swallowed as "already handled".
      const { rows: claimed } = await client.query(
        `INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.id]
      );

      if (claimed.length === 0) {
        await client.query('ROLLBACK');
        return res.status(200).send('already processed');
      }

      const { rows: orderRows } = await client.query(
        `UPDATE orders
            SET status = 'paid', paid_at = NOW(), stripe_payment_intent = $1
          WHERE id = $2 AND status = 'pending'
          RETURNING *`,
        [session.payment_intent, orderId]
      );

      if (orderRows.length === 0) {
        throw new Error(`checkout.session.completed for unknown or already-paid order ${orderId}`);
      }

      for (const itemId of itemIds) {
        // An item must never be sold twice — this conditional transition is the only
        // path from reserved to sold_pending_pull in the whole app (Section 2, 6).
        await transitionItem(client, itemId, 'reserved', 'sold_pending_pull', { order_id: orderId });
      }

      // Credit was only noted on the order at checkout time — it's actually debited now,
      // at the same moment payment is confirmed, so an abandoned checkout never wrongly
      // consumes a donor's balance.
      const order = orderRows[0];
      if (order.credit_donor_id && order.credit_applied_cents > 0) {
        await redeemCredit(client, order.credit_donor_id, order.credit_applied_cents, orderId);
      }

      await client.query('COMMIT');
      return res.status(200).send('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Webhook processing failed:', err.message);
      // 500 tells Stripe to retry — safe, since the idempotency claim above rolled back too.
      return res.status(500).send('Webhook handler error');
    } finally {
      client.release();
    }
  })
);

module.exports = router;
