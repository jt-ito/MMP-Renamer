// Minimal selection handler harness for integration tests
const { selectRange } = require('./selection-utils')

function createSelectionHarness(items, initialSelected = {}) {
  const lastClickedIndex = { current: null }

  // toggleSelect receives (path, val) where val=true/false or undefined to toggle
  const selected = { ...initialSelected }
  const toggles = []

  function toggleSelect(path, val) {
    if (!path) return
    const before = !!selected[path]
    let after
    if (typeof val === 'boolean') {
      after = val
    } else {
      after = !before
    }
    if (after) selected[path] = true
    else delete selected[path]
    toggles.push({ path, before, after })
  }

  function handleRowMouseDown(ev, index) {
    if (!ev) ev = {}
    if (ev.button !== undefined && ev.button !== 0) return
    if (ev.shiftKey) return
    lastClickedIndex.current = index
    // also log
    // console.debug('[harness] mousedown', { index, shift: ev.shiftKey })
  }

  function handleRowClick(ev, index) {
    if (!ev) ev = {}
    const it = items[index]
    if (!it) return
    if (ev.shiftKey && lastClickedIndex.current !== null && lastClickedIndex.current !== index) {
      const start = Math.min(lastClickedIndex.current, index)
      const end = Math.max(lastClickedIndex.current, index)
      const paths = selectRange(items, start, end)
      for (const p of paths) toggleSelect(p, true)
      lastClickedIndex.current = index
      return
    }
    // normal toggle
    toggleSelect(it.canonicalPath, undefined)
    lastClickedIndex.current = index
  }

  return { lastClickedIndex, selected, toggles, handleRowMouseDown, handleRowClick }
}

module.exports = { createSelectionHarness }
