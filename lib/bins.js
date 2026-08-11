// No consolidation algorithm was specified in the build doc — this is a starting
// heuristic: an active bin holding items but sitting below 25% of its capacity is a
// reasonable candidate to suggest consolidating into another bin. Tune this constant
// as real occupancy patterns emerge; nothing else in the app depends on its exact value.
const CONSOLIDATION_THRESHOLD_RATIO = 0.25;

function isConsolidationCandidate(bin) {
  if (bin.status !== 'active') return false;

  const occupied = Number(bin.occupied_count) || 0;
  const capacity = Number(bin.capacity) || 0;

  if (occupied === 0 || capacity === 0) return false; // nothing to consolidate FROM

  return occupied / capacity < CONSOLIDATION_THRESHOLD_RATIO;
}

module.exports = { CONSOLIDATION_THRESHOLD_RATIO, isConsolidationCandidate };
