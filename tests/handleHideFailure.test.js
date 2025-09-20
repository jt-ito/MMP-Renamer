const assert = require('assert')
const path = require('path')

describe('handleHideFailure helper', function() {
  it('applies authoritative enrichment and reloads small page for modified scan', async function() {
    const helperPath = path.resolve(__dirname, '..', 'web', 'src', 'hideFailureHelper.cjs')
    const handleHideFailure = require(helperPath)

    // Mocked state and functions
    let setEnrichCacheCalled = false
    let setItemsCalled = false
    let setAllItemsCalled = false
    let updateCalled = false

    const fakeNorm = { parsed: { title: 'Test' }, hidden: true }

    const opts = {
      candidates: ['/path/to/file.mkv'],
      waitForHideEvent: async () => ({ path: '/path/to/file.mkv', modifiedScanIds: [42] }),
      fetchEnrichByPath: async (p) => { if (p === '/path/to/file.mkv') return fakeNorm; return null },
      fetchScanMeta: async (sid) => { if (sid === 42) return { id: 42, totalCount: 2 }; return null },
      fetchScanItemsPage: async (sid, offset, limit) => { if (sid === 42) return { items: [{ canonicalPath: '/path/to/file.mkv' }, { canonicalPath: '/other.mkv' }] }; return { items: [] } },
      updateScanDataAndPreserveView: (m, coll) => { updateCalled = true; /* verify coll shape */ assert(Array.isArray(coll)); },
      setEnrichCache: (fn) => { setEnrichCacheCalled = true; const prev = {}; fn(prev); },
      setItems: (fn) => { setItemsCalled = true; const prev = []; fn(prev); },
      setAllItems: (fn) => { setAllItemsCalled = true; const prev = []; fn(prev); },
      scanId: 42,
      lastScanId: null,
      batchSize: 12,
      pushToast: () => {}
    }

    const result = await handleHideFailure(opts)
    assert.strictEqual(result, true)
    assert.ok(setEnrichCacheCalled, 'setEnrichCache should be called')
    assert.ok(updateCalled, 'updateScanDataAndPreserveView should be called')
    // items/allItems updated when hidden
    assert.ok(setItemsCalled, 'setItems should be called')
    assert.ok(setAllItemsCalled, 'setAllItems should be called')
  })
  
  it('returns false when waitForHideEvent times out', async function() {
    const helperPath = require('path').resolve(__dirname, '..', 'web', 'src', 'hideFailureHelper.cjs')
    const handleHideFailure = require(helperPath)

    const opts = {
      candidates: ['/no/event'],
      waitForHideEvent: async () => null,
      fetchEnrichByPath: async () => null,
      fetchScanMeta: async () => null,
      fetchScanItemsPage: async () => ({ items: [] }),
      updateScanDataAndPreserveView: () => {},
      setEnrichCache: () => {},
      setItems: () => {},
      setAllItems: () => {},
      scanId: null,
      lastScanId: null,
      batchSize: 12,
      pushToast: () => {}
    }

    const result = await handleHideFailure(opts)
    assert.strictEqual(result, false)
  })

  it('falls back to full reload when modifiedScanIds is empty', async function() {
    const helperPath = require('path').resolve(__dirname, '..', 'web', 'src', 'hideFailureHelper.cjs')
    const handleHideFailure = require(helperPath)

    let fullReloadCalled = false
    // simulate event with no modifiedScanIds
    const opts = {
      candidates: ['/some/path'],
      waitForHideEvent: async () => ({ path: '/some/path', modifiedScanIds: [] }),
      fetchEnrichByPath: async (p) => ({ parsed: { title: 'X' } }),
  fetchScanMeta: async (sid) => ({ id: 7, totalCount: 1 }),
      fetchScanItemsPage: async (sid, offset, limit) => {
        // for full reload this will be called multiple times; return a small page then empty
        if (offset === 0) return { items: [{ canonicalPath: '/some/path' }] }
        return { items: [] }
      },
      updateScanDataAndPreserveView: (m, coll) => { fullReloadCalled = true },
      setEnrichCache: () => {},
      setItems: () => {},
      setAllItems: () => {},
      scanId: 7,
      lastScanId: null,
      batchSize: 1,
      pushToast: () => {}
    }

    const result = await handleHideFailure(opts)
    assert.strictEqual(result, true)
    assert.ok(fullReloadCalled, 'expected full reload path to call updateScanDataAndPreserveView')
  })
})
