const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('lib/db basic', function() {
  it('should init and set/get KV when better-sqlite3 is installed', function() {
    let dbLib = null;
    try {
      dbLib = require('../lib/db');
    } catch (e) {
      this.skip();
      return;
    }
    const tmp = path.join(__dirname, '..', 'data', 'test-db.sqlite');
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
    dbLib.init(tmp);
    dbLib.setKV('x', { a: 1, b: 'two' });
    const v = dbLib.getKV('x');
    assert.deepStrictEqual(v, { a: 1, b: 'two' });
    // hide events
    dbLib.setHideEvents([{ ts: 1, path: '/tmp' }]);
    const he = dbLib.getHideEvents();
    assert.ok(Array.isArray(he) && he.length === 1);
  });
});
