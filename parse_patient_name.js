'use strict';

/**
 * parse_patient_name.js
 *
 * Accepts either:
 *  - a string "Sam Kent"
 *  - an object { full_name: "Sam Kent" }
 * Returns an object: { full_name, first_name, last_name }
 */

function doParse(fullName) {
  const result = { full_name: '', first_name: '', last_name: '' };

  if (!fullName || typeof fullName !== 'string') return result;

  // normalize whitespace
  let name = fullName.trim().replace(/\s+/g, ' ');
  if (!name) return result;

  result.full_name = name;

  // If "Last, First [Middle]" format
  if (/,/.test(name)) {
    const [lastPart, firstPart] = name.split(',', 2).map(s => s.trim());
    const firstToken = (firstPart || '').split(' ')[0] || '';
    result.first_name = firstToken;
    result.last_name = lastPart || '';
    return result;
  }

  // Otherwise treat first token as first name, rest as last name
  const parts = name.split(' ');
  if (parts.length === 1) {
    result.first_name = parts[0];
    result.last_name = '';
    return result;
  }

  result.first_name = parts[0];
  result.last_name = parts.slice(1).join(' ');
  return result;
}

// Tool-friendly wrapper: accept string or object
function parse_patient_name(input) {
  if (!input) return { full_name: '', first_name: '', last_name: '' };
  if (typeof input === 'string') return doParse(input);
  if (typeof input === 'object') {
    // common payload shapes: { full_name: "Sam Kent" } or { name: "Sam Kent" }
    const maybe = input.full_name || input.fullName || input.name || input.full || '';
    if (typeof maybe === 'string' && maybe.trim()) return doParse(maybe);
    // fallback: attempt to stringify
    if (typeof input === 'object' && input !== null) {
      // try firstName/lastName already present
      if (input.first_name || input.firstName || input.first || input.last_name || input.lastName || input.last) {
        return {
          full_name: `${input.first_name || input.firstName || input.first || ''}${input.last_name || input.lastName || input.last ? ' ' : ''}${input.last_name || input.lastName || input.last || ''}`.trim(),
          first_name: input.first_name || input.firstName || input.first || '',
          last_name: input.last_name || input.lastName || input.last || ''
        };
      }
    }
    return { full_name: '', first_name: '', last_name: '' };
  }
  return { full_name: '', first_name: '', last_name: '' };
}

// Exports: default function and named export (covers different import styles)
module.exports = parse_patient_name;
module.exports.parse_patient_name = parse_patient_name;
module.exports._doParse = doParse;
