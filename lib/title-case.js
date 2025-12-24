// Lightweight title-case helper following common English title-case rules.
// Does not modify words inside parentheses or punctuation beyond basic splitting.
const SMALL_WORDS = new Set(['a','an','the','and','but','or','for','nor','on','at','to','from','by','with','in','of','over','as','via','per'])

// Pre-compiled regex patterns for performance
const REGEX_ALL_UPPER_SHORT = /^[A-Z0-9]{1,3}$/
const REGEX_WHITESPACE = /\s+/
const REGEX_WORD_PARTS = /^([^A-Za-z0-9]*)([A-Za-z0-9][\w'\-.:()]*)([^A-Za-z0-9]*)$/
const REGEX_ALL_UPPER = /^[A-Z0-9]+$/

function isAllUpperShort(word) {
  return REGEX_ALL_UPPER_SHORT.test(word)
}

function capitalize(word) {
  if (!word) return word
  // Preserve acronyms (all-uppercase short words)
  if (isAllUpperShort(word)) return word
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function titleCase(input) {
  if (input == null) return input
  const s = String(input).trim()
  if (!s) return s

  // Split on spaces to preserve punctuation attached to words
  const parts = s.split(REGEX_WHITESPACE)
  const out = parts.map((rawWord, idx, arr) => {
    // Keep surrounding punctuation but apply casing to inner alpha part
    const match = rawWord.match(REGEX_WORD_PARTS)
    if (!match) return rawWord
    const [, prefix, core, suffix] = match
    const isFirst = idx === 0
    const isLast = idx === arr.length - 1
    const lowerCore = core.toLowerCase()
    if (!isFirst && !isLast && SMALL_WORDS.has(lowerCore)) {
      return prefix + lowerCore + suffix
    }
    // If core is an all-upper short token (e.g., "TV", "BD"), preserve it
    if (REGEX_ALL_UPPER.test(core) && core.length <= 3) return prefix + core + suffix
    return prefix + capitalize(core) + suffix
  })

  return out.join(' ')
}

module.exports = titleCase;
