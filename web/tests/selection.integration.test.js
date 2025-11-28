const assert = require('assert')
const { createSelectionHarness } = require('../src/selection-test-harness')

describe('Selection Integration (harness)', function() {
  it('click then click toggles selection (deselect by clicking again)', function() {
    const items = [
      { canonicalPath: 'a' },
      { canonicalPath: 'b' },
      { canonicalPath: 'c' }
    ]
    const h = createSelectionHarness(items)

    // click index 1
    h.handleRowMouseDown({ button: 0, shiftKey: false }, 1)
    h.handleRowClick({ shiftKey: false }, 1)
    assert.strictEqual(!!h.selected['b'], true, 'item b should be selected after first click')

    // click same index again -> should deselect
    h.handleRowMouseDown({ button: 0, shiftKey: false }, 1)
    h.handleRowClick({ shiftKey: false }, 1)
    assert.strictEqual(!!h.selected['b'], false, 'item b should be deselected after second click')
  })

  it('click then shift+click selects inclusive range', function() {
    const items = [
      { canonicalPath: 'a' },
      { canonicalPath: 'b' },
      { canonicalPath: 'c' },
      { canonicalPath: 'd' }
    ]
    const h = createSelectionHarness(items)

    // select index 1
    h.handleRowMouseDown({ button: 0, shiftKey: false }, 1)
    h.handleRowClick({ shiftKey: false }, 1)
    assert.strictEqual(!!h.selected['b'], true)

    // simulate scroll (no-op for harness), then shift+click index 3
    // Important: user holds Shift when mousing down; mousedown with shift should NOT overwrite lastClickedIndex
    h.handleRowMouseDown({ button: 0, shiftKey: true }, 3)
    // shift click should select range 1..3
    h.handleRowClick({ shiftKey: true }, 3)
    assert.strictEqual(!!h.selected['b'], true)
    assert.strictEqual(!!h.selected['c'], true)
    assert.strictEqual(!!h.selected['d'], true)
  })
})
