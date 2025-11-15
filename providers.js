const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'providers.json');

function loadProviders() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const map = JSON.parse(raw || '{}');
  return map;
}

// Cache on first load
const PROVIDERS = loadProviders();

/**
 * Returns provider object by token OR by calendar_id (accepts either)
 * - identifier may be a token (e.g. 'jodene-jensen') or an exact calendar_id
 */
function getProvider(identifier) {
  if (!identifier) return null;
  // exact token lookup
  if (PROVIDERS[identifier]) return PROVIDERS[identifier];

  // find by calendar_id
  for (const token of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[token];
    if (p.calendar_id === identifier) return p;
  }
  return null;
}

/**
 * Find providers that match optional state and/or insurance (case-insensitive)
 * - state: two-letter state code (e.g., 'AZ')
 * - insurance: string (e.g., 'Cigna'), optional
 */
function findProviders({ state = null, insurance = null } = {}) {
  const results = [];
  for (const token of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[token];
    if (state) {
      if (!p.licensed_states || !p.licensed_states.includes(state)) continue;
    }
    if (insurance) {
      if (!p.insurances || !p.insurances.includes(insurance)) continue;
    }
    results.push({ token, ...p });
  }
  return results;
}

module.exports = { getProvider, findProviders, PROVIDERS };