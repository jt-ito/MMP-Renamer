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
  isProcessing: false,
  queue: []
};

// Separate UDP state so UDP auth/lookups don't queue behind HTTP requests
const udpState = {
  lastRequestTime: 0,
  isProcessing: false,
  queue: []
};

// Constants
const MIN_DELAY_MS = 2500; // 2.5 seconds between ANY AniDB requests
const BULK_OPERATION_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
const BULK_OPERATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CONSISTENT_ACTIVITY_IDLE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Wait for rate limit before making ANY AniDB request
 * This enforces global rate limiting across all processes
 */
async function waitForRateLimit(requestType = 'generic') {
  const state = requestType.startsWith('UDP') ? udpState : globalState;

  return new Promise((resolve) => {
    state.queue.push({ requestType, resolve });
    _processQueue(state);
  });
}

async function _processQueue(state) {
  if (state.isProcessing) return;
  if (state.queue.length === 0) return;

  state.isProcessing = true;
  
  try {
    const { requestType, resolve } = state.queue.shift();
    
    const now = Date.now();
    const timeSinceLastRequest = now - state.lastRequestTime;
    
    if (timeSinceLastRequest < MIN_DELAY_MS) {
      const waitTime = MIN_DELAY_MS - timeSinceLastRequest;
      console.log(`[AniDB Rate Limiter] ${requestType}: waiting ${waitTime}ms (last request was ${timeSinceLastRequest}ms ago)`);
      await new Promise(r => setTimeout(r, waitTime));
    }
    
    state.lastRequestTime = Date.now();

    // Bulk operation pause only applies to HTTP (the high-volume path).
    if (!requestType.startsWith('UDP')) {
      const timeSinceLastForBulk = Date.now() - globalState.lastRequestTime;
      await checkBulkOperationPause(timeSinceLastForBulk);
    }
    
    console.log(`[AniDB Rate Limiter] ${requestType}: cleared to proceed`);
    resolve();
  } finally {
    state.isProcessing = false;
    // Process next item in queue if any
    if (state.queue.length > 0) {
      _processQueue(state);
    }
  }
}

/**
 * Check if we need to pause for bulk operations
 * Pauses for 5 minutes every 30 minutes during bulk operations
 */
async function checkBulkOperationPause(timeSinceLastRequest = Infinity) {
  if (!globalState.bulkOperationStartTime || timeSinceLastRequest > CONSISTENT_ACTIVITY_IDLE_MS) {
    globalState.bulkOperationStartTime = Date.now();
    globalState.requestCount = 1;
    return;
  }

  globalState.requestCount++;
  const elapsedTime = Date.now() - globalState.bulkOperationStartTime;

  if (elapsedTime >= BULK_OPERATION_INTERVAL_MS) {
    console.log('[AniDB Rate Limiter] 30-minute interval reached with consistent activity. Pausing for 5 minutes...');
    await new Promise(resolve => setTimeout(resolve, BULK_OPERATION_PAUSE_MS));

    globalState.bulkOperationStartTime = Date.now();
    globalState.requestCount = 0;
    console.log('[AniDB Rate Limiter] Resuming operations after 5-minute pause.');
  }
}

module.exports = {
  waitForRateLimit
};
