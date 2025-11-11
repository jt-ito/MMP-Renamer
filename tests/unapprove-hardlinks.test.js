const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const server = require('../server')

function canonical(p) {
  return server._test.canonicalize(p)
}

function setupHardlinkFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmp-unapprove-'))
  const inputDir = path.join(tmpRoot, 'input')
  const outputDir = path.join(tmpRoot, 'output', 'Series')
  fs.mkdirSync(inputDir, { recursive: true })
  fs.mkdirSync(outputDir, { recursive: true })

  const sourcePath = path.join(inputDir, 'episode.mkv')
  const targetPath = path.join(outputDir, 'episode-renamed.mkv')
  fs.writeFileSync(sourcePath, 'test-data')
  fs.linkSync(sourcePath, targetPath)

  const sourceKey = canonical(sourcePath)
  const targetKey = canonical(targetPath)

  const metaName = 'episode-meta-key'

  server.enrichCache[sourceKey] = {
    applied: true,
    hidden: true,
    appliedAt: Date.now(),
    appliedTo: targetPath,
    metadataFilename: metaName,
    provider: null,
    parsed: null
  }

  server._test.renderedIndex[targetKey] = {
    source: sourcePath,
    appliedTo: targetPath,
    renderedName: path.basename(targetPath)
  }
  server._test.renderedIndex[metaName] = targetKey

  return {
    tmpRoot,
    sourcePath,
    targetPath,
    sourceKey,
    targetKey,
    metaName,
    cleanup() {
      delete server.enrichCache[sourceKey]
      delete server._test.renderedIndex[targetKey]
      delete server._test.renderedIndex[metaName]
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
    }
  }
}

function run() {
  // Ensure defaults for the setting
  server._test.setServerSetting('delete_hardlinks_on_unapprove', true)
  server._test.setUserSetting('admin', 'delete_hardlinks_on_unapprove', true)

  // Happy path: hardlink deleted when toggle enabled
  const fixture = setupHardlinkFixture()
  const result = server._test.performUnapprove({ requestedPaths: [fixture.sourceKey], count: 1, username: 'admin' })

  assert.ok(result.deletedHardlinks.some(p => canonical(p) === fixture.targetKey), 'hardlink target should be reported as deleted')
  assert.strictEqual(result.hardlinkErrors.length, 0, 'there should be no deletion errors')
  assert.strictEqual(server.enrichCache[fixture.sourceKey].applied, false, 'entry should no longer be marked applied')
  assert.strictEqual(server.enrichCache[fixture.sourceKey].appliedTo, undefined, 'appliedTo should be cleared')
  assert.ok(!fs.existsSync(fixture.targetPath), 'hardlink should be removed from disk')
  assert.strictEqual(server._test.renderedIndex[fixture.targetKey], undefined, 'renderedIndex target entry should be removed')
  assert.strictEqual(server._test.renderedIndex[fixture.metaName], undefined, 'renderedIndex alias entry should be removed')
  fixture.cleanup()

  // Disabled path: hardlink retained when toggle off
  const fixtureDisabled = setupHardlinkFixture()
  server._test.setServerSetting('delete_hardlinks_on_unapprove', false)
  server._test.setUserSetting('admin', 'delete_hardlinks_on_unapprove', false)

  const resultDisabled = server._test.performUnapprove({ requestedPaths: [fixtureDisabled.sourceKey], count: 1, username: 'admin' })

  assert.strictEqual(resultDisabled.deletedHardlinks.length, 0, 'no hardlinks should be deleted when toggle is off')
  assert.ok(fs.existsSync(fixtureDisabled.targetPath), 'hardlink should remain on disk when deletion disabled')
  assert.strictEqual(server.enrichCache[fixtureDisabled.sourceKey].applied, false, 'applied flag still cleared even when keeping hardlink')
  assert.strictEqual(server.enrichCache[fixtureDisabled.sourceKey].appliedTo, undefined, 'appliedTo cleared even when file retained')
  assert.strictEqual(server._test.renderedIndex[fixtureDisabled.targetKey], undefined, 'renderedIndex entry cleared even when keeping file')
  assert.strictEqual(server._test.renderedIndex[fixtureDisabled.metaName], undefined, 'renderedIndex alias removed even when keeping file')

  // Clean up and restore defaults
  fs.unlinkSync(fixtureDisabled.targetPath)
  fixtureDisabled.cleanup()
  server._test.setServerSetting('delete_hardlinks_on_unapprove', true)
  server._test.setUserSetting('admin', 'delete_hardlinks_on_unapprove', true)

  console.log('unapprove hardlink tests passed')
}

run()
