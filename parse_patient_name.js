'use strict';

// simple, robust parse_patient_name implementation
function parsePatientName(fullName) {
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

module.exports = parsePatientName;
