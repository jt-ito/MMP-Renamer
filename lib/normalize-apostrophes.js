// Normalize a variety of apostrophe-like characters to the straight ASCII apostrophe (')
// Pre-compiled regex for performance
const REGEX_APOSTROPHES = /[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02BB\u0060\u00B4]/g

function normalizeApostrophes(value) {
  if (value == null) return value
  return String(value).replace(REGEX_APOSTROPHES, "'")
}

module.exports = normalizeApostrophes;
