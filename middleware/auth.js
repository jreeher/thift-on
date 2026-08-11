// Gates /admin and /staff behind a single shared staff password (Section 11: "keep it
// dumb-simple for v1" — no user table, just a signed cookie session).
function requireStaffAuth(req, res, next) {
  if (req.signedCookies && req.signedCookies.staff_session === 'authenticated') {
    return next();
  }
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

module.exports = { requireStaffAuth };
