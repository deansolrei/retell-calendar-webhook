/**
 * routes/index.js - central router that mounts individual route modules.
 *
 * Place this file at ./routes/index.js and move your routes_*.js files into ./routes/
 * so their relative requires (../middleware/requireAuth) resolve to ../middleware/requireAuth.js
 */

const express = require('express');
const router = express.Router();

// Each route module should export an express.Router
const tryMount = (modPath, mountPoint = '/') => {
    try {
        const r = require(modPath);
        router.use(mountPoint, r);
        console.log(`Mounted ${modPath} at ${mountPoint}`);
    } catch (err) {
        console.warn(`Skipping optional module ${modPath}:`, err && err.message ? err.message : err);
    }
};

// Mount provided route modules (names expected in ./routes/)
tryMount('./routes_provider_lookup', '/');
tryMount('./routes_availability', '/');
tryMount('./routes_book', '/');
tryMount('./routes_slots', '/');
tryMount('./routes_parse', '/');
tryMount('./routes_book_provider_appointment', '/');

module.exports = router;