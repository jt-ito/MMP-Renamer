// Lightweight title-case helper following common English title-case rules.
// Does not modify words inside parentheses or punctuation beyond basic splitting.
const SMALL_WORDS = new Set(['a','an','the','and','but','or','for','nor','on','at','to','from','by','with','in','of','over','as','via','per']);

function isAllUpperShort(word) {
  return /^[A-Z0-9]{1,3}$/.test(word);
}

function capitalize(word) {
  if (!word) return word;
  // Preserve acronyms (all-uppercase short words)
  if (isAllUpperShort(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function titleCase(input) {
  if (input == null) return input;
  const s = String(input).trim();
  if (!s) return s;

  // Split on spaces to preserve punctuation attached to words
  const parts = s.split(/\s+/);
  const out = parts.map((rawWord, idx, arr) => {
    // Keep surrounding punctuation but apply casing to inner alpha part
    const match = rawWord.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][\w'\-.:()]*)([^A-Za-z0-9]*)$/);
    if (!match) return rawWord;
    const [, prefix, core, suffix] = match;
    const isFirst = idx === 0;
    const isLast = idx === arr.length - 1;
    const lowerCore = core.toLowerCase();
    if (!isFirst && !isLast && SMALL_WORDS.has(lowerCore)) {
      return prefix + lowerCore + suffix;
    }
    // If core is an all-upper short token (e.g., "TV", "BD"), preserve it
    if (/^[A-Z0-9]+$/.test(core) && core.length <= 3) return prefix + core + suffix;
    return prefix + capitalize(core) + suffix;
  });

  return out.join(' ');
}

module.exports = titleCase;
