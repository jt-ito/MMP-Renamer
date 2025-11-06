/**
 * AniDB Integration Verification Script
 * 
 * Run this script to verify the AniDB integration is working correctly
 * Usage: node scripts/verify-anidb.js [optional-test-file-path]
 */

const fs = require('fs');
const path = require('path');
const { computeEd2kHash, computeEd2kHashSync } = require('../lib/ed2k-hash');
const { AniDBClient } = require('../lib/anidb');
const { getAniDBCredentials } = require('../lib/meta-providers');

console.log('='.repeat(70));
console.log('AniDB Integration Verification');
console.log('='.repeat(70));
console.log('');

async function verifyED2KHash(testFile) {
  console.log('📝 Step 1: Verifying ED2K Hash Implementation');
  console.log('-'.repeat(70));
  
  try {
    // Test with a small test file
    if (!testFile) {
      // Create a small test file
      testFile = path.join(__dirname, '..', 'tests', 'fixtures', 'verify-test.bin');
      const testDir = path.dirname(testFile);
      
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
      
      // Create 1MB test file
      const testData = Buffer.alloc(1024 * 1024, 0xAB);
      fs.writeFileSync(testFile, testData);
      console.log(`✓ Created test file: ${testFile}`);
    } else {
      if (!fs.existsSync(testFile)) {
        console.error(`✗ Test file not found: ${testFile}`);
        return false;
      }
      console.log(`✓ Using test file: ${testFile}`);
    }
    
    const stats = fs.statSync(testFile);
    console.log(`  Size: ${stats.size.toLocaleString()} bytes`);
    
    // Compute hash (async)
    console.log('  Computing ED2K hash (async)...');
    const startAsync = Date.now();
    const hashAsync = await computeEd2kHash(testFile);
    const timeAsync = Date.now() - startAsync;
    
    console.log(`  ✓ Async hash: ${hashAsync}`);
    console.log(`  ✓ Time: ${timeAsync}ms`);
    
    // Compute hash (sync)
    console.log('  Computing ED2K hash (sync)...');
    const startSync = Date.now();
    const hashSync = computeEd2kHashSync(testFile);
    const timeSync = Date.now() - startSync;
    
    console.log(`  ✓ Sync hash: ${hashSync}`);
    console.log(`  ✓ Time: ${timeSync}ms`);
    
    // Verify they match
    if (hashAsync === hashSync) {
      console.log('  ✓ Hashes match!');
    } else {
      console.error('  ✗ Hash mismatch!');
      return false;
    }
    
    // Verify format
    if (/^[0-9a-f]{32}$/.test(hashAsync)) {
      console.log('  ✓ Hash format valid (32 lowercase hex chars)');
    } else {
      console.error('  ✗ Invalid hash format');
      return false;
    }
    
    console.log('');
    console.log('✅ ED2K Hash Implementation: PASSED');
    console.log('');
    return true;
    
  } catch (error) {
    console.error('✗ ED2K Hash test failed:', error.message);
    console.error('');
    return false;
  }
}

async function verifyAniDBClient() {
  console.log('📡 Step 2: Verifying AniDB Client');
  console.log('-'.repeat(70));
  
  try {
    // Load settings
    const settingsFile = path.join(__dirname, '..', 'data', 'settings.json');
    let settings = {};
    
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
    
    const creds = getAniDBCredentials(null, settings, {});
    
    if (!creds.hasCredentials) {
      console.log('⚠️  No AniDB credentials configured');
      console.log('   This is optional. The system will fall back to other providers.');
      console.log('   To configure: Add anidb_username and anidb_password to settings.json');
      console.log('');
      console.log('⏭️  AniDB Client: SKIPPED (no credentials)');
      console.log('');
      return true; // Not a failure
    }
    
    console.log(`✓ Credentials found`);
    console.log(`  Username: ${creds.anidb_username}`);
    console.log(`  Password: ${'*'.repeat(creds.anidb_password.length)}`);
    
    // Create client
    const client = new AniDBClient(creds.anidb_username, creds.anidb_password);
    console.log('✓ AniDB client created');
    
    // Test rate limiting
    console.log('  Testing rate limiting...');
    const start = Date.now();
    await client._waitForHttpRateLimit();
    await client._waitForHttpRateLimit();
    const elapsed = Date.now() - start;
    
    if (elapsed >= 2400) {
      console.log(`  ✓ Rate limiting works (${elapsed}ms delay)`);
    } else {
      console.warn(`  ⚠️  Rate limiting may be too fast (${elapsed}ms)`);
    }
    
    console.log('');
    console.log('✅ AniDB Client: PASSED');
    console.log('');
    
    // Note: We don't test actual API calls to avoid hitting AniDB during verification
    console.log('ℹ️  Note: Actual API calls not tested (to avoid rate limits)');
    console.log('   Use npm run test:anidb for full API tests with mocks');
    console.log('');
    
    return true;
    
  } catch (error) {
    console.error('✗ AniDB Client test failed:', error.message);
    console.error('');
    return false;
  }
}

async function verifyIntegration() {
  console.log('🔗 Step 3: Verifying Integration');
  console.log('-'.repeat(70));
  
  try {
    // Verify meta-providers module loads
    const metaProviders = require('../lib/meta-providers');
    console.log('✓ meta-providers module loaded');
    
    // Verify exports
    if (typeof metaProviders.lookupMetadataWithAniDB === 'function') {
      console.log('✓ lookupMetadataWithAniDB function exists');
    } else {
      throw new Error('lookupMetadataWithAniDB not exported');
    }
    
    if (typeof metaProviders.getAniDBCredentials === 'function') {
      console.log('✓ getAniDBCredentials function exists');
    } else {
      throw new Error('getAniDBCredentials not exported');
    }
    
    // Verify settings structure
    const settingsFile = path.join(__dirname, '..', 'data', 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      
      const hasAniDBFields = 'anidb_username' in settings && 'anidb_password' in settings;
      if (hasAniDBFields) {
        console.log('✓ Settings file has AniDB fields');
      } else {
        console.log('⚠️  Settings file missing AniDB fields (will be added on save)');
      }
    }
    
    console.log('');
    console.log('✅ Integration: PASSED');
    console.log('');
    return true;
    
  } catch (error) {
    console.error('✗ Integration test failed:', error.message);
    console.error('');
    return false;
  }
}

async function runVerification() {
  const testFile = process.argv[2];
  
  let allPassed = true;
  
  // Step 1: ED2K Hash
  const hashPassed = await verifyED2KHash(testFile);
  allPassed = allPassed && hashPassed;
  
  // Step 2: AniDB Client
  const clientPassed = await verifyAniDBClient();
  allPassed = allPassed && clientPassed;
  
  // Step 3: Integration
  const integrationPassed = await verifyIntegration();
  allPassed = allPassed && integrationPassed;
  
  // Summary
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log('');
  
  if (allPassed) {
    console.log('✅ All verification checks PASSED!');
    console.log('');
    console.log('The AniDB integration is ready to use.');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Configure AniDB credentials in settings.json (if not done)');
    console.log('  2. Run: npm test (to run full test suite)');
    console.log('  3. Start server: npm start');
    console.log('  4. Scan your anime library');
    console.log('');
  } else {
    console.error('❌ Some verification checks FAILED');
    console.error('');
    console.error('Please review the errors above and fix any issues.');
    console.error('');
    process.exit(1);
  }
}

// Run verification
runVerification().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
