const assert = require('assert')
const { selectRange } = require('../web/src/selection-utils')

describe('web selection utils', function() {
  it('selects inclusive ranges in order', function() {
    const items = [
      { canonicalPath: 'a' },
      { canonicalPath: 'b' },
      { canonicalPath: 'c' },
      { canonicalPath: 'd' },
      { canonicalPath: 'e' }
    ]
    const res = selectRange(items, 1, 3)
    assert.deepStrictEqual(res, ['b','c','d'])
  })

  it('selects inclusive ranges inverted order', function() {
    const items = [
      { canonicalPath: 'a' },
      { canonicalPath: 'b' },
      { canonicalPath: 'c' },
      { canonicalPath: 'd' },
      { canonicalPath: 'e' }
    ]
    const res = selectRange(items, 3, 1)
    assert.deepStrictEqual(res, ['b','c','d'])
  })

  it('clamps out of bounds indices', function() {
    const items = [ { canonicalPath: 'x' }, { canonicalPath: 'y' }, { canonicalPath: 'z' } ]
    const res = selectRange(items, -5, 5)
    assert.deepStrictEqual(res, ['x','y','z'])
  })
})
