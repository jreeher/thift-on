const pool = require('../db/pool');

const RESULT_LIMIT = 500;

const ITEM_STATUSES = [
  'draft',
  'active',
  'reserved',
  'sold_pending_pull',
  'pulled',
  'picked_up',
  'expired',
  'removed'
];

const ORDER_STATUSES = ['pending', 'paid', 'ready_for_pickup', 'completed', 'cancelled'];

const BIN_STATUSES = ['active', 'needs_consolidation', 'retired'];

// Orders that actually resulted in a sale — used to scope "value sold" so a pending or
// cancelled order never gets counted as revenue.
const SOLD_ORDER_STATUSES = ['paid', 'ready_for_pickup', 'completed'];

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A date-range "end date" filter is meant to be inclusive of the whole day, so the
// actual SQL bound is the start of the *next* day, compared with strictly-less-than —
// simpler and less error-prone than end-of-day string math.
function toExclusiveUpperBound(value) {
  const date = toDateOrNull(value);
  if (!date) return null;
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
}

async function getItemsReport(filters) {
  const { status, category, binNumber, donorId, startDate, endDate } = filters;
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.category, i.status, i.bin_number, i.donor_id, d.phone_number AS donor_phone,
            i.price_original_cents, i.price_current_cents, i.created_at, i.listed_at
       FROM items i
       LEFT JOIN donors d ON d.id = i.donor_id
      WHERE ($1::text IS NULL OR i.status = $1)
        AND ($2::text IS NULL OR i.category = $2)
        AND ($3::integer IS NULL OR i.bin_number = $3)
        AND ($4::integer IS NULL OR i.donor_id = $4)
        AND ($5::timestamptz IS NULL OR i.created_at >= $5)
        AND ($6::timestamptz IS NULL OR i.created_at < $6)
      ORDER BY i.created_at DESC
      LIMIT $7`,
    [status || null, category || null, binNumber ?? null, donorId ?? null, toDateOrNull(startDate), toExclusiveUpperBound(endDate), RESULT_LIMIT]
  );
  return rows;
}

async function getOrdersReport(filters) {
  const { status, startDate, endDate } = filters;
  const { rows } = await pool.query(
    `SELECT o.id, o.order_number, o.customer_email, o.status, o.subtotal_cents,
            o.created_at, o.paid_at, o.completed_at
       FROM orders o
      WHERE ($1::text IS NULL OR o.status = $1)
        AND ($2::timestamptz IS NULL OR o.paid_at >= $2)
        AND ($3::timestamptz IS NULL OR o.paid_at < $3)
      ORDER BY o.created_at DESC
      LIMIT $4`,
    [status || null, toDateOrNull(startDate), toExclusiveUpperBound(endDate), RESULT_LIMIT]
  );
  return rows;
}

// items_donated_count is all-time (how much has this donor given, period); items_sold_count
// and total_value_sold_cents are scoped to the date range (what sold in this window) — the
// two questions are deliberately different, both useful side by side.
async function getDonorsReport(filters) {
  const { donorId, startDate, endDate } = filters;
  const start = toDateOrNull(startDate);
  const end = toExclusiveUpperBound(endDate);

  const { rows } = await pool.query(
    `SELECT d.id, d.phone_number, d.created_at,
            COUNT(DISTINCT i.id) AS items_donated_count,
            COUNT(DISTINCT i.id) FILTER (
              WHERE o.status = ANY($1)
                AND ($2::timestamptz IS NULL OR o.paid_at >= $2)
                AND ($3::timestamptz IS NULL OR o.paid_at < $3)
            ) AS items_sold_count,
            COALESCE(SUM(i.price_current_cents) FILTER (
              WHERE o.status = ANY($1)
                AND ($2::timestamptz IS NULL OR o.paid_at >= $2)
                AND ($3::timestamptz IS NULL OR o.paid_at < $3)
            ), 0) AS total_value_sold_cents
       FROM donors d
       LEFT JOIN items i ON i.donor_id = d.id
       LEFT JOIN orders o ON o.id = i.order_id
      WHERE ($4::integer IS NULL OR d.id = $4)
      GROUP BY d.id
      ORDER BY total_value_sold_cents DESC
      LIMIT $5`,
    [SOLD_ORDER_STATUSES, start, end, donorId ?? null, RESULT_LIMIT]
  );
  return rows;
}

async function getBinsReport(filters) {
  const { status } = filters;
  const { rows } = await pool.query(
    `SELECT b.id, b.bin_number, b.status, b.peak_item_count, b.last_consolidated_at, b.created_at,
            COUNT(i.id) FILTER (WHERE i.status NOT IN ('picked_up', 'expired', 'removed')) AS occupied_count
       FROM bins b
       LEFT JOIN items i ON i.bin_number = b.bin_number
      WHERE ($1::text IS NULL OR b.status = $1)
      GROUP BY b.id
      ORDER BY b.bin_number ASC`,
    [status || null]
  );
  return rows;
}

module.exports = {
  RESULT_LIMIT,
  ITEM_STATUSES,
  ORDER_STATUSES,
  BIN_STATUSES,
  getItemsReport,
  getOrdersReport,
  getDonorsReport,
  getBinsReport
};
