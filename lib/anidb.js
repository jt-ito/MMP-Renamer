/**
 * AniDB API Client
 * 
 * Implements both HTTP and UDP APIs for AniDB with:
 * - ED2K file hash lookup
 * - Anime metadata retrieval
 * - Rate limiting per AniDB guidelines
 * - Bulk operation pause (5 min every 30 min)
 * - Authentication support
 * 
 * AniDB API Rate Limits:
 * - HTTP: No more than 1 request per 2 seconds
 * - UDP: No more than 0.5 packets per second (1 packet per 2 seconds)
 * - HTTP ban triggers after sustained abuse
 * - UDP ban triggers after 20 packets in <20 seconds
 */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { computeEd2kHash } = require('./ed2k-hash');

// AniDB API endpoints
const ANIDB_HTTP_API = 'http://api.anidb.net:9001/httpapi';
const ANIDB_UDP_HOST = 'api.anidb.net';
const ANIDB_UDP_PORT = 9000;
// Using a generic test client name - should register a proper one for production
const ANIDB_CLIENT_NAME = 'test';
const ANIDB_CLIENT_VERSION = 1;

// Rate limiting constants (conservative to avoid bans)
const HTTP_MIN_DELAY_MS = 2500; // 2.5 seconds between HTTP requests (safer than 2s minimum)
const UDP_MIN_DELAY_MS = 2500; // 2.5 seconds between UDP packets
const BULK_OPERATION_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
const BULK_OPERATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

class AniDBClient {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.sessionKey = null;
    this.lastHttpRequest = 0;
    this.lastUdpRequest = 0;
    this.bulkOperationStartTime = null;
    this.requestCount = 0;
    this.udpSocket = null;
    this.udpCallbacks = new Map(); // tag -> callback mapping
    this.nextTag = 1;
  }

  /**
   * Enforce rate limiting for HTTP requests
   */
  async _waitForHttpRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastHttpRequest;
    
    if (timeSinceLastRequest < HTTP_MIN_DELAY_MS) {
      const waitTime = HTTP_MIN_DELAY_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastHttpRequest = Date.now();
    await this._checkBulkOperationPause();
  }

  /**
   * Enforce rate limiting for UDP requests
   */
  async _waitForUdpRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastUdpRequest;
    
    if (timeSinceLastRequest < UDP_MIN_DELAY_MS) {
      const waitTime = UDP_MIN_DELAY_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastUdpRequest = Date.now();
    await this._checkBulkOperationPause();
  }

  /**
   * Check if we need to pause for bulk operations
   * Pauses for 5 minutes every 30 minutes during bulk operations
   */
  async _checkBulkOperationPause() {
    if (!this.bulkOperationStartTime) {
      this.bulkOperationStartTime = Date.now();
      this.requestCount = 0;
      return;
    }

    this.requestCount++;
    const elapsedTime = Date.now() - this.bulkOperationStartTime;

    // Check if 30 minutes have elapsed
    if (elapsedTime >= BULK_OPERATION_INTERVAL_MS) {
      console.log('[AniDB] 30-minute interval reached. Pausing for 5 minutes...');
      await new Promise(resolve => setTimeout(resolve, BULK_OPERATION_PAUSE_MS));
      
      // Reset the timer
      this.bulkOperationStartTime = Date.now();
      this.requestCount = 0;
      console.log('[AniDB] Resuming operations after 5-minute pause.');
    }
  }

  /**
   * Initialize UDP socket
   */
  _initUdpSocket() {
    if (this.udpSocket) return;

    this.udpSocket = dgram.createSocket('udp4');

    this.udpSocket.on('message', (msg, rinfo) => {
      try {
        let buffer = msg;
        const wasCompressed = buffer && buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
        console.log('[AniDB UDP] Received message, length:', buffer.length, 'compressed:', wasCompressed);
        
        if (wasCompressed) {
          try {
            buffer = zlib.gunzipSync(buffer);
            console.log('[AniDB UDP] Decompressed to length:', buffer.length);
          } catch (inflateErr) {
            console.error('[AniDB UDP] Failed to gunzip response:', inflateErr);
            return;
          }
        }
        const response = buffer.toString('utf8');
        console.log('[AniDB UDP] Response first 200 chars:', response.slice(0, 200));
        
        const lines = response.split('\n');
        const firstLine = lines[0];
        
        console.log('[AniDB UDP] First line:', firstLine);
        console.log('[AniDB UDP] Total lines:', lines.length);
        console.log('[AniDB UDP] Data (lines.slice(1)) length:', lines.slice(1).join('\n').length);
        
        // Extract tag from response
        const tagMatch = firstLine.match(/^(\d+)\s+(\d+)/);
        if (!tagMatch) {
          console.error('[AniDB UDP] Invalid response format:', firstLine);
          return;
        }

        const tag = tagMatch[1];
        const code = tagMatch[2];

        const callback = this.udpCallbacks.get(tag);
        if (callback) {
          this.udpCallbacks.delete(tag);
          
          // Parse response based on code
          if (code.startsWith('2')) {
            // Success codes (2xx)
            // FILE responses format: "{tag} {code} FILE {data}"
            // AUTH responses format: "{tag} {code} {sessionkey} ..."
            // Extract everything after the code (may include response type like FILE)
            const afterCode = firstLine.substring(firstLine.indexOf(code) + code.length).trim();
            console.log('[AniDB UDP] After code:', afterCode.slice(0, 100));
            
            // For FILE responses, skip the "FILE" keyword
            let dataToPass = afterCode;
            if (afterCode.startsWith('FILE ')) {
              dataToPass = afterCode.substring(5);
            }
            
            console.log('[AniDB UDP] Passing data to callback, length:', dataToPass.length);
            console.log('[AniDB UDP] Data preview:', dataToPass.slice(0, 100));
            callback(null, { code, data: dataToPass, raw: response });
          } else {
            // Error codes
            callback(new Error(`AniDB error ${code}: ${lines.join(' ')}`), null);
          }
        }
      } catch (err) {
        console.error('[AniDB UDP] Error processing message:', err);
      }
    });

    this.udpSocket.on('error', (err) => {
      console.error('[AniDB UDP] Socket error:', err);
    });
  }

  /**
   * Send UDP command to AniDB
   */
  async _sendUdpCommand(command, params = {}) {
    await this._waitForUdpRateLimit();
    this._initUdpSocket();

    const tag = String(this.nextTag++);
    
    // Build command string - format: COMMAND tag=X param1=val1 param2=val2
    let cmd = `${command} tag=${tag}`;
    for (const [key, value] of Object.entries(params)) {
      cmd += ` ${key}=${value}`;
    }
    
    console.log('[AniDB UDP] Sending command:', cmd.slice(0, 150));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.udpCallbacks.delete(tag);
        console.error('[AniDB UDP] Command timeout, tag:', tag);
        reject(new Error('AniDB UDP request timeout'));
      }, 30000); // 30 second timeout

      this.udpCallbacks.set(tag, (err, result) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(result);
      });

      const message = Buffer.from(cmd, 'utf8');
      console.log('[AniDB UDP] Message buffer length:', message.length);
      this.udpSocket.send(message, 0, message.length, ANIDB_UDP_PORT, ANIDB_UDP_HOST, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.udpCallbacks.delete(tag);
          reject(err);
        }
      });
    });
  }

  /**
   * Authenticate with AniDB UDP API
   */
  async authenticateUdp() {
    if (this.sessionKey) {
      return this.sessionKey;
    }

    if (!this.username || !this.password) {
      throw new Error('AniDB username and password required');
    }

    try {
      const result = await this._sendUdpCommand('AUTH', {
        user: this.username,
        pass: this.password,
        protover: 3,
        client: ANIDB_CLIENT_NAME,
        clientver: ANIDB_CLIENT_VERSION,
        enc: 'UTF8',
        comp: '0'  // Explicitly disable compression
      });

      // Extract session key from response
      const sessionMatch = result.data.match(/^([A-Za-z0-9]+)/);
      if (sessionMatch) {
        this.sessionKey = sessionMatch[1];
        console.log('[AniDB] UDP authentication successful');
        return this.sessionKey;
      } else {
        throw new Error('Failed to extract session key from AUTH response');
      }
    } catch (err) {
      console.error('[AniDB] Authentication failed:', err);
      throw err;
    }
  }

  /**
   * Logout from AniDB UDP API
   */
  async logoutUdp() {
    if (!this.sessionKey) return;

    try {
      await this._sendUdpCommand('LOGOUT', { s: this.sessionKey });
      console.log('[AniDB] UDP logout successful');
    } catch (err) {
      console.error('[AniDB] Logout failed:', err);
    } finally {
      this.sessionKey = null;
      if (this.udpSocket) {
        this.udpSocket.close();
        this.udpSocket = null;
      }
    }
  }

  /**
   * Look up file by ED2K hash using UDP API
   */
  async lookupFileByHash(ed2kHash, fileSize) {
    await this.authenticateUdp();

    try {
      const result = await this._sendUdpCommand('FILE', {
        s: this.sessionKey,
        size: fileSize,
        ed2k: ed2kHash,
        fmask: 'f7f8fef8',
        amask: 'f2f0e0fc'
      });

      // Parse file info from response
      return this._parseFileResponse(result.data);
    } catch (err) {
      if (err.message.includes('320') || err.message.includes('NO SUCH FILE')) {
        // File not found in AniDB
        return null;
      }
      throw err;
    }
  }

  /**
   * Look up file by path hash using HTTP API
   */
  async lookupFileByPathHttp(filePath) {
    const ed2kHash = await computeEd2kHash(filePath);
    const stats = require('fs').statSync(filePath);
    const fileSize = stats.size;

    return this.lookupFileByHashHttp(ed2kHash, fileSize);
  }

  /**
   * Look up file by ED2K hash using HTTP API (fallback)
   */
  async lookupFileByHashHttp(ed2kHash, fileSize) {
    await this._waitForHttpRateLimit();

    const url = `${ANIDB_HTTP_API}?request=file&client=${ANIDB_CLIENT_NAME}&clientver=${ANIDB_CLIENT_VERSION}&protover=1&ed2k=${ed2kHash}&size=${fileSize}`;

    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        const chunks = [];
        let totalLength = 0;

        res.on('data', (chunk) => {
          chunks.push(chunk);
          totalLength += chunk.length;
        });

        res.on('end', () => {
          try {
            let buffer = Buffer.concat(chunks, totalLength);
            console.log('[AniDB HTTP] Response length:', buffer.length, 'encoding:', res.headers['content-encoding']);
            
            // Check if response is gzipped
            if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
              console.log('[AniDB HTTP] Decompressing gzipped response');
              buffer = zlib.gunzipSync(buffer);
              console.log('[AniDB HTTP] Decompressed length:', buffer.length);
            }
            
            const data = buffer.toString('utf8');
            console.log('[AniDB HTTP] Response first 200 chars:', data.slice(0, 200));
            
            const result = this._parseHttpFileResponse(data);
            resolve(result);
          } catch (err) {
            console.error('[AniDB HTTP] Parse error:', err);
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('AniDB HTTP request timeout'));
      });
    });
  }

  /**
   * Parse UDP FILE response
   */
  _parseFileResponse(data) {
    console.log('[AniDB] _parseFileResponse input length:', data ? data.length : 0);
    console.log('[AniDB] _parseFileResponse first 200 chars:', data ? data.slice(0, 200) : '<empty>');
    
    if (!data || typeof data !== 'string') {
      console.log('[AniDB] _parseFileResponse received invalid data type:', typeof data);
      return null;
    }
    
    const fields = data.split('|');
    
    console.log('[AniDB] _parseFileResponse fields count:', fields.length);
    
    // Log all fields for debugging
    for (let i = 0; i < Math.min(fields.length, 20); i++) {
      console.log(`[AniDB] _parseFileResponse field[${i}]:`, fields[i]);
    }
    
    if (fields.length === 0) {
      return null;
    }

    return {
      fid: fields[0],
      aid: fields[1],
      eid: fields[2],
      gid: fields[3],
      lid: fields[4],
      status: fields[5],
      size: fields[6],
      ed2k: fields[7],
      anidbFileName: fields[8],
      episodeNumber: fields[9],
      episodeName: fields[10],
      animeTitle: fields[11],
      episodeKanji: fields[12],
      episodeRomaji: fields[13],
      group: fields[14],
      raw: data
    };
  }

  /**
   * Parse HTTP FILE response (XML format)
   */
  _parseHttpFileResponse(xmlData) {
    // Simple XML parsing for file info
    // In production, use a proper XML parser like xml2js
    
    if (xmlData.includes('<error>')) {
      const errorMatch = xmlData.match(/<error>([^<]+)<\/error>/);
      if (errorMatch && errorMatch[1].includes('No such file')) {
        return null;
      }
      throw new Error(`AniDB HTTP error: ${errorMatch ? errorMatch[1] : 'Unknown error'}`);
    }

    const extractTag = (tag) => {
      const match = xmlData.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
      return match ? match[1] : null;
    };

    return {
      fid: extractTag('fid'),
      aid: extractTag('aid'),
      eid: extractTag('eid'),
      animeTitle: extractTag('anime_title_romaji') || extractTag('anime_title_english'),
      episodeNumber: extractTag('episode_number'),
      episodeName: extractTag('episode_title_romaji') || extractTag('episode_title_english'),
      group: extractTag('group_name'),
      raw: xmlData
    };
  }

  /**
   * Get anime info by AID using HTTP API
   */
  async getAnimeInfo(aid) {
    await this._waitForHttpRateLimit();

    const url = `${ANIDB_HTTP_API}?request=anime&client=${ANIDB_CLIENT_NAME}&clientver=${ANIDB_CLIENT_VERSION}&protover=1&aid=${aid}`;

    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result = this._parseHttpAnimeResponse(data);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('AniDB HTTP request timeout'));
      });
    });
  }

  /**
   * Parse HTTP ANIME response
   */
  _parseHttpAnimeResponse(xmlData) {
    if (xmlData.includes('<error>')) {
      const errorMatch = xmlData.match(/<error>([^<]+)<\/error>/);
      throw new Error(`AniDB HTTP error: ${errorMatch ? errorMatch[1] : 'Unknown error'}`);
    }

    const extractTag = (tag) => {
      const match = xmlData.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
      return match ? match[1] : null;
    };

    return {
      aid: extractTag('aid'),
      title: extractTag('title'),
      type: extractTag('type'),
      episodeCount: extractTag('episodecount'),
      startDate: extractTag('startdate'),
      endDate: extractTag('enddate'),
      description: extractTag('description'),
      raw: xmlData
    };
  }
}

/**
 * Singleton instance factory
 */
let anidbInstance = null;

function getAniDBClient(username, password) {
  if (!anidbInstance || anidbInstance.username !== username) {
    anidbInstance = new AniDBClient(username, password);
  }
  return anidbInstance;
}

module.exports = {
  AniDBClient,
  getAniDBClient,
  ANIDB_HTTP_API,
  ANIDB_UDP_HOST,
  ANIDB_UDP_PORT
};
