require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');

const { requireStaffAuth } = require('./middleware/auth');
const adminRouter = require('./routes/admin');
const apiRouter = require('./routes/api');
const storefrontRouter = require('./routes/storefront');
const { releaseExpiredCarts } = require('./jobs/release-carts');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.static(path.join(__dirname, 'public')));

// Body parsers are mounted per-route below, not globally: the Stripe webhook
// route needs the raw body for signature verification and must never pass
// through express.json() first.

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/login', (req, res) => {
  res.render('login', { error: null, next: req.query.next || '/admin/review' });
});

app.post(
  '/login',
  express.urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    const { password, next: nextUrl } = req.body;

    if (!process.env.STAFF_PASSWORD) {
      return res.render('login', {
        error: 'STAFF_PASSWORD is not configured on the server.',
        next: nextUrl || '/admin/review'
      });
    }

    if (password !== process.env.STAFF_PASSWORD) {
      return res.render('login', { error: 'Incorrect password.', next: nextUrl || '/admin/review' });
    }

    res.cookie('staff_session', 'authenticated', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000 // 12 hours
    });

    res.redirect(nextUrl && nextUrl.startsWith('/') ? nextUrl : '/admin/review');
  })
);

app.post('/logout', (req, res) => {
  res.clearCookie('staff_session');
  res.redirect('/login');
});

app.use('/admin', adminRouter);
app.use('/api', apiRouter);

// Placeholder landing route so the /staff gate is visibly wired up before Phase 6
// adds the real fulfillment page.
app.get('/staff/fulfillment', requireStaffAuth, (req, res) => {
  res.send('Staff fulfillment queue — coming in Phase 6.');
});

app.use('/', storefrontRouter);

app.use((req, res) => {
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

// Releases abandoned cart reservations back to 'active' every 5 minutes (Section 9/10).
cron.schedule('*/5 * * * *', () => {
  releaseExpiredCarts().catch((err) => console.error('release-carts job failed:', err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OTS server listening on port ${PORT}`);
});
