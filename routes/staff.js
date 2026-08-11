const express = require('express');
const { requireStaffAuth } = require('../middleware/auth');
const { getFulfillmentQueue, markItemPulled, markOrderPickedUp } = require('../lib/fulfillment');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.use(requireStaffAuth);
router.use(express.urlencoded({ extended: false }));

router.get(
  '/fulfillment',
  asyncHandler(async (req, res) => {
    const orders = await getFulfillmentQueue();
    res.render('staff/fulfillment', { orders, error: req.query.error || null });
  })
);

router.post(
  '/items/:id/pulled',
  asyncHandler(async (req, res) => {
    try {
      await markItemPulled(Number(req.params.id));
      res.redirect('/staff/fulfillment');
    } catch (err) {
      console.error('markItemPulled failed:', err.message);
      res.redirect(
        `/staff/fulfillment?error=${encodeURIComponent('Could not mark that item pulled — it may already be updated.')}`
      );
    }
  })
);

router.post(
  '/orders/:id/picked-up',
  asyncHandler(async (req, res) => {
    try {
      await markOrderPickedUp(Number(req.params.id));
      res.redirect('/staff/fulfillment');
    } catch (err) {
      console.error('markOrderPickedUp failed:', err.message);
      res.redirect(
        `/staff/fulfillment?error=${encodeURIComponent('Could not mark that order picked up — check that every item was pulled first.')}`
      );
    }
  })
);

module.exports = router;
