// Small utility to compute inclusive selection range from index bounds
function selectRange(items, a, b) {
  if (!Array.isArray(items)) return []
  let start = Math.min(a, b)
  let end = Math.max(a, b)
  if (start < 0) start = 0
  if (end > items.length - 1) end = items.length - 1
  const out = []
  for (let i = start; i <= end; i++) {
    const it = items[i]
    if (it && it.canonicalPath) out.push(it.canonicalPath)
  }
  return out
}

module.exports = { selectRange }
