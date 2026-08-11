const pool = require('../db/pool');
const { transitionItem, TransitionConflictError } = require('../db/transitions');

// Shared by the staff web UI (routes/staff.js) and the Android app's JSON API
// (routes/api.js) — Section 12 explicitly calls for GET /api/fulfillment to return
// "the same data as the staff page", so both read through this one query.
async function getFulfillmentQueue() {
  const { rows } = await pool.query(`
    SELECT o.id AS order_id, o.order_number, o.customer_email, o.customer_name, o.status AS order_status,
           i.id AS item_id, i.title, i.photo_url, i.bin_number, i.status AS item_status
      FROM orders o
      JOIN items i ON i.order_id = o.id
     WHERE o.status IN ('paid', 'ready_for_pickup')
       AND i.status IN ('sold_pending_pull', 'pulled')
     ORDER BY o.created_at ASC, i.id ASC
  `);

  const ordersById = new Map();

  for (const row of rows) {
    if (!ordersById.has(row.order_id)) {
      ordersById.set(row.order_id, {
        orderId: row.order_id,
        orderNumber: row.order_number,
        customerEmail: row.customer_email,
        customerName: row.customer_name,
        orderStatus: row.order_status,
        items: []
      });
    }

    ordersById.get(row.order_id).items.push({
      id: row.item_id,
      title: row.title,
      photoUrl: row.photo_url,
      binNumber: row.bin_number,
      status: row.item_status
    });
  }

  return Array.from(ordersById.values());
}

// Staff taps "Pulled" for one item at a time — physical pulls are confirmed by a human,
// never inferred (Section 2). Once every item on the order has been pulled, the order's
// own status is updated to reflect that known fact, which is what puts the "Mark Picked
// Up" button in front of staff.
async function markItemPulled(itemId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await transitionItem(client, itemId, 'sold_pending_pull', 'pulled', {});

    const { rows: remaining } = await client.query(
      `SELECT 1 FROM items WHERE order_id = $1 AND status = 'sold_pending_pull'`,
      [item.order_id]
    );

    if (remaining.length === 0) {
      await client.query(`UPDATE orders SET status = 'ready_for_pickup' WHERE id = $1 AND status = 'paid'`, [
        item.order_id
      ]);
    }

    await client.query('COMMIT');
    return item;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Staff taps "Mark Picked Up" once for the whole order after every item has been pulled —
// a single atomic action matching how a real pickup happens, not a per-item toggle.
async function markOrderPickedUp(orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The conditional UPDATE is the atomic guard: a double-tap or a stale page can only
    // ever complete the order once.
    const { rows: orderRows } = await client.query(
      `UPDATE orders
          SET status = 'completed', completed_at = NOW()
        WHERE id = $1 AND status = 'ready_for_pickup'
        RETURNING *`,
      [orderId]
    );

    if (orderRows.length === 0) {
      throw new TransitionConflictError(
        `Order ${orderId} was not in status 'ready_for_pickup' (already completed, or not ready)`
      );
    }

    const { rows: items } = await client.query(`SELECT id FROM items WHERE order_id = $1 AND status = 'pulled'`, [
      orderId
    ]);

    for (const { id } of items) {
      await transitionItem(client, id, 'pulled', 'picked_up', {});
    }

    await client.query('COMMIT');
    return orderRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getFulfillmentQueue, markItemPulled, markOrderPickedUp };
