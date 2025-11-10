/**
 * AniDB Provider Tests
 * 
 * Tests for AniDB HTTP/UDP API integration
 * Note: These tests use mocks to avoid hitting the real AniDB API
 */

const assert = require('assert');
const { AniDBClient, getAniDBClient } = require('../lib/anidb');
const { parseEpisodeNumber } = require('../lib/meta-providers');

describe('AniDB Provider Tests', function() {
  this.timeout(10000);

  describe('AniDBClient - Initialization', function() {
    it('should create client with credentials', function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      assert.strictEqual(client.username, 'testuser');
      assert.strictEqual(client.password, 'testpass');
      assert.strictEqual(client.sessionKey, null);
    });

    it('should initialize singleton instance', function() {
      const client1 = getAniDBClient('user1', 'pass1');
      const client2 = getAniDBClient('user1', 'pass1');
      
      assert.strictEqual(client1, client2);
    });

    it('should create new instance for different user', function() {
      const client1 = getAniDBClient('user1', 'pass1');
      const client2 = getAniDBClient('user2', 'pass2');
      
      assert.notStrictEqual(client1, client2);
    });
  });

  describe('AniDBClient - Rate Limiting', function() {
    it.skip('should enforce HTTP rate limit delay', async function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      const start = Date.now();
      
      // First request should be immediate
      await client._waitForHttpRateLimit();
      const firstDelay = Date.now() - start;
      assert(firstDelay < 100, 'First request should be immediate');
      
      // Second request should be delayed
      const secondStart = Date.now();
      await client._waitForHttpRateLimit();
      const secondDelay = Date.now() - secondStart;
      
      // Should wait at least the minimum delay (accounting for some tolerance)
      assert(secondDelay >= 2400, `Second request should be delayed by ~2500ms, got ${secondDelay}ms`);
    });

    it.skip('should enforce UDP rate limit delay', async function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      const start = Date.now();
      
      await client._waitForUdpRateLimit();
      const firstDelay = Date.now() - start;
      assert(firstDelay < 100, 'First request should be immediate');
      
      const secondStart = Date.now();
      await client._waitForUdpRateLimit();
      const secondDelay = Date.now() - secondStart;
      
      assert(secondDelay >= 2400, `Second request should be delayed by ~2500ms, got ${secondDelay}ms`);
    });
  });

  describe('AniDBClient - Bulk Operation Pause', function() {
    it.skip('should track bulk operation timing', async function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      // First check should initialize timer
      await client._checkBulkOperationPause();
      assert(client.bulkOperationStartTime !== null);
      assert.strictEqual(client.requestCount, 1);
      
      // Second check should increment counter
      await client._checkBulkOperationPause();
      assert.strictEqual(client.requestCount, 2);
    });

    // Note: Full 30-minute test would take too long for unit tests
    // Integration tests should verify the actual pause behavior
  });

  describe('AniDBClient - Response Parsing', function() {
    it('should parse UDP FILE response', function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      // Sample UDP response data (pipe-delimited)
      const sampleData = '12345|678|90|111|222|0|524288000|abcdef1234567890abcdef1234567890|[Group] Title - 01.mkv|1|Episode Title|Anime Title|エピソード|Episoodo|GroupName';
      
      const parsed = client._parseFileResponse(sampleData);
      
      assert.strictEqual(parsed.fid, '12345');
      assert.strictEqual(parsed.aid, '678');
      assert.strictEqual(parsed.eid, '90');
      assert.strictEqual(parsed.episodeNumber, '1');
      assert.strictEqual(parsed.episodeName, 'Episode Title');
      assert.strictEqual(parsed.animeTitle, 'Anime Title');
      assert.strictEqual(parsed.group, 'GroupName');
    });

    it('should parse HTTP FILE response', function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      const sampleXML = `<?xml version="1.0" encoding="UTF-8"?>
<file>
  <fid>12345</fid>
  <aid>678</aid>
  <eid>90</eid>
  <anime_title_romaji>Test Anime</anime_title_romaji>
  <anime_title_english>Test Anime English</anime_title_english>
  <episode_number>1</episode_number>
  <episode_title_romaji>Test Episode</episode_title_romaji>
  <group_name>TestGroup</group_name>
</file>`;
      
      const parsed = client._parseHttpFileResponse(sampleXML);
      
      assert.strictEqual(parsed.fid, '12345');
      assert.strictEqual(parsed.aid, '678');
      assert.strictEqual(parsed.animeTitle, 'Test Anime English');
      assert.strictEqual(parsed.episodeNumber, '1');
      assert.strictEqual(parsed.episodeName, 'Test Episode');
    });

    it('should handle HTTP error responses', function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      const errorXML = `<?xml version="1.0" encoding="UTF-8"?>
<error>No such file</error>`;
      
      const parsed = client._parseHttpFileResponse(errorXML);
      assert.strictEqual(parsed, null);
    });

    it('should parse HTTP ANIME response', function() {
      const client = new AniDBClient('testuser', 'testpass');
      
      const sampleXML = `<?xml version="1.0" encoding="UTF-8"?>
<anime>
  <aid>678</aid>
  <title>Test Anime Series</title>
  <type>TV Series</type>
  <episodecount>24</episodecount>
  <startdate>2020-01-01</startdate>
  <enddate>2020-06-30</enddate>
  <description>Test description</description>
</anime>`;
      
      const parsed = client._parseHttpAnimeResponse(sampleXML);
      
      assert.strictEqual(parsed.aid, '678');
      assert.strictEqual(parsed.title, 'Test Anime Series');
      assert.strictEqual(parsed.type, 'TV Series');
      assert.strictEqual(parsed.episodeCount, '24');
    });
  });

  describe('Episode Number Parsing', function() {
    it('should parse regular episode numbers', function() {
      assert.strictEqual(parseEpisodeNumber('1'), 1);
      assert.strictEqual(parseEpisodeNumber('12'), 12);
      assert.strictEqual(parseEpisodeNumber('123'), 123);
    });

    it('should parse special episodes (S prefix)', function() {
      assert.strictEqual(parseEpisodeNumber('S1'), '0.1');
      assert.strictEqual(parseEpisodeNumber('S12'), '0.12');
      assert.strictEqual(parseEpisodeNumber('s5'), '0.5');
    });

    it('should parse credits (C prefix)', function() {
      assert.strictEqual(parseEpisodeNumber('C1'), '0.101');
      assert.strictEqual(parseEpisodeNumber('c2'), '0.102');
    });

    it('should parse trailers (T prefix)', function() {
      assert.strictEqual(parseEpisodeNumber('T1'), '0.101');
      assert.strictEqual(parseEpisodeNumber('t3'), '0.103');
    });

    it('should handle null/undefined', function() {
      assert.strictEqual(parseEpisodeNumber(null), null);
      assert.strictEqual(parseEpisodeNumber(undefined), null);
      assert.strictEqual(parseEpisodeNumber(''), null);
    });

    it('should handle invalid formats', function() {
      assert.strictEqual(parseEpisodeNumber('X1'), null);
      assert.strictEqual(parseEpisodeNumber('abc'), null);
    });
  });
});

// Integration test helpers (commented out to avoid hitting real API)
/*
describe('AniDB Integration Tests (Manual)', function() {
  // These tests should only be run manually with real credentials
  // and with appropriate delays to respect AniDB rate limits
  
  it.skip('should authenticate with AniDB UDP', async function() {
    this.timeout(30000);
    
    const username = process.env.ANIDB_USERNAME;
    const password = process.env.ANIDB_PASSWORD;
    
    if (!username || !password) {
      console.log('Skipping: Set ANIDB_USERNAME and ANIDB_PASSWORD env vars');
      return;
    }
    
    const client = new AniDBClient(username, password);
    const sessionKey = await client.authenticateUdp();
    
    assert(sessionKey);
    assert(typeof sessionKey === 'string');
    assert(sessionKey.length > 0);
    
    await client.logoutUdp();
  });
  
  it.skip('should lookup file by hash', async function() {
    this.timeout(60000);
    
    // Use a known ED2K hash for testing
    // Example: Hash of a small test file
    const testHash = 'REPLACE_WITH_REAL_HASH';
    const testSize = 12345678;
    
    const username = process.env.ANIDB_USERNAME;
    const password = process.env.ANIDB_PASSWORD;
    
    if (!username || !password) {
      console.log('Skipping: Set ANIDB_USERNAME and ANIDB_PASSWORD env vars');
      return;
    }
    
    const client = new AniDBClient(username, password);
    const fileInfo = await client.lookupFileByHash(testHash, testSize);
    
    if (fileInfo) {
      assert(fileInfo.aid);
      assert(fileInfo.animeTitle);
      console.log('Found:', fileInfo.animeTitle);
    } else {
      console.log('File not found in AniDB');
    }
    
    await client.logoutUdp();
  });
});
*/

if (require.main === module) {
  console.log('Running AniDB provider tests...');
}
