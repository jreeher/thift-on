// No consolidation algorithm was specified in the build doc — this is a starting
// heuristic: an active bin holding items but sitting below 25% of its peak-ever fill
// level is a reasonable candidate to suggest consolidating into another bin. The
// baseline is peak_item_count (see ratchetBinPeak below), not a manually-typed capacity
// — there's no predetermined size for a bin. Tune this constant as real occupancy
// patterns emerge; nothing else in the app depends on its exact value.
const CONSOLIDATION_THRESHOLD_RATIO = 0.25;

function isConsolidationCandidate(bin) {
  if (bin.status !== 'active') return false;

  const occupied = Number(bin.occupied_count) || 0;
  const peak = Number(bin.peak_item_count) || 0;

  if (occupied === 0 || peak === 0) return false; // nothing to consolidate FROM

  return occupied / peak < CONSOLIDATION_THRESHOLD_RATIO;
}

// Bumps a bin's high-water mark up to its current occupancy, if that's higher than
// what's recorded — never down. Relying on a single explicit moment (staff tapping
// "Close Bin") to snapshot this was fragile: nothing stops someone from just navigating
// away instead, and the peak would then silently stay 0 forever. Calling this every time
// an item is actually assigned into a bin (intake, approval, the API) means the peak
// stays correct regardless of whether that button ever gets tapped. `db` can be the pool
// or a transaction client — callers that already hold a transaction pass their client so
// this stays atomic with the write that triggered it.
async function ratchetBinPeak(db, binNumber) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS occupied_count
       FROM items
      WHERE bin_number = $1 AND status NOT IN ('picked_up', 'expired', 'removed')`,
    [binNumber]
  );
  await db.query('UPDATE bins SET peak_item_count = GREATEST(peak_item_count, $1) WHERE bin_number = $2', [
    rows[0].occupied_count,
    binNumber
  ]);
}

module.exports = { CONSOLIDATION_THRESHOLD_RATIO, isConsolidationCandidate, ratchetBinPeak };
