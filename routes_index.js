const express = require('express');
const router = express.Router();

// Route modules
router.use(require('./availability'));
router.use(require('./slots'));
router.use(require('./book'));
router.use(require('./provider_lookup'));
router.use(require('./parse'));

module.exports = router;