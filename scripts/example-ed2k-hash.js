/**
 * ED2K Hash Example Script
 * 
 * Demonstrates how to compute and use ED2K hashes
 * Usage: node scripts/example-ed2k-hash.js <file-path>
 */

const fs = require('fs');
const path = require('path');
const { computeEd2kHash, computeEd2kHashSync, ED2K_CHUNK_SIZE } = require('../lib/ed2k-hash');

async function demonstrateED2K(filePath) {
  console.log('='.repeat(70));
  console.log('ED2K Hash Example');
  console.log('='.repeat(70));
  console.log('');

  // Validate file
  if (!filePath) {
    console.error('Usage: node scripts/example-ed2k-hash.js <file-path>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  // Get file info
  const stats = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const fileSize = stats.size;
  const chunkCount = Math.ceil(fileSize / ED2K_CHUNK_SIZE);

  console.log('📁 File Information');
  console.log('-'.repeat(70));
  console.log(`Name:       ${fileName}`);
  console.log(`Path:       ${filePath}`);
  console.log(`Size:       ${fileSize.toLocaleString()} bytes (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Chunks:     ${chunkCount} (chunk size: ${ED2K_CHUNK_SIZE.toLocaleString()} bytes)`);
  console.log('');

  // Compute hash asynchronously
  console.log('🔢 Computing ED2K Hash (Async - Recommended)');
  console.log('-'.repeat(70));
  console.log('This method streams the file and is memory-efficient for large files.');
  console.log('');

  const startAsync = Date.now();
  const hashAsync = await computeEd2kHash(filePath);
  const timeAsync = Date.now() - startAsync;

  console.log(`Hash:       ${hashAsync}`);
  console.log(`Time:       ${timeAsync}ms (${(timeAsync / 1000).toFixed(2)}s)`);
  console.log(`Speed:      ${(fileSize / 1024 / 1024 / (timeAsync / 1000)).toFixed(2)} MB/s`);
  console.log('');

  // Compute hash synchronously (for comparison)
  if (fileSize < 100 * 1024 * 1024) { // Only for files < 100MB
    console.log('🔢 Computing ED2K Hash (Sync - For Comparison)');
    console.log('-'.repeat(70));
    console.log('This method is simpler but blocks the event loop.');
    console.log('');

    const startSync = Date.now();
    const hashSync = computeEd2kHashSync(filePath);
    const timeSync = Date.now() - startSync;

    console.log(`Hash:       ${hashSync}`);
    console.log(`Time:       ${timeSync}ms (${(timeSync / 1000).toFixed(2)}s)`);
    console.log(`Match:      ${hashAsync === hashSync ? '✅ Yes' : '❌ No'}`);
    console.log('');
  } else {
    console.log('⏭️  Skipping sync test (file too large)');
    console.log('');
  }

  // Display hash details
  console.log('📋 Hash Details');
  console.log('-'.repeat(70));
  console.log(`ED2K Hash:  ${hashAsync}`);
  console.log(`Format:     32-character lowercase hexadecimal`);
  console.log(`Algorithm:  MD4 (chunked)`);
  console.log(`Chunk Size: ${ED2K_CHUNK_SIZE.toLocaleString()} bytes`);
  console.log('');

  // Generate ed2k link
  const ed2kLink = `ed2k://|file|${encodeURIComponent(fileName)}|${fileSize}|${hashAsync.toUpperCase()}|/`;
  console.log('🔗 ED2K Link');
  console.log('-'.repeat(70));
  console.log(ed2kLink);
  console.log('');

  // Usage examples
  console.log('💡 Usage Examples');
  console.log('-'.repeat(70));
  console.log('');

  console.log('1. Compare with AniDB:');
  console.log(`   - Hash: ${hashAsync}`);
  console.log(`   - Size: ${fileSize}`);
  console.log('   - Search on AniDB: https://anidb.net/file/hash');
  console.log('');

  console.log('2. Use in code:');
  console.log('   ```javascript');
  console.log('   const { computeEd2kHash } = require("./lib/ed2k-hash");');
  console.log('   const hash = await computeEd2kHash("path/to/file");');
  console.log('   console.log(hash); // ' + hashAsync);
  console.log('   ```');
  console.log('');

  console.log('3. Verify file integrity:');
  console.log('   - Compute hash before and after transfer');
  console.log('   - Hashes should match if file is identical');
  console.log('');

  // Performance tips
  console.log('⚡ Performance Tips');
  console.log('-'.repeat(70));
  console.log('');

  const throughput = fileSize / 1024 / 1024 / (timeAsync / 1000);
  
  if (throughput < 50) {
    console.log('⚠️  Slow throughput detected');
    console.log('   - Check if file is on a slow drive (HDD vs SSD)');
    console.log('   - Network drives are slower than local drives');
    console.log('   - Multiple simultaneous hash operations reduce speed');
  } else if (throughput < 200) {
    console.log('✅ Normal throughput');
    console.log('   - Typical for HDDs and network drives');
    console.log('   - SSDs can be faster');
  } else {
    console.log('🚀 Excellent throughput');
    console.log('   - Fast SSD or cached file');
    console.log('   - Optimal performance');
  }
  console.log('');

  // Memory efficiency
  console.log('💾 Memory Efficiency');
  console.log('-'.repeat(70));
  console.log('');
  console.log('The async hash function:');
  console.log('  ✅ Streams file in chunks (no full file in memory)');
  console.log('  ✅ Memory usage: ~10-20 MB regardless of file size');
  console.log('  ✅ Can hash files larger than available RAM');
  console.log('  ✅ Safe for 50+ GB Blu-ray remuxes');
  console.log('');

  console.log('='.repeat(70));
  console.log('Complete!');
  console.log('='.repeat(70));
}

// Run the demonstration
const filePath = process.argv[2];

demonstrateED2K(filePath).catch(err => {
  console.error('');
  console.error('❌ Error:', err.message);
  console.error('');
  process.exit(1);
});
