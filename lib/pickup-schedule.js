// Pickup slots default to 1-hour blocks from 4pm-8pm every day. Rather than materializing
// a row for every future slot (which would need a job to keep generating further out as
// the booking window rolls forward), only exceptions are stored: closing a default slot,
// or opening an extra one outside the default hours. Availability for any given date/time
// is always computed fresh from "default ∪ open overrides, minus closed overrides."
const DEFAULT_SLOT_START_HOURS = [16, 17, 18, 19]; // 4pm, 5pm, 6pm, 7pm — each a 1-hour block

// Checkout authorizes the card but doesn't capture until pickup is confirmed. Card
// issuers release an uncaptured authorization after about 7 days, so how far out a
// pickup time can be booked is capped a little under that — picking a day past the
// hold's expiry would guarantee the eventual capture fails. The admin Schedule page
// manages exactly this same booking window, so both routes/storefront.js and
// routes/admin.js share this one constant rather than risking two drifting apart.
const MAX_PICKUP_DAYS_AHEAD = 5;

function pickupDateBounds() {
  const toISODate = (date) => date.toISOString().slice(0, 10);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const max = new Date(today);
  max.setDate(max.getDate() + MAX_PICKUP_DAYS_AHEAD);
  return { min: toISODate(today), max: toISODate(max) };
}

function pickupDateRange(bounds) {
  const dates = [];
  const cursor = new Date(`${bounds.min}T00:00:00Z`);
  const end = new Date(`${bounds.max}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function formatHour(hour) {
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:00 ${period}`;
}

function slotLabel(startHour) {
  return `${formatHour(startHour)} – ${formatHour(startHour + 1)}`;
}

function toTimeString(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatDateLabel(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

// Every slot for one date: the 4 default hourly blocks (open unless overridden closed),
// plus any admin-added extra slots outside the default hours (open overrides only — a
// "closed" override for a non-default time is just the same as that slot never existing).
async function getSlotsForDate(db, dateStr) {
  const { rows: overrides } = await db.query(
    'SELECT start_time, is_open FROM pickup_slot_overrides WHERE slot_date = $1',
    [dateStr]
  );
  const overrideMap = new Map(overrides.map((o) => [o.start_time.slice(0, 5), o.is_open]));

  const slots = DEFAULT_SLOT_START_HOURS.map((hour) => {
    const timeStr = toTimeString(hour);
    const isOpen = overrideMap.has(timeStr) ? overrideMap.get(timeStr) : true;
    overrideMap.delete(timeStr);
    return { startTime: timeStr, label: slotLabel(hour), isOpen };
  });

  for (const [timeStr, isOpen] of overrideMap) {
    if (!isOpen) continue;
    const hour = Number(timeStr.slice(0, 2));
    slots.push({ startTime: timeStr, label: slotLabel(hour), isOpen: true });
  }

  slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return slots;
}

// Re-derives availability from scratch — used to validate a checkout submission
// server-side, the same way price/credit are never trusted from the client either.
async function isSlotOpen(db, dateStr, startTime) {
  const slots = await getSlotsForDate(db, dateStr);
  const match = slots.find((s) => s.startTime === startTime);
  return !!match && match.isOpen;
}

// One function for every admin action: closing a default slot, re-opening a closed one,
// or adding a brand new slot outside the default hours — all just an upsert of the
// desired open/closed state for that date+time.
async function setSlotOpen(db, dateStr, startTime, isOpen) {
  await db.query(
    `INSERT INTO pickup_slot_overrides (slot_date, start_time, is_open) VALUES ($1, $2, $3)
     ON CONFLICT (slot_date, start_time) DO UPDATE SET is_open = EXCLUDED.is_open`,
    [dateStr, startTime, isOpen]
  );
}

// Flat list of every open (date, slot) combination across the given date range, for the
// storefront's single pickup-slot dropdown — closed slots are simply never listed.
async function getAvailablePickupSlots(db, dateStrings) {
  const allSlots = [];
  for (const dateStr of dateStrings) {
    const slots = await getSlotsForDate(db, dateStr);
    for (const slot of slots) {
      if (!slot.isOpen) continue;
      allSlots.push({
        value: `${dateStr}T${slot.startTime}`,
        label: `${formatDateLabel(dateStr)} — ${slot.label}`
      });
    }
  }
  return allSlots;
}

// Formats a stored "HH:MM" or "HH:MM:SS" start time (e.g. from orders.pickup_time) as
// "4:00 PM" — the same style used everywhere else a slot time is shown.
function formatSlotTime(startTime) {
  return formatHour(Number(startTime.slice(0, 2)));
}

module.exports = {
  DEFAULT_SLOT_START_HOURS,
  MAX_PICKUP_DAYS_AHEAD,
  pickupDateBounds,
  pickupDateRange,
  getSlotsForDate,
  isSlotOpen,
  setSlotOpen,
  getAvailablePickupSlots,
  formatDateLabel,
  formatSlotTime
};
