// Display labels for items.status, shown to staff across Inventory, bin contents, Reports,
// and donor history. Purely cosmetic — the underlying database values (Section 6's state
// machine, every WHERE clause in the app) are completely untouched. Kept in one place so
// every view that shows a status stays consistent with the others.
//
// "Sold" and "Reserved" here don't map onto the DB values you'd guess from the name: since
// checkout moved to authorize-then-capture, the item that's actually been charged and
// handed over is picked_up, not sold_pending_pull — sold_pending_pull is just "committed to
// this order, not yet pulled." The labels reflect that: an item only reads as "Sold" once
// it's truly been paid for and picked up.
const ITEM_STATUS_LABELS = {
  draft: 'Draft',
  active: 'Active',
  reserved: 'In Cart',
  sold_pending_pull: 'Reserved',
  pulled: 'Pulled',
  picked_up: 'Sold',
  expired: 'Expired',
  removed: 'Removed'
};

function labelForItemStatus(status) {
  return ITEM_STATUS_LABELS[status] || status;
}

module.exports = { ITEM_STATUS_LABELS, labelForItemStatus };
