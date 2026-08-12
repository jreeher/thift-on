# Web-based intake flow — design

## Context

The build doc (Section 12) specifies intake happening through a JSON API (`POST /api/items`) consumed by an Android app. That app is not being built. The admin side (`views/admin/review.ejs`) only reviews/approves drafts that already exist — there is currently no way to create an item (upload a photo, get an AI draft) through a browser at all. This adds that missing path as a web form under `/admin`, replacing the Android app's role.

## Goals

- Staff can upload an item photo through the browser and get an AI-drafted item, without needing the Android app or a raw API client.
- Minimize repetitive data entry during a batch of intake (many items typically get boxed into the same physical bin in one sitting).
- Reuse existing logic (`analyzeItemPhoto`, `uploadPhoto`, the `draft` item insert, the existing approve route) rather than duplicating it.

## Non-goals

- No changes to the Android-style JSON API (`routes/api.js`) — it stays as-is, just unused for now.
- No new tests. Nothing here touches the atomicity-sensitive paths (cart reservation, Stripe webhook, cron jobs) the build doc requires tests for. This matches how `/admin/review` and the Phase 8 bin-consolidation work were also shipped without tests.
- No bulk/multi-file upload in one request — one photo per upload, same as the existing `analyzeItemPhoto(imageBuffer, mimeType)` signature and the `items` table's single `photo_key`/`photo_url` columns.

## Flow: bin-scoped intake session

Instead of picking a bin on every photo, staff "open" a bin once, upload photos against it freely, then explicitly "close" it before switching to a different bin.

**State**: two signed cookies (same signing mechanism `middleware/auth.js` already uses via `cookie-parser` + `SESSION_SECRET`):
- `intake_bin` — the bin number currently open. Unset = no bin open. Expires after 12 hours.
- `last_intake_bin` — the most recently opened bin number, kept only to pre-fill the "open a bin" field next time. Survives closing. Expires after 30 days.

**Routes** (new, in `routes/admin.js`, behind existing `requireStaffAuth`):

| Route | Behavior |
|---|---|
| `GET /admin/intake` | If `intake_bin` is unset: render an "open a bin" form, one free-text bin-number field pre-filled from `last_intake_bin`. If set: render the photo upload form (file input only, no bin field), header shows "Working in Bin #N", plus a "Close Bin" button. |
| `POST /admin/intake/open` | Validates the submitted bin number exists in `bins` (same existence check `POST /api/items` already does — no status filter). On success, sets both cookies, redirects to `/admin/intake`. On failure, re-renders the open-bin form with an error, matching the existing error style in `POST /admin/bins`. |
| `POST /admin/intake/close` | Clears `intake_bin` only. Redirects to `/admin/intake`. |
| `POST /admin/intake` | Upload handler. Requires `intake_bin` to be set (defensive redirect to `/admin/intake` if not — shouldn't be reachable via the UI). Re-validates the bin still exists (guards against it being retired mid-session). Otherwise identical to `POST /api/items`: upload photo to R2 via `uploadPhoto`, call `analyzeItemPhoto`, insert the item as `draft` with `bin_number` from the cookie. Redirects to `/admin/intake/:id`. |
| `GET /admin/intake/:id` | Single-item review card — the AI draft, editable, with "Approve & Publish" (submits to the existing `POST /admin/review/:id/approve` — no new approve logic) and "Next Photo →" (plain link back to `/admin/intake`, which shows the upload form immediately since the bin is still open). |

**View reuse**: extract the per-item editable card markup currently inline in `views/admin/review.ejs` into `views/partials/item-review-card.ejs`, used by both the review queue (looped) and the new single-item intake-review page.

**Nav**: add an "Intake" link to the existing `admin-nav` partial alongside "Review Queue" / "Bins".

## Error handling

- Bin doesn't exist (open step or defensive re-check at upload): re-render with an inline error, same style as `POST /admin/bins`'s existing error handling. No new error-handling pattern introduced.
- Everything else wrapped in the existing `asyncHandler`, same as the rest of `routes/admin.js`.

## Out of scope / explicitly deferred

- Consignment intake and email notifications remain deferred per the build doc's Phase 8 breakdown — unrelated to this change.
