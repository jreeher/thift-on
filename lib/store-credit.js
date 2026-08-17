const { transitionItem } = require('../db/transitions');

// The donor's cut of the sale price. A plain constant, same spirit as
// lib/bins.js's CONSOLIDATION_THRESHOLD_RATIO — easy to tune later, nothing else
// depends on its exact value.
const CONSIGNMENT_PAYOUT_RATE = 0.5;

async function getBalanceCents(client, donorId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS balance_cents FROM store_credit_ledger WHERE donor_id = $1`,
    [donorId]
  );
  return rows[0].balance_cents;
}

// Called from the pickup flow for each item on an order (lib/fulfillment.js's
// markOrderPickedUp). A no-op for items with no donor_id — pre-donor-tracking
// inventory, or a donation where no phone was ever captured, has no one to pay.
async function issuePayout(client, item) {
  if (!item.donor_id) return;

  // price_current_cents is nullable on items in general, but an item can only reach
  // 'pulled' (a precondition for pickup, and so for reaching this function) by having
  // passed through 'active', which always has a price. Guarded explicitly anyway, since
  // a silent NaN write into a NOT NULL money column would otherwise surface as an opaque
  // constraint error deep inside the pickup transaction instead of a clear one here.
  if (!Number.isFinite(item.price_current_cents)) {
    throw new Error(`issuePayout: item ${item.id} has no price_current_cents to base a payout on`);
  }

  const amountCents = Math.round(item.price_current_cents * CONSIGNMENT_PAYOUT_RATE);

  await client.query(
    `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason, item_id) VALUES ($1, $2, 'consignment_payout', $3)`,
    [item.donor_id, amountCents, item.id]
  );
}

// Records a debit. The caller must have already clamped amountCents to the donor's
// actual balance — this function just writes the row, it doesn't re-check anything.
async function redeemCredit(client, donorId, amountCents, orderId) {
  await client.query(
    `INSERT INTO store_credit_ledger (donor_id, amount_cents, reason, order_id) VALUES ($1, $2, 'redeemed_at_checkout', $3)`,
    [donorId, -amountCents, orderId]
  );
}

// The "credit covers the whole order" checkout path — there's nothing for Stripe to
// charge, so this completes the order directly in one transaction instead of ever
// creating a checkout session: mark the order paid, transition every item to
// sold_pending_pull (mirroring what the Stripe webhook does for a normal payment), and
// debit the ledger. Pulled into its own function (rather than living inline in the
// route) so it can be tested directly against a real transaction without going through
// HTTP.
async function completeOrderFullyWithCredit(
  client,
  { orderId, orderNumber, customerName, customerPhone, subtotalCents, items, donorId, creditCents, pickupDate }
) {
  await client.query(
    `INSERT INTO orders (id, order_number, customer_name, customer_phone, subtotal_cents, status, paid_at, credit_donor_id, credit_applied_cents, pickup_date)
     VALUES ($1, $2, $3, $4, $5, 'paid', NOW(), $6, $7, $8)`,
    [orderId, orderNumber, customerName, customerPhone, subtotalCents, donorId, creditCents, pickupDate]
  );

  for (const item of items) {
    // An item must never be sold twice — same conditional transition the webhook uses
    // for a real payment (Section 2, 6).
    await transitionItem(client, item.id, 'reserved', 'sold_pending_pull', { order_id: orderId });
  }

  await redeemCredit(client, donorId, creditCents, orderId);
}

module.exports = {
  CONSIGNMENT_PAYOUT_RATE,
  getBalanceCents,
  issuePayout,
  redeemCredit,
  completeOrderFullyWithCredit
};
