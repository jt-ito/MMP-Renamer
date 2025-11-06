/*
 ED2K / AniDB hashing:
 - Fixed chunk size 9,728,000 bytes.
 - For each chunk compute MD4 digest (16 bytes).
 - If file fits in one chunk return that chunk's MD4 hex (lowercase).
 - If multiple chunks, compute MD4 over the raw concatenation of all 16-byte chunk digests and return its hex (lowercase).
 - Empty file => MD4 of zero bytes.
 - Implementation must stream the file, not load full file into RAM.
 - MD4 implementation uses Node.js crypto module (deprecated but available for legacy hash compatibility).
 - Include unit tests / known test vectors and a small verification harness.
*/

const crypto = require('crypto');
const fs = require('fs');

// ED2K canonical chunk size: 9,728,000 bytes (9500 KiB)
const ED2K_CHUNK_SIZE = 9728000;

/**
 * Compute MD4 hash of a buffer
 * @param {Buffer} data - Data to hash
 * @returns {Buffer} - 16-byte MD4 digest
 */
function computeMD4(data) {
  const hash = crypto.createHash('md4');
  hash.update(data);
  return hash.digest();
}

/**
 * Compute ED2K (AniDB/Shoko) file hash
 * 
 * Algorithm:
 * 1. Split file into chunks of 9,728,000 bytes
 * 2. Compute MD4 hash for each chunk
 * 3. If single chunk: return that chunk's MD4 as hex
 * 4. If multiple chunks: compute MD4 of concatenated chunk MD4 digests
 * 
 * @param {string|fs.ReadStream} filePathOrStream - File path or readable stream
 * @returns {Promise<string>} - 32-character lowercase hex hash
 */
async function computeEd2kHash(filePathOrStream) {
  return new Promise((resolve, reject) => {
    // Determine if we have a path or stream
    let stream;
    let shouldCloseStream = false;
    
    if (typeof filePathOrStream === 'string') {
      // It's a file path
      if (!fs.existsSync(filePathOrStream)) {
        return reject(new Error(`File not found: ${filePathOrStream}`));
      }
      stream = fs.createReadStream(filePathOrStream, { highWaterMark: ED2K_CHUNK_SIZE });
      shouldCloseStream = true;
    } else {
      // Assume it's a readable stream
      stream = filePathOrStream;
    }

    const chunkDigests = [];
    let currentChunk = Buffer.alloc(0);
    let totalBytesRead = 0;

    stream.on('data', (data) => {
      totalBytesRead += data.length;
      currentChunk = Buffer.concat([currentChunk, data]);

      // Process complete chunks
      while (currentChunk.length >= ED2K_CHUNK_SIZE) {
        const chunk = currentChunk.slice(0, ED2K_CHUNK_SIZE);
        const digest = computeMD4(chunk);
        chunkDigests.push(digest);
        currentChunk = currentChunk.slice(ED2K_CHUNK_SIZE);
      }
    });

    stream.on('end', () => {
      try {
        // Process any remaining data as the final chunk
        if (currentChunk.length > 0) {
          const digest = computeMD4(currentChunk);
          chunkDigests.push(digest);
        }

        // Handle empty file case
        if (chunkDigests.length === 0) {
          const emptyDigest = computeMD4(Buffer.alloc(0));
          return resolve(emptyDigest.toString('hex').toLowerCase());
        }

        // Single chunk case
        if (chunkDigests.length === 1) {
          return resolve(chunkDigests[0].toString('hex').toLowerCase());
        }

        // Multiple chunks: compute MD4 of concatenated chunk digests
        const concatenatedDigests = Buffer.concat(chunkDigests);
        const finalDigest = computeMD4(concatenatedDigests);
        return resolve(finalDigest.toString('hex').toLowerCase());

      } catch (err) {
        reject(err);
      } finally {
        if (shouldCloseStream && stream.destroy) {
          stream.destroy();
        }
      }
    });

    stream.on('error', (err) => {
      if (shouldCloseStream && stream.destroy) {
        stream.destroy();
      }
      reject(err);
    });
  });
}

/**
 * Compute ED2K hash synchronously (for smaller files where memory isn't a concern)
 * @param {string} filePath - Path to file
 * @returns {string} - 32-character lowercase hex hash
 */
function computeEd2kHashSync(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  // Handle empty file
  if (fileSize === 0) {
    return computeMD4(Buffer.alloc(0)).toString('hex').toLowerCase();
  }

  const fd = fs.openSync(filePath, 'r');
  const chunkDigests = [];

  try {
    let bytesRead = 0;
    const buffer = Buffer.alloc(ED2K_CHUNK_SIZE);

    while (bytesRead < fileSize) {
      const readSize = Math.min(ED2K_CHUNK_SIZE, fileSize - bytesRead);
      const actualRead = fs.readSync(fd, buffer, 0, readSize, bytesRead);
      
      if (actualRead === 0) break;

      const chunk = buffer.slice(0, actualRead);
      const digest = computeMD4(chunk);
      chunkDigests.push(digest);
      
      bytesRead += actualRead;
    }

    // Single chunk case
    if (chunkDigests.length === 1) {
      return chunkDigests[0].toString('hex').toLowerCase();
    }

    // Multiple chunks: compute MD4 of concatenated chunk digests
    const concatenatedDigests = Buffer.concat(chunkDigests);
    const finalDigest = computeMD4(concatenatedDigests);
    return finalDigest.toString('hex').toLowerCase();

  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  computeEd2kHash,
  computeEd2kHashSync,
  ED2K_CHUNK_SIZE,
  // Export for testing
  computeMD4
};
