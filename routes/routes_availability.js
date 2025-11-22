const express = require('express');
const router = express.Router();
router.post('/availability', (req, res) => {
  // Minimal stub for testing — replace with real logic
  res.json({ ok: true, available: [], received: req.body });
});
module.exports = router;
