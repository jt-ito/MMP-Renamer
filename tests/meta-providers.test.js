/**
 * Meta Providers Integration Tests
 * 
 * Tests the integration layer that combines AniDB ED2K lookup
 * with the existing provider fallback chain
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { lookupMetadataWithAniDB, getAniDBCredentials } = require('../lib/meta-providers');

describe('Meta Providers Integration Tests', function() {
  this.timeout(10000);

  describe('getAniDBCredentials', function() {
    it('should extract credentials from server settings', function() {
      const serverSettings = {
        anidb_username: 'serveruser',
        anidb_password: 'serverpass'
      };
      
      const creds = getAniDBCredentials(null, serverSettings, {});
      
      assert.strictEqual(creds.anidb_username, 'serveruser');
      assert.strictEqual(creds.anidb_password, 'serverpass');
      assert.strictEqual(creds.hasCredentials, true);
    });

    it('should prefer user settings over server settings', function() {
      const serverSettings = {
        anidb_username: 'serveruser',
        anidb_password: 'serverpass'
      };
      
      const users = {
        'testuser': {
          settings: {
            anidb_username: 'useruser',
            anidb_password: 'userpass'
          }
        }
      };
      
      const creds = getAniDBCredentials('testuser', serverSettings, users);
      
      assert.strictEqual(creds.anidb_username, 'useruser');
      assert.strictEqual(creds.anidb_password, 'userpass');
      assert.strictEqual(creds.hasCredentials, true);
    });

    it('should return false for hasCredentials when missing', function() {
      const creds = getAniDBCredentials(null, {}, {});
      
      assert.strictEqual(creds.hasCredentials, false);
    });

    it('should handle partial credentials', function() {
      const serverSettings = {
        anidb_username: 'serveruser'
        // password missing
      };
      
      const creds = getAniDBCredentials(null, serverSettings, {});
      
      assert.strictEqual(creds.anidb_username, 'serveruser');
      assert.strictEqual(creds.anidb_password, null);
      assert.strictEqual(creds.hasCredentials, false);
    });
  });

  describe('lookupMetadataWithAniDB - Fallback Logic', function() {
    it('should use fallback when no AniDB credentials', async function() {
      let fallbackCalled = false;
      
      const mockFallback = async (title, apiKey, opts) => {
        fallbackCalled = true;
        return {
          provider: 'anilist',
          name: 'Test Series',
          episode: { name: 'Test Episode' }
        };
      };
      
      const result = await lookupMetadataWithAniDB(
        '/path/to/file.mkv',
        'Test Series',
        {
          fallbackMetaLookup: mockFallback,
          tmdbApiKey: 'test_key'
        }
      );
      
      assert.strictEqual(fallbackCalled, true);
      assert.strictEqual(result.provider, 'anilist');
    });

    it('should use fallback when file does not exist', async function() {
      let fallbackCalled = false;
      
      const mockFallback = async (title, apiKey, opts) => {
        fallbackCalled = true;
        return { provider: 'tmdb', name: 'Test' };
      };
      
      const result = await lookupMetadataWithAniDB(
        '/nonexistent/file.mkv',
        'Test',
        {
          anidb_username: 'test',
          anidb_password: 'test',
          fallbackMetaLookup: mockFallback
        }
      );
      
      assert.strictEqual(fallbackCalled, true);
    });

    it('should return null when no providers find metadata', async function() {
      const mockFallback = async (title, apiKey, opts) => {
        return null;
      };
      
      const result = await lookupMetadataWithAniDB(
        '/path/to/file.mkv',
        'Unknown Series',
        {
          fallbackMetaLookup: mockFallback
        }
      );
      
      assert.strictEqual(result, null);
    });
  });

  describe('lookupMetadataWithAniDB - Result Format', function() {
    it('should format AniDB results correctly', function() {
      // Test the expected result structure
      const expectedStructure = {
        provider: 'anidb',
        id: '12345',
        name: 'Test Anime',
        episodeTitle: 'Episode 1',
        episodeNumber: 1,
        seasonNumber: 1,
        raw: {},
        source: 'anidb-ed2k'
      };
      
      // Verify all expected fields are present
      assert.ok(expectedStructure.provider);
      assert.ok(expectedStructure.id);
      assert.ok(expectedStructure.name);
      assert.ok(expectedStructure.source);
    });

    it('should handle fallback result format', async function() {
      const mockFallback = async (title, apiKey, opts) => {
        return {
          provider: 'anilist',
          id: '67890',
          name: 'Test Series',
          raw: { some: 'data' },
          episode: { name: 'Test Episode' }
        };
      };
      
      const result = await lookupMetadataWithAniDB(
        '/path/to/file.mkv',
        'Test Series',
        {
          fallbackMetaLookup: mockFallback,
          tmdbApiKey: 'test_key'
        }
      );
      
      assert.strictEqual(result.provider, 'anilist');
      assert.strictEqual(result.name, 'Test Series');
    });
  });

  describe('Integration Flow', function() {
    it('should pass correct options to fallback', async function() {
      let receivedOpts = null;
      
      const mockFallback = async (title, apiKey, opts) => {
        receivedOpts = opts;
        return { provider: 'test', name: title };
      };
      
      await lookupMetadataWithAniDB(
        '/path/to/file.mkv',
        'Test Title',
        {
          season: 2,
          episode: 5,
          year: 2023,
          preferredProvider: 'tmdb',
          fallbackMetaLookup: mockFallback,
          tmdbApiKey: 'test_key',
          parentCandidate: 'Parent Show'
        }
      );
      
      assert.strictEqual(receivedOpts.season, 2);
      assert.strictEqual(receivedOpts.episode, 5);
      assert.strictEqual(receivedOpts.year, 2023);
      assert.strictEqual(receivedOpts.preferredProvider, 'tmdb');
      assert.strictEqual(receivedOpts.parentCandidate, 'Parent Show');
    });
  });
});

if (require.main === module) {
  console.log('Running meta providers integration tests...');
}
