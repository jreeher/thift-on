const crypto = require('crypto');

const COOKIE_NAME = 'cart_token';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// Cart identity is a signed cookie holding a random opaque token — no user accounts
// in v1 (Section 9).
function ensureCartToken(req, res, next) {
  let token = req.signedCookies && req.signedCookies[COOKIE_NAME];

  if (!token) {
    token = crypto.randomUUID();
    res.cookie(COOKIE_NAME, token, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS
    });
  }

  req.cartToken = token;
  next();
}

module.exports = { ensureCartToken, COOKIE_NAME };
