/**
 * AniDB UDP API Client - Full Implementation
 * 
 * Implements AniDB UDP protocol with:
 * - Proper authentication and session management
 * - Multi-hash support (ED2K, SHA1, MD5, CRC32)
 * - Rate limiting and throttling
 * - Error handling and automatic retry
 * - Session persistence and auto-reconnect
 * 
 * Based on AniDB UDP API documentation and ShokoServer implementation
 */

const dgram = require('dgram');
const crypto = require('crypto');
const zlib = require('zlib');
const { computeEd2kHash } = require('./ed2k-hash');
const fs = require('fs');

// AniDB UDP Configuration
const ANIDB_UDP_HOST = 'api.anidb.net';
const ANIDB_UDP_PORT = 9000;
const ANIDB_PROTOCOL_VERSION = 3;

// Rate Limiting (AniDB requirements)
const RATE_LIMIT_COMMAND = 2000;      // 2 seconds between commands
const RATE_LIMIT_FILE = 4000;         // 4 seconds between FILE lookups
const RATE_LIMIT_FLOOD_PROTECTION = 4000; // General flood protection

// Timeouts
const COMMAND_TIMEOUT = 30000;        // 30 seconds for command response
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes session validity

// Response codes
const RESPONSE_CODES = {
  // Success
  LOGIN_ACCEPTED: '200',
  LOGIN_ACCEPTED_NEW_VER: '201',
  LOGGED_OUT: '203',
  FILE: '220',
  MYLIST: '221',
  
  // Client errors
  LOGIN_FAILED: '500',
  ACCESS_DENIED: '505',
  INVALID_SESSION: '501',
  
  // File errors
  NO_SUCH_FILE: '320',
  NO_SUCH_ANIME: '330',
  
  // Server errors
  BANNED: '555',
  UNKNOWN_COMMAND: '598',
  INTERNAL_ERROR: '600',
  OUT_OF_SERVICE: '601',
  SERVER_BUSY: '602'
};

class AniDBUDPClient {
  constructor(username, password, clientName = 'mmprename', clientVersion = 1) {
    this.username = username;
    this.password = password;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    
    this.socket = null;
    this.sessionKey = null;
    this.sessionExpiry = null;
    
    this.lastCommandTime = 0;
    this.lastFileCommandTime = 0;
    
    this.pendingCallbacks = new Map();
    this.nextTag = 1;
    
    this.loggedIn = false;
    this.banned = false;
    this.banExpiry = null;
  }

  /**
   * Initialize UDP socket
   */
  _initSocket() {
    if (this.socket) return;
    
    this.socket = dgram.createSocket('udp4');
    
    this.socket.on('message', (msg, rinfo) => {
      this._handleResponse(msg, rinfo);
    });
    
    this.socket.on('error', (err) => {
      console.error('[AniDB UDP] Socket error:', err);
    });
    
    console.log('[AniDB UDP] Socket initialized');
  }

  /**
   * Handle incoming UDP response
   */
  _handleResponse(buffer, rinfo) {
    try {
      // Check if response is gzipped
      let data = buffer;
      if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        console.log('[AniDB UDP] Decompressing gzipped response');
        data = zlib.gunzipSync(buffer);
      }
      
      const response = data.toString('utf8').trim();
      console.log('[AniDB UDP] Response:', response.slice(0, 200));
      
      // Parse response: {tag} {code} {data}
      // Note: Sometimes AniDB echoes command params, so we need to find the response code
      const lines = response.split('\n');
      const firstLine = lines[0];
      
      // Try standard format first: tag code data
      let match = firstLine.match(/^(\d+)\s+(\d{3})\s*(.*)$/);
      
      // If that fails, try to find a 3-digit code anywhere in the line after the tag
      if (!match) {
        const tagMatch = firstLine.match(/^(\d+)\s+/);
        if (tagMatch) {
          const tag = tagMatch[1];
          const afterTag = firstLine.substring(tagMatch[0].length);
          const codeMatch = afterTag.match(/(\d{3})\s+(.*?)$/);
          if (codeMatch) {
            match = [firstLine, tag, codeMatch[1], codeMatch[2]];
          }
        }
      }
      
      if (!match) {
        console.error('[AniDB UDP] Invalid response format:', firstLine);
        return;
      }
      
      const tag = match[1];
      const code = match[2];
      const dataLine = match[3] || '';
      
      // Get callback for this tag
      const callback = this.pendingCallbacks.get(tag);
      if (!callback) {
        console.log('[AniDB UDP] No callback for tag:', tag);
        return;
      }
      
      this.pendingCallbacks.delete(tag);
      
      // Check for error codes
      if (code === RESPONSE_CODES.BANNED) {
        this.banned = true;
        this.banExpiry = Date.now() + (30 * 60 * 1000); // Assume 30 min ban
        callback(new Error('AniDB banned this client'));
        return;
      }
      
      if (code === RESPONSE_CODES.INVALID_SESSION) {
        this.sessionKey = null;
        this.loggedIn = false;
        callback(new Error('Session expired'));
        return;
      }
      
      // Success response
      callback(null, {
        code,
        data: dataLine,
        fullResponse: response
      });
      
    } catch (err) {
      console.error('[AniDB UDP] Error handling response:', err);
    }
  }

  /**
   * Send UDP command with rate limiting
   */
  async _sendCommand(command, params = {}, isFileCommand = false) {
    this._initSocket();
    
    // Check ban status
    if (this.banned && Date.now() < this.banExpiry) {
      throw new Error('Client is banned from AniDB');
    }
    
    // Rate limiting
    const now = Date.now();
    const timeSinceLastCommand = now - this.lastCommandTime;
    const timeSinceLastFile = now - this.lastFileCommandTime;
    
    let waitTime = 0;
    if (isFileCommand) {
      waitTime = Math.max(0, RATE_LIMIT_FILE - timeSinceLastFile);
    } else {
      waitTime = Math.max(0, RATE_LIMIT_COMMAND - timeSinceLastCommand);
    }
    
    if (waitTime > 0) {
      console.log(`[AniDB UDP] Rate limiting: waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Build command
    const tag = String(this.nextTag++);
    const encodedParams = [`tag=${encodeURIComponent(tag)}`];

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        // URL-encode parameter values to handle special characters (&, =, spaces, etc.)
        const encodedValue = encodeURIComponent(value);
        encodedParams.push(`${key}=${encodedValue}`);
      }
    }

    const paramString = encodedParams.join('&');
    const cmd = paramString ? `${command} ${paramString}` : command;

    console.log('[AniDB UDP] Sending:', cmd.slice(0, 150));
    
    // Update rate limit timestamps
    this.lastCommandTime = Date.now();
    if (isFileCommand) {
      this.lastFileCommandTime = Date.now();
    }
    
    // Send command
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(tag);
        reject(new Error('AniDB command timeout'));
      }, COMMAND_TIMEOUT);
      
      this.pendingCallbacks.set(tag, (err, result) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
      
      const buffer = Buffer.from(cmd, 'utf8');
      this.socket.send(buffer, 0, buffer.length, ANIDB_UDP_PORT, ANIDB_UDP_HOST, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pendingCallbacks.delete(tag);
          reject(err);
        }
      });
    });
  }

  /**
   * Login to AniDB
   */
  async loginToAniDB() {
    if (this.loggedIn && this.sessionKey && Date.now() < this.sessionExpiry) {
      console.log('[AniDB UDP] Already logged in, session valid');
      return this.sessionKey;
    }
    
    console.log('[AniDB UDP] Logging in...');
    
    const response = await this._sendCommand('AUTH', {
      user: this.username,
      pass: this.password,
      protover: ANIDB_PROTOCOL_VERSION,
      client: this.clientName,
      clientver: this.clientVersion,
      enc: 'UTF8'
    });
    
    if (response.code === RESPONSE_CODES.LOGIN_ACCEPTED || 
        response.code === RESPONSE_CODES.LOGIN_ACCEPTED_NEW_VER) {
      
      // Extract session key from response data
      const sessionMatch = response.data.match(/^(\S+)/);
      if (sessionMatch) {
        this.sessionKey = sessionMatch[1];
        this.loggedIn = true;
        this.sessionExpiry = Date.now() + SESSION_TIMEOUT;
        console.log('[AniDB UDP] Login successful, session:', this.sessionKey.slice(0, 8) + '...');
        return this.sessionKey;
      }
    }
    
    if (response.code === RESPONSE_CODES.LOGIN_FAILED) {
      throw new Error('AniDB login failed: Invalid credentials');
    }
    
    if (response.code === RESPONSE_CODES.ACCESS_DENIED) {
      throw new Error('AniDB login failed: Client not registered or access denied');
    }
    
    throw new Error(`AniDB login failed: ${response.code} ${response.data}`);
  }

  /**
   * Logout from AniDB
   */
  async logout() {
    if (!this.sessionKey) return;
    
    try {
      await this._sendCommand('LOGOUT', { s: this.sessionKey });
      console.log('[AniDB UDP] Logged out successfully');
    } catch (err) {
      console.error('[AniDB UDP] Logout error:', err.message);
    } finally {
      this.sessionKey = null;
      this.loggedIn = false;
      if (this.socket) {
        this.socket.close();
        this.socket = null;
      }
    }
  }

  /**
   * Compute file hashes (ED2K, SHA1, MD5, CRC32)
   */
  async hashFile(filepath) {
    console.log('[AniDB Hash] Computing hashes for:', filepath);
    
    const stats = fs.statSync(filepath);
    const fileSize = stats.size;
    
    // Compute ED2K hash
    const ed2kHash = await computeEd2kHash(filepath);
    console.log('[AniDB Hash] ED2K:', ed2kHash);
    
    // Compute other hashes in parallel with streaming
    const sha1Hash = crypto.createHash('sha1');
    const md5Hash = crypto.createHash('md5');
    let crc32 = 0;
    
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filepath, { highWaterMark: 1024 * 1024 });
      
      stream.on('data', (chunk) => {
        sha1Hash.update(chunk);
        md5Hash.update(chunk);
        
        // CRC32 calculation
        for (let i = 0; i < chunk.length; i++) {
          crc32 = (crc32 >>> 8) ^ CRC32_TABLE[(crc32 ^ chunk[i]) & 0xff];
        }
      });
      
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    
    const sha1 = sha1Hash.digest('hex');
    const md5 = md5Hash.digest('hex');
    crc32 = (crc32 ^ 0xffffffff) >>> 0;
    
    console.log('[AniDB Hash] SHA1:', sha1);
    console.log('[AniDB Hash] MD5:', md5);
    console.log('[AniDB Hash] CRC32:', crc32.toString(16));
    
    return {
      ed2k: ed2kHash,
      sha1,
      md5,
      crc32: crc32.toString(16),
      size: fileSize
    };
  }

  /**
   * Lookup file by ED2K hash
   */
  async lookupFile(ed2kHash, fileSize) {
    // Ensure we're logged in
    if (!this.sessionKey) {
      await this.loginToAniDB();
    }
    
    console.log('[AniDB UDP] Looking up file:', ed2kHash, 'size:', fileSize);
    
    try {
      const response = await this._sendCommand('FILE', {
        s: this.sessionKey,
        size: fileSize,
        ed2k: ed2kHash,
        fmask: '7FF8FEF8',  // Request comprehensive file data
        amask: 'F2F0E0FC'   // Request comprehensive anime data
      }, true); // isFileCommand = true for stricter rate limiting
      
      if (response.code === RESPONSE_CODES.FILE) {
        return this._parseFileResponse(response.data);
      }
      
      if (response.code === RESPONSE_CODES.NO_SUCH_FILE) {
        console.log('[AniDB UDP] File not found in AniDB');
        return null;
      }
      
      if (response.code === RESPONSE_CODES.INVALID_SESSION) {
        // Session expired, retry once
        this.sessionKey = null;
        await this.loginToAniDB();
        return this.lookupFile(ed2kHash, fileSize);
      }
      
      throw new Error(`AniDB file lookup failed: ${response.code}`);
      
    } catch (err) {
      console.error('[AniDB UDP] Lookup error:', err.message);
      throw err;
    }
  }

  /**
   * Parse FILE command response
   */
  _parseFileResponse(data) {
    console.log('[AniDB Parse] Raw data:', data.slice(0, 200));
    
    const fields = data.split('|');
    console.log('[AniDB Parse] Field count:', fields.length);
    
    // Log first 20 fields
    for (let i = 0; i < Math.min(fields.length, 20); i++) {
      console.log(`[AniDB Parse] Field[${i}]:`, fields[i]);
    }
    
    // Parse according to fmask/amask specification
    return {
      fid: fields[0],
      aid: fields[1],
      eid: fields[2],
      gid: fields[3],
      mylistId: fields[4],
      otherEpisodes: fields[5],
      isDeprecated: fields[6],
      state: fields[7],
      size: fields[8],
      ed2k: fields[9],
      md5: fields[10],
      sha1: fields[11],
      crc32: fields[12],
      // Video info
      videoColorDepth: fields[13],
      // Anime titles
      animeRomajiName: fields[14],
      animeKanjiName: fields[15],
      animeEnglishName: fields[16],
      // Episode info
      episodeNumber: fields[17],
      episodeEnglishName: fields[18],
      episodeRomajiName: fields[19],
      episodeKanjiName: fields[20],
      // Group
      groupName: fields[21],
      groupShortName: fields[22],
      // Additional metadata
      dateAidRecord: fields[23],
      raw: data
    };
  }
}

// CRC32 lookup table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC32_TABLE[i] = crc;
}

// Singleton instance
let anidbClientInstance = null;

function getAniDBUDPClient(username, password, clientName, clientVersion) {
  // Recreate instance if credentials or client info changed
  if (!anidbClientInstance || 
      anidbClientInstance.username !== username ||
      anidbClientInstance.clientName !== clientName ||
      anidbClientInstance.clientVersion !== clientVersion) {
    anidbClientInstance = new AniDBUDPClient(username, password, clientName, clientVersion);
  }
  return anidbClientInstance;
}

module.exports = {
  AniDBUDPClient,
  getAniDBUDPClient,
  RESPONSE_CODES
};
