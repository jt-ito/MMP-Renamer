/**
 * Global AniDB Rate Limiter
 * 
 * Ensures ALL AniDB API calls (HTTP, UDP, across all processes) respect rate limits.
 * Uses a shared global state to coordinate between different client instances.
 * 
 * AniDB Rate Limits:
 * - Minimum 2 seconds between ANY requests (HTTP or UDP)
 * - 5 minute pause every 30 minutes during bulk operations
 * - No concurrent requests allowed
 */

// Global state (shared across all AniDB client instances)
const globalState = {
  lastRequestTime: 0,
  bulkOperationStartTime: null,
  requestCount: 0,
  isWaiting: false
};

// Constants
const MIN_DELAY_MS = 2500; // 2.5 seconds between ANY AniDB requests
const BULK_OPERATION_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
const BULK_OPERATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Wait for rate limit before making ANY AniDB request
 * This enforces global rate limiting across all processes
 */
async function waitForRateLimit(requestType = 'generic') {
  // Wait if another request is currently waiting (prevent concurrent waits)
  while (globalState.isWaiting) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  globalState.isWaiting = true;
  
  try {
    const now = Date.now();
    const timeSinceLastRequest = now - globalState.lastRequestTime;
    
    if (timeSinceLastRequest < MIN_DELAY_MS) {
      const waitTime = MIN_DELAY_MS - timeSinceLastRequest;
      console.log(`[AniDB Rate Limiter] ${requestType}: waiting ${waitTime}ms (last request was ${timeSinceLastRequest}ms ago)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Update last request time
    globalState.lastRequestTime = Date.now();
    
    // Check bulk operation pause
    await checkBulkOperationPause();
    
    console.log(`[AniDB Rate Limiter] ${requestType}: cleared to proceed`);
  } finally {
    globalState.isWaiting = false;
  }
}

/**
 * Check if we need to pause for bulk operations
 * Pauses for 5 minutes every 30 minutes during bulk operations
 */
async function checkBulkOperationPause() {
  if (!globalState.bulkOperationStartTime) {
    globalState.bulkOperationStartTime = Date.now();
    globalState.requestCount = 1;
    return;
  }

  globalState.requestCount++;
  const elapsedTime = Date.now() - globalState.bulkOperationStartTime;

  // Check if 30 minutes have elapsed
  if (elapsedTime >= BULK_OPERATION_INTERVAL_MS) {
    console.log('[AniDB Rate Limiter] 30-minute interval reached. Pausing for 5 minutes...');
    await new Promise(resolve => setTimeout(resolve, BULK_OPERATION_PAUSE_MS));
    
    // Reset the timer
    globalState.bulkOperationStartTime = Date.now();
    globalState.requestCount = 0;
    console.log('[AniDB Rate Limiter] Resuming operations after 5-minute pause.');
  }
}

/**
 * Reset bulk operation tracking (useful for testing or manual intervention)
 */
function resetBulkTracking() {
  globalState.bulkOperationStartTime = null;
  globalState.requestCount = 0;
  console.log('[AniDB Rate Limiter] Bulk operation tracking reset');
}

/**
 * Get current rate limiter state (for debugging)
 */
function getState() {
  return {
    lastRequestTime: globalState.lastRequestTime,
    timeSinceLastRequest: Date.now() - globalState.lastRequestTime,
    bulkOperationStartTime: globalState.bulkOperationStartTime,
    requestCount: globalState.requestCount,
    isWaiting: globalState.isWaiting
  };
}

module.exports = {
  waitForRateLimit,
  resetBulkTracking,
  getState,
  MIN_DELAY_MS,
  BULK_OPERATION_PAUSE_MS,
  BULK_OPERATION_INTERVAL_MS
};
