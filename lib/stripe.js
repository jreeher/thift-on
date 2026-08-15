const Stripe = require('stripe');

let stripeClient = null;

function getClient() {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// price_data is always built from the item's current price_current_cents in our DB,
// never trusted from the browser (Section 9) — the client can't influence what gets charged.
async function createCheckoutSession({ orderId, items, creditCentsToApply = 0 }) {
  const lineItems = items.map((item) => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.title || `Item #${item.id}` },
      unit_amount: item.price_current_cents
    },
    // Always 1 — every item is one-of-a-kind. This is Stripe's required line-item field,
    // not the restockable-SKU "quantity" concept that's banned from this app (Section 2).
    quantity: 1
  }));

  const sessionParams = {
    mode: 'payment',
    line_items: lineItems,
    // No customer_email to prefill — checkout collects a name/phone instead, not email.
    // Stripe's own hosted page still asks for an email itself (that's Stripe's own
    // receipt requirement for `mode: 'payment'`, not something this param controls); the
    // customer just enters it there instead of on our page.
    success_url: `${process.env.BASE_URL}/order/success?order=${orderId}`,
    cancel_url: `${process.env.BASE_URL}/order/cancelled?order=${orderId}`,
    // The order id lets the webhook find the order; item_ids lets it know exactly which
    // items to transition to sold_pending_pull once payment is confirmed (Section 9).
    metadata: {
      order_id: String(orderId),
      item_ids: items.map((item) => item.id).join(',')
    }
  };

  if (creditCentsToApply > 0) {
    // A one-time dynamic discount for exactly the credit being applied — simpler than
    // trying to shrink individual line-item prices to add up to the right remainder.
    const coupon = await getClient().coupons.create({
      amount_off: creditCentsToApply,
      currency: 'usd',
      duration: 'once',
      name: `Store credit applied to order ${orderId}`
    });
    sessionParams.discounts = [{ coupon: coupon.id }];
  }

  return getClient().checkout.sessions.create(sessionParams);
}

module.exports = { getClient, createCheckoutSession };
