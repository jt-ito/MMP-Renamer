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

// Separate UDP state so UDP auth/lookups don't queue behind HTTP requests
const udpState = {
  lastRequestTime: 0,
  isWaiting: false
};

// Constants
const MIN_DELAY_MS = 2500; // 2.5 seconds between ANY AniDB requests
const BULK_OPERATION_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
const BULK_OPERATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
// If there is a gap larger than this between AniDB requests, consider activity interrupted
// and reset the bulk-operation timer. Default to 2 minutes to allow short compliance pauses.
const CONSISTENT_ACTIVITY_IDLE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Wait for rate limit before making ANY AniDB request
 * This enforces global rate limiting across all processes
 */
async function waitForRateLimit(requestType = 'generic') {
  // UDP requests use a separate queue so they don't block behind HTTP requests
  const state = (requestType === 'UDP') ? udpState : globalState;

  // Wait if another request of this type is currently waiting
  while (state.isWaiting) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  state.isWaiting = true;
  
  try {
    const now = Date.now();
    const timeSinceLastRequest = now - state.lastRequestTime;
    
    if (timeSinceLastRequest < MIN_DELAY_MS) {
      const waitTime = MIN_DELAY_MS - timeSinceLastRequest;
      console.log(`[AniDB Rate Limiter] ${requestType}: waiting ${waitTime}ms (last request was ${timeSinceLastRequest}ms ago)`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    state.lastRequestTime = Date.now();

    // Bulk operation pause only applies to HTTP (the high-volume path)
    if (requestType !== 'UDP') {
      const timeSinceLastForBulk = now - globalState.lastRequestTime;
      await checkBulkOperationPause(timeSinceLastForBulk);
    }
    
    console.log(`[AniDB Rate Limiter] ${requestType}: cleared to proceed`);
  } finally {
    state.isWaiting = false;
  }
}

/**
 * Check if we need to pause for bulk operations
 * Pauses for 5 minutes every 30 minutes during bulk operations
 */
async function checkBulkOperationPause(timeSinceLastRequest = Infinity) {
  // If we've been idle for longer than CONSISTENT_ACTIVITY_IDLE_MS, treat this
  // as an interruption to the bulk activity and restart the bulk timer.
  if (!globalState.bulkOperationStartTime || timeSinceLastRequest > CONSISTENT_ACTIVITY_IDLE_MS) {
    globalState.bulkOperationStartTime = Date.now();
    globalState.requestCount = 1;
    return;
  }

  globalState.requestCount++;
  const elapsedTime = Date.now() - globalState.bulkOperationStartTime;

  // Only trigger the periodic pause if we've been actively making requests for
  // the full BULK_OPERATION_INTERVAL_MS without a long idle gap.
  if (elapsedTime >= BULK_OPERATION_INTERVAL_MS) {
    console.log('[AniDB Rate Limiter] 30-minute interval reached with consistent activity. Pausing for 5 minutes...');
    await new Promise(resolve => setTimeout(resolve, BULK_OPERATION_PAUSE_MS));

    // Reset the timer after pause
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
