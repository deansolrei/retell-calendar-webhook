const express = require('express');
const router = express.Router();

// Try to require a module path and mount it at '/'
function tryMount(path) {
  try {
    const mod = require(path);
    if (!mod) return;
    // If the module exports a Router or middleware function, mount it.
    if (typeof mod === 'function') {
      router.use('/', mod);
    } else if (mod && typeof mod === 'object') {
      router.use('/', mod);
    }
  } catch (err) {
    // ignore missing modules - allows incremental migration
  }
}

// Attempt to load existing route files that may be at repo root
tryMount('../routes_availability');
tryMount('../routes_slots');
tryMount('../routes_book');
tryMount('../routes_book_provider_appointment');
tryMount('../routes_provider_lookup');
tryMount('../routes_parse');
tryMount('../routes_index'); // in case an index file was created at repo root

// Fallback health endpoint (if no routes mounted)
router.get('/health', (req, res) => res.json({ ok: true }));

module.exports = router;
