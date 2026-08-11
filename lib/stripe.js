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
async function createCheckoutSession({ orderId, items, customerEmail }) {
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

  return getClient().checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    customer_email: customerEmail,
    success_url: `${process.env.BASE_URL}/order/success?order=${orderId}`,
    cancel_url: `${process.env.BASE_URL}/order/cancelled?order=${orderId}`,
    // The order id lets the webhook find the order; item_ids lets it know exactly which
    // items to transition to sold_pending_pull once payment is confirmed (Section 9).
    metadata: {
      order_id: String(orderId),
      item_ids: items.map((item) => item.id).join(',')
    }
  });
}

module.exports = { getClient, createCheckoutSession };
