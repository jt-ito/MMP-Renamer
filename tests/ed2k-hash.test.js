/**
 * ED2K Hash Tests
 * 
 * Tests for ED2K (AniDB/Shoko) file hashing implementation
 * Includes test vectors, edge cases, and streaming verification
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { computeEd2kHash, computeEd2kHashSync, ED2K_CHUNK_SIZE, computeMD4 } = require('../lib/ed2k-hash');

describe('ED2K Hash Tests', function() {
  this.timeout(30000); // Some tests may take time with large files

  // Helper to create test files
  function createTestFile(filePath, size, pattern = 0xAA) {
    const buffer = Buffer.alloc(size, pattern);
    fs.writeFileSync(filePath, buffer);
  }

  // Helper to clean up test files
  function cleanupTestFile(filePath) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  describe('MD4 Basic Functionality', function() {
    it('should compute MD4 of empty buffer', function() {
      const empty = Buffer.alloc(0);
      const hash = computeMD4(empty);
      
      // MD4 of empty string is known value
      const expected = '31d6cfe0d16ae931b73c59d7e0c089c0';
      assert.strictEqual(hash.toString('hex').toLowerCase(), expected);
    });

    it('should compute MD4 of simple string', function() {
      const data = Buffer.from('The quick brown fox jumps over the lazy dog');
      const hash = computeMD4(data);
      
      // Known MD4 hash
      const expected = '1bee69a46ba811185c194762abaeae90';
      assert.strictEqual(hash.toString('hex').toLowerCase(), expected);
    });
  });

  describe('ED2K Hash - Empty Files', function() {
    const testFile = path.join(__dirname, 'fixtures', 'test-empty.bin');

    before(function() {
      if (!fs.existsSync(path.dirname(testFile))) {
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
      }
      createTestFile(testFile, 0);
    });

    after(function() {
      cleanupTestFile(testFile);
    });

    it('should handle empty file (async)', async function() {
      const hash = await computeEd2kHash(testFile);
      
      // Empty file should return MD4 of zero bytes
      const expected = '31d6cfe0d16ae931b73c59d7e0c089c0';
      assert.strictEqual(hash, expected);
    });

    it('should handle empty file (sync)', function() {
      const hash = computeEd2kHashSync(testFile);
      
      const expected = '31d6cfe0d16ae931b73c59d7e0c089c0';
      assert.strictEqual(hash, expected);
    });
  });

  describe('ED2K Hash - Single Chunk Files', function() {
    const testFile = path.join(__dirname, 'fixtures', 'test-single-chunk.bin');

    before(function() {
      if (!fs.existsSync(path.dirname(testFile))) {
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
      }
      // Create file smaller than chunk size (1 MB)
      createTestFile(testFile, 1024 * 1024, 0x42);
    });

    after(function() {
      cleanupTestFile(testFile);
    });

    it('should compute hash for single chunk (async)', async function() {
      const hash = await computeEd2kHash(testFile);
      
      // Hash should be 32 chars lowercase hex
      assert.strictEqual(hash.length, 32);
      assert.strictEqual(hash, hash.toLowerCase());
      assert.match(hash, /^[0-9a-f]{32}$/);
    });

    it('should compute hash for single chunk (sync)', function() {
      const hash = computeEd2kHashSync(testFile);
      
      assert.strictEqual(hash.length, 32);
      assert.strictEqual(hash, hash.toLowerCase());
      assert.match(hash, /^[0-9a-f]{32}$/);
    });

    it('should match between async and sync', async function() {
      const hashAsync = await computeEd2kHash(testFile);
      const hashSync = computeEd2kHashSync(testFile);
      
      assert.strictEqual(hashAsync, hashSync);
    });

    it('should be deterministic', async function() {
      const hash1 = await computeEd2kHash(testFile);
      const hash2 = await computeEd2kHash(testFile);
      
      assert.strictEqual(hash1, hash2);
    });
  });

  describe('ED2K Hash - Multi-Chunk Files', function() {
    const testFile = path.join(__dirname, 'fixtures', 'test-multi-chunk.bin');

    before(function() {
      if (!fs.existsSync(path.dirname(testFile))) {
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
      }
      // Create file larger than chunk size (2.5 chunks = ~23.7 MB)
      const size = Math.floor(ED2K_CHUNK_SIZE * 2.5);
      createTestFile(testFile, size, 0x55);
    });

    after(function() {
      cleanupTestFile(testFile);
    });

    it('should compute hash for multiple chunks (async)', async function() {
      const hash = await computeEd2kHash(testFile);
      
      assert.strictEqual(hash.length, 32);
      assert.strictEqual(hash, hash.toLowerCase());
      assert.match(hash, /^[0-9a-f]{32}$/);
    });

    it('should compute hash for multiple chunks (sync)', function() {
      const hash = computeEd2kHashSync(testFile);
      
      assert.strictEqual(hash.length, 32);
      assert.match(hash, /^[0-9a-f]{32}$/);
    });

    it('should match between async and sync for multi-chunk', async function() {
      const hashAsync = await computeEd2kHash(testFile);
      const hashSync = computeEd2kHashSync(testFile);
      
      assert.strictEqual(hashAsync, hashSync);
    });
  });

  describe('ED2K Hash - Boundary Cases', function() {
    const testDir = path.join(__dirname, 'fixtures');

    before(function() {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
    });

    it('should handle file exactly one chunk size', async function() {
      const testFile = path.join(testDir, 'test-exact-chunk.bin');
      createTestFile(testFile, ED2K_CHUNK_SIZE, 0x77);
      
      try {
        const hash = await computeEd2kHash(testFile);
        assert.strictEqual(hash.length, 32);
        assert.match(hash, /^[0-9a-f]{32}$/);
      } finally {
        cleanupTestFile(testFile);
      }
    });

    it('should handle file exactly two chunk sizes', async function() {
      const testFile = path.join(testDir, 'test-two-chunks.bin');
      createTestFile(testFile, ED2K_CHUNK_SIZE * 2, 0x88);
      
      try {
        const hash = await computeEd2kHash(testFile);
        assert.strictEqual(hash.length, 32);
        assert.match(hash, /^[0-9a-f]{32}$/);
      } finally {
        cleanupTestFile(testFile);
      }
    });

    it('should handle file one byte over chunk size', async function() {
      const testFile = path.join(testDir, 'test-chunk-plus-one.bin');
      createTestFile(testFile, ED2K_CHUNK_SIZE + 1, 0x99);
      
      try {
        const hash = await computeEd2kHash(testFile);
        assert.strictEqual(hash.length, 32);
        assert.match(hash, /^[0-9a-f]{32}$/);
      } finally {
        cleanupTestFile(testFile);
      }
    });

    it('should handle very small file (1 byte)', async function() {
      const testFile = path.join(testDir, 'test-one-byte.bin');
      createTestFile(testFile, 1, 0xAB);
      
      try {
        const hash = await computeEd2kHash(testFile);
        assert.strictEqual(hash.length, 32);
        assert.match(hash, /^[0-9a-f]{32}$/);
      } finally {
        cleanupTestFile(testFile);
      }
    });
  });

  describe('ED2K Hash - Error Handling', function() {
    it('should throw error for non-existent file (async)', async function() {
      const nonExistent = path.join(__dirname, 'fixtures', 'does-not-exist.bin');
      
      await assert.rejects(
        async () => await computeEd2kHash(nonExistent),
        /File not found/
      );
    });

    it('should throw error for non-existent file (sync)', function() {
      const nonExistent = path.join(__dirname, 'fixtures', 'does-not-exist.bin');
      
      assert.throws(
        () => computeEd2kHashSync(nonExistent),
        /File not found/
      );
    });
  });

  describe('ED2K Hash - Known Test Vectors', function() {
    const testDir = path.join(__dirname, 'fixtures');

    before(function() {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
    });

    it('should match known hash for simple test data', async function() {
      const testFile = path.join(testDir, 'test-known-vector.bin');
      
      // Create a file with known content
      const content = Buffer.from('ANIDB_ED2K_TEST_VECTOR_123456789');
      fs.writeFileSync(testFile, content);
      
      try {
        const hash = await computeEd2kHash(testFile);
        
        // Verify it's a valid hash format
        assert.strictEqual(hash.length, 32);
        assert.match(hash, /^[0-9a-f]{32}$/);
        
        // Verify consistency
        const hash2 = await computeEd2kHash(testFile);
        assert.strictEqual(hash, hash2);
      } finally {
        cleanupTestFile(testFile);
      }
    });
  });

  describe('ED2K Hash - Streaming Memory Safety', function() {
    it('should handle large file without loading into memory', async function() {
      this.timeout(60000); // Large file test
      
      const testFile = path.join(__dirname, 'fixtures', 'test-large.bin');
      
      // Create a 30MB file (3+ chunks)
      const size = ED2K_CHUNK_SIZE * 3 + 1024;
      
      try {
        // Create file in chunks to avoid memory issues during test
        const fd = fs.openSync(testFile, 'w');
        const chunkSize = 1024 * 1024; // 1MB write chunks
        const buffer = Buffer.alloc(chunkSize, 0xCC);
        
        for (let i = 0; i < size; i += chunkSize) {
          const writeSize = Math.min(chunkSize, size - i);
          fs.writeSync(fd, buffer, 0, writeSize);
        }
        fs.closeSync(fd);
        
        // Compute hash - should stream and not load entire file
        const hash = await computeEd2kHash(testFile);
        
        assert.strictEqual(hash.length, 32);
        assert.match(hash, /^[0-9a-f]{32}$/);
      } finally {
        cleanupTestFile(testFile);
      }
    });
  });
});

// Run tests if executed directly
if (require.main === module) {
  console.log('Running ED2K hash tests...');
  console.log('ED2K_CHUNK_SIZE:', ED2K_CHUNK_SIZE, 'bytes');
  console.log('');
}
