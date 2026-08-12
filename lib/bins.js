// No consolidation algorithm was specified in the build doc — this is a starting
// heuristic: an active bin holding items but sitting below 25% of its peak-ever fill
// level is a reasonable candidate to suggest consolidating into another bin. The
// baseline is peak_item_count (routes/admin.js's POST /intake/close snapshots it),
// not a manually-typed capacity — there's no predetermined size for a bin. Tune this
// constant as real occupancy patterns emerge; nothing else in the app depends on its
// exact value.
const CONSOLIDATION_THRESHOLD_RATIO = 0.25;

function isConsolidationCandidate(bin) {
  if (bin.status !== 'active') return false;

  const occupied = Number(bin.occupied_count) || 0;
  const peak = Number(bin.peak_item_count) || 0;

  if (occupied === 0 || peak === 0) return false; // nothing to consolidate FROM

  return occupied / peak < CONSOLIDATION_THRESHOLD_RATIO;
}

module.exports = { CONSOLIDATION_THRESHOLD_RATIO, isConsolidationCandidate };
