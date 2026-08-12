# Web-based Intake Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff intake a donated item (photo → AI draft → review) entirely through the browser under `/admin`, using a "working bin" session so the bin number isn't re-entered on every photo.

**Architecture:** New routes in the existing `routes/admin.js` (already gated by `requireStaffAuth`), reusing `lib/storage.js`'s `uploadPhoto`, `lib/ai.js`'s `analyzeItemPhoto`, and the existing `POST /admin/review/:id/approve` transition — no new business logic beyond what `routes/api.js`'s `POST /items` already does. The open bin is tracked in a signed cookie (`intake_bin`), same mechanism `middleware/auth.js`/`server.js` already use for `staff_session`.

**Tech Stack:** Express, EJS, multer (already a dependency), signed cookies via `cookie-parser` (already configured with `SESSION_SECRET` in `server.js:21`).

No automated tests are planned for this feature (see spec `docs/superpowers/specs/2026-08-12-web-intake-design.md`, "Non-goals") — it doesn't touch the atomicity-sensitive paths (cart reservation, Stripe webhook, cron jobs) the build doc requires tests for, matching how `/admin/review` and the Phase 8 bin-consolidation routes were also shipped without tests. Verification here is manual, via the running app.

---

### Task 1: Extract the item-review-card partial, add "Intake" nav link

**Files:**
- Create: `views/partials/item-review-card.ejs`
- Modify: `views/admin/review.ejs`
- Modify: `views/admin/bins.ejs`

- [ ] **Step 1: Create the partial**

Create `views/partials/item-review-card.ejs` with exactly the card markup currently inline in `views/admin/review.ejs` (the `<section class="review-card">...</section>` block), unchanged:

```html
<section class="review-card">
  <div class="review-card-photo">
    <% if (item.photo_url) { %>
      <img src="<%= item.photo_url %>" alt="Item photo">
    <% } else { %>
      <div class="no-photo">No photo</div>
    <% } %>
    <p class="ai-confidence">AI confidence: <%= item.ai_confidence || 'n/a' %></p>
  </div>
  <form class="review-card-form" method="POST" action="/admin/review/<%= item.id %>/approve">
    <label>
      Title
      <input type="text" name="title" maxlength="60" value="<%= item.title || '' %>">
    </label>
    <label>
      Category
      <select name="category">
        <% categories.forEach((c) => { %>
          <option value="<%= c %>" <%= item.category === c ? 'selected' : '' %>><%= c %></option>
        <% }) %>
      </select>
    </label>
    <label>
      Description
      <textarea name="description" rows="3"><%= item.description || '' %></textarea>
    </label>
    <label>
      Condition notes
      <textarea name="condition_notes" rows="2"><%= item.condition_notes || '' %></textarea>
    </label>
    <label>
      Price (cents)
      <input type="number" name="price_cents" min="1" value="<%= item.price_original_cents || '' %>">
    </label>
    <label>
      Bin number
      <input type="number" name="bin_number" min="1" value="<%= item.bin_number || '' %>">
    </label>
    <button type="submit">Approve &amp; Publish</button>
  </form>
</section>
```

- [ ] **Step 2: Rewrite `views/admin/review.ejs` to use the partial and add the Intake nav link**

Replace the full contents of `views/admin/review.ejs` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Queue</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="admin-page">
    <nav class="admin-nav">
      <a href="/admin/intake">Intake</a>
      <a href="/admin/review">Review Queue</a>
      <a href="/admin/bins">Bins</a>
    </nav>
    <h1>Review Queue (<%= items.length %> draft<%= items.length === 1 ? '' : 's' %>)</h1>

    <% if (items.length === 0) { %>
      <p>No drafts waiting for review.</p>
    <% } %>

    <% items.forEach((item) => { %>
      <%- include('../partials/item-review-card', { item, categories }) %>
    <% }) %>
  </main>
</body>
</html>
```

- [ ] **Step 3: Add the Intake nav link to `views/admin/bins.ejs`**

In `views/admin/bins.ejs`, change:

```html
    <nav class="admin-nav">
      <a href="/admin/review">Review Queue</a>
      <a href="/admin/bins">Bins</a>
    </nav>
```

to:

```html
    <nav class="admin-nav">
      <a href="/admin/intake">Intake</a>
      <a href="/admin/review">Review Queue</a>
      <a href="/admin/bins">Bins</a>
    </nav>
```

- [ ] **Step 4: Verify nothing broke**

The `/admin/intake` link will 404 until Task 3, which is expected right now. Confirm the review queue still renders correctly:

```bash
npm run migrate
node server.js
```

In a browser: log in at `/login`, visit `/admin/review`. If there are existing draft items, confirm they render identically to before (same fields, same Approve & Publish button). Stop the server (Ctrl+C) when done.

- [ ] **Step 5: Commit**

```bash
git add views/partials/item-review-card.ejs views/admin/review.ejs views/admin/bins.ejs
git commit -m "Extract item-review-card partial, add Intake nav link"
```

---

### Task 2: Open/close bin routes and the "open a bin" view

**Files:**
- Modify: `routes/admin.js`
- Create: `views/admin/intake-open.ejs`

- [ ] **Step 1: Add cookie helpers and the open/close routes to `routes/admin.js`**

In `routes/admin.js`, add these two constants and the `intakeCookieOptions` helper right after the existing `asyncHandler` function definition (after line 12):

```js
const INTAKE_BIN_COOKIE = 'intake_bin';
const LAST_INTAKE_BIN_COOKIE = 'last_intake_bin';

function intakeCookieOptions(maxAgeMs) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeMs
  };
}
```

Then add these three routes. Place them right before the existing `router.get('/bins', ...)` route (before line 82 in the original file):

```js
router.get(
  '/intake',
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.render('admin/intake-open', {
        lastBin: req.signedCookies[LAST_INTAKE_BIN_COOKIE] || '',
        error: null
      });
    }
    res.render('admin/intake-upload', { binNumber: openBin, error: null });
  })
);

router.post(
  '/intake/open',
  asyncHandler(async (req, res) => {
    const binNumber = req.body.bin_number ? Number(req.body.bin_number) : NaN;
    if (!Number.isInteger(binNumber)) {
      return res.render('admin/intake-open', {
        lastBin: req.body.bin_number || '',
        error: 'Bin number must be an integer.'
      });
    }

    const { rows } = await pool.query('SELECT bin_number FROM bins WHERE bin_number = $1', [binNumber]);
    if (rows.length === 0) {
      return res.render('admin/intake-open', {
        lastBin: String(binNumber),
        error: `Bin ${binNumber} does not exist. Create it on the Bins page first.`
      });
    }

    res.cookie(INTAKE_BIN_COOKIE, String(binNumber), intakeCookieOptions(12 * 60 * 60 * 1000));
    res.cookie(LAST_INTAKE_BIN_COOKIE, String(binNumber), intakeCookieOptions(30 * 24 * 60 * 60 * 1000));
    res.redirect('/admin/intake');
  })
);

router.post('/intake/close', (req, res) => {
  res.clearCookie(INTAKE_BIN_COOKIE);
  res.redirect('/admin/intake');
});
```

Note: `admin/intake-upload` is rendered by the `GET /intake` route above but its view isn't created until Task 3 — that's fine, it just means `GET /intake` will error with "template not found" until Task 3 finishes. Task 2 is independently verifiable via the open-bin form only.

- [ ] **Step 2: Create `views/admin/intake-open.ejs`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intake — Open a Bin</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="admin-page">
    <nav class="admin-nav">
      <a href="/admin/intake">Intake</a>
      <a href="/admin/review">Review Queue</a>
      <a href="/admin/bins">Bins</a>
    </nav>
    <h1>Intake</h1>

    <% if (error) { %>
      <p class="error"><%= error %></p>
    <% } %>

    <form method="POST" action="/admin/intake/open" class="bin-create-form">
      <label>
        Bin number
        <input type="number" name="bin_number" min="1" value="<%= lastBin %>" required autofocus>
      </label>
      <button type="submit">Open Bin</button>
    </form>
  </main>
</body>
</html>
```

- [ ] **Step 3: Verify manually**

```bash
node server.js
```

In the browser: log in, go to `/admin/bins`, create a bin numbered `1` if none exist. Then visit `/admin/intake` — you should see the "Open a bin" form (it'll error on the upload-view branch only if you already have an `intake_bin` cookie from nothing — you won't yet). Submit bin number `1`. Since `views/admin/intake-upload.ejs` doesn't exist yet, this step will throw a template-not-found error after redirecting to `/admin/intake` — **that's expected**, confirms the route logic and cookie-setting worked up to the render call. Check your browser's dev tools → Application → Cookies to confirm `intake_bin` and `last_intake_bin` are both set. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add routes/admin.js views/admin/intake-open.ejs
git commit -m "Add open/close bin routes for web intake"
```

---

### Task 3: Upload handler and the upload-photo view

**Files:**
- Modify: `routes/admin.js`
- Create: `views/admin/intake-upload.ejs`

- [ ] **Step 1: Add multer and the lib imports to `routes/admin.js`**

At the top of `routes/admin.js`, change:

```js
const express = require('express');
const pool = require('../db/pool');
const { requireStaffAuth } = require('../middleware/auth');
const { transitionItem } = require('../db/transitions');
const { ALLOWED_CATEGORIES, clampSuggestedPrice, basePriceForCategory } = require('../lib/pricing');
const { isConsolidationCandidate } = require('../lib/bins');

const router = express.Router();
```

to:

```js
const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireStaffAuth } = require('../middleware/auth');
const { transitionItem } = require('../db/transitions');
const { ALLOWED_CATEGORIES, clampSuggestedPrice, basePriceForCategory } = require('../lib/pricing');
const { isConsolidationCandidate } = require('../lib/bins');
const { uploadPhoto } = require('../lib/storage');
const { analyzeItemPhoto } = require('../lib/ai');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
```

- [ ] **Step 2: Add the upload route**

Add this route in `routes/admin.js`, right after the `router.post('/intake/close', ...)` route added in Task 2:

```js
router.post(
  '/intake',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const openBin = req.signedCookies[INTAKE_BIN_COOKIE];
    if (!openBin) {
      return res.redirect('/admin/intake');
    }
    const binNumber = Number(openBin);

    if (!req.file) {
      return res.render('admin/intake-upload', { binNumber, error: 'A photo is required.' });
    }

    // Re-check the bin still exists in case it was retired mid-session — bin state is a
    // human decision (Section 2) and can change while a bin is open for intake.
    const { rows: binRows } = await pool.query('SELECT bin_number FROM bins WHERE bin_number = $1', [binNumber]);
    if (binRows.length === 0) {
      res.clearCookie(INTAKE_BIN_COOKIE);
      return res.render('admin/intake-open', {
        lastBin: String(binNumber),
        error: `Bin ${binNumber} no longer exists. Choose a different bin.`
      });
    }

    const { key, url } = await uploadPhoto(req.file.buffer, req.file.mimetype);

    // AI output is a draft, never published automatically (Section 2).
    const { fields, raw } = await analyzeItemPhoto(req.file.buffer, req.file.mimetype);

    const { rows } = await pool.query(
      `INSERT INTO items (
         bin_number, photo_key, photo_url, title, category, description, condition_notes,
         ai_raw_response, ai_confidence, price_original_cents, price_current_cents, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'draft')
       RETURNING id`,
      [
        binNumber,
        key,
        url,
        fields.title,
        fields.category,
        fields.description,
        fields.conditionNotes,
        raw ? JSON.stringify(raw) : null,
        fields.confidence,
        fields.priceCents
      ]
    );

    res.redirect(`/admin/intake/${rows[0].id}`);
  })
);
```

- [ ] **Step 3: Create `views/admin/intake-upload.ejs`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intake — Bin <%= binNumber %></title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="admin-page">
    <nav class="admin-nav">
      <a href="/admin/intake">Intake</a>
      <a href="/admin/review">Review Queue</a>
      <a href="/admin/bins">Bins</a>
    </nav>
    <h1>Working in Bin #<%= binNumber %></h1>

    <% if (error) { %>
      <p class="error"><%= error %></p>
    <% } %>

    <form method="POST" action="/admin/intake" enctype="multipart/form-data" class="bin-create-form">
      <label>
        Photo
        <input type="file" name="photo" accept="image/*" capture="environment" required>
      </label>
      <button type="submit">Upload &amp; Draft</button>
    </form>

    <form method="POST" action="/admin/intake/close">
      <button type="submit">Close Bin</button>
    </form>
  </main>
</body>
</html>
```

- [ ] **Step 4: Verify manually**

Requires real `ANTHROPIC_API_KEY` and R2 credentials to be set locally (`.env` — see `.env.example`), since this calls the real Anthropic and R2 APIs.

```bash
node server.js
```

In the browser: `/admin/intake` should now show the bin-open form (or the upload form, if a cookie from Task 2's test is still set). Open bin `1`. You should land on the upload form showing "Working in Bin #1". Choose a photo, submit. Expect a redirect to `/admin/intake/<id>` — this will 404/error since Task 4's view doesn't exist yet, **that's expected**. Confirm in the database that the item was actually created:

```bash
node -e "require('./db/pool').query(\"SELECT id, bin_number, title, status FROM items ORDER BY id DESC LIMIT 1\").then(r => { console.log(r.rows[0]); process.exit(0); })"
```

Expected: one row with `status: 'draft'`, `bin_number: 1`, and a non-null `title` (or null fields if the AI call failed — either way, confirms `POST /admin/intake` inserted a row). Stop the server.

- [ ] **Step 5: Commit**

```bash
git add routes/admin.js views/admin/intake-upload.ejs
git commit -m "Add photo upload handler for web intake"
```

---

### Task 4: Single-item review page

**Files:**
- Modify: `routes/admin.js`
- Create: `views/admin/intake-review.ejs`

- [ ] **Step 1: Add the route**

Add this route in `routes/admin.js`, right after the `POST /intake` route added in Task 3:

```js
router.get(
  '/intake/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1 AND status = 'draft'`, [req.params.id]);
    if (rows.length === 0) {
      return res.redirect('/admin/intake');
    }
    res.render('admin/intake-review', { item: rows[0], categories: ALLOWED_CATEGORIES });
  })
);
```

- [ ] **Step 2: Create `views/admin/intake-review.ejs`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Draft</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="admin-page">
    <nav class="admin-nav">
      <a href="/admin/intake">Intake</a>
      <a href="/admin/review">Review Queue</a>
      <a href="/admin/bins">Bins</a>
    </nav>
    <h1>Review Draft</h1>

    <%- include('../partials/item-review-card', { item, categories }) %>

    <p><a href="/admin/intake">Next Photo &rarr;</a></p>
  </main>
</body>
</html>
```

- [ ] **Step 3: Verify the full end-to-end flow manually**

```bash
node server.js
```

Walk through the complete flow in the browser:
1. Log in at `/login`.
2. Go to `/admin/bins`, confirm bin `1` exists (create it if needed).
3. Go to `/admin/intake`. If a bin is already open from earlier testing, click "Close Bin" first so you start from the open form.
4. Open bin `1` — the field should be pre-filled with `1` from `last_intake_bin` if you tested Task 2/3 already.
5. Upload a photo. Confirm you land on `/admin/intake/<id>` showing the AI-drafted title/category/description/price, with the bin number field pre-filled to `1`.
6. Click "Next Photo →". Confirm you're back on the upload form for bin `1` — **no bin re-entry required**.
7. Upload a second photo. Confirm a second draft item appears.
8. This time, on the review page, click "Approve & Publish". Confirm it redirects to `/admin/review` and the item is no longer listed there as a draft (query the DB or check the storefront if `listed_at`/status flows through as expected).
9. Go back to `/admin/intake`, click "Close Bin". Confirm you're back on the open-bin form.
10. Open a different bin number that doesn't exist (e.g. `9999`). Confirm you get the "does not exist" error and stay on the open-bin form.

Stop the server when done.

- [ ] **Step 4: Commit**

```bash
git add routes/admin.js views/admin/intake-review.ejs
git commit -m "Add single-item review page after intake upload"
```

---

## Self-review notes

- Spec coverage: every route and cookie behavior in the design doc (`GET /admin/intake`, `POST /admin/intake/open`, `POST /admin/intake/close`, `POST /admin/intake`, `GET /admin/intake/:id`, the partial extraction, the nav link) has a corresponding task/step above.
- No placeholders: every step has complete, runnable code — no TBDs or "add error handling" hand-waves.
- Type/name consistency checked: `INTAKE_BIN_COOKIE`/`LAST_INTAKE_BIN_COOKIE` names match across Tasks 2 and 3; `fields.conditionNotes`/`fields.priceCents` match the exact shape `lib/ai.js`'s `analyzeItemPhoto` returns (verified against `routes/api.js`'s existing usage); the `item-review-card` partial's expected locals (`item`, `categories`) match what all three call sites (`review.ejs`, `intake-review.ejs`) pass in.
