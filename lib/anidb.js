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

const dgram = require('dgram')
const http = require('http')
const https = require('https')
const zlib = require('zlib')
const crypto = require('crypto')
const { computeEd2kHash } = require('./ed2k-hash')
const { waitForRateLimit } = require('./anidb-rate-limiter')

// Pre-compiled regex patterns for performance
const REGEX_TAG_CODE = /^(\d+)\s+(\d+)/
const REGEX_NEWLINE = /\n/
const REGEX_ERROR_TAG = /<error>([^<]+)<\/error>/
const REGEX_SESSION = /^([A-Za-z0-9]+)/

function decodeHttpBodyToUtf8(res, chunks, totalLength) {
  try {
    let buffer = Buffer.concat(chunks, totalLength || 0);
    const encoding = String((res && res.headers && res.headers['content-encoding']) || '').toLowerCase();
    const isGzip = encoding.includes('gzip') || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
    if (isGzip) {
      buffer = zlib.gunzipSync(buffer);
    }
    return buffer.toString('utf8');
  } catch (e) {
    try {
      return Buffer.concat(chunks, totalLength || 0).toString('utf8');
    } catch (ee) {
      return '';
    }
  }
}

// AniDB API endpoints
const ANIDB_HTTP_API = 'http://api.anidb.net:9001/httpapi';
const ANIDB_UDP_HOST = 'api.anidb.net';
const ANIDB_UDP_PORT = 9000;
// Using a generic test client name - should register a proper one for production
const ANIDB_CLIENT_NAME = 'mmprename';
const ANIDB_CLIENT_VERSION = 1;

class AniDBClient {
  constructor(username, password, clientName = ANIDB_CLIENT_NAME, clientVersion = ANIDB_CLIENT_VERSION) {
    this.username = username;
    this.password = password;
    this.clientName = String(clientName || ANIDB_CLIENT_NAME);
    this.clientVersion = Number.isFinite(Number(clientVersion)) ? Number(clientVersion) : ANIDB_CLIENT_VERSION;
    this.sessionKey = null;
    this.udpSocket = null;
    this.udpCallbacks = new Map(); // tag -> callback mapping
    this.nextTag = 1;
  }

  /**
   * Enforce global rate limiting for HTTP requests
   */
  async _waitForHttpRateLimit() {
    await waitForRateLimit('HTTP');
  }

  /**
   * Enforce global rate limiting for UDP requests
   */
  async _waitForUdpRateLimit() {
    await waitForRateLimit('UDP');
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
        const response = buffer.toString('utf8')
        console.log('[AniDB UDP] Response first 200 chars:', response.slice(0, 200))
        
        const lines = response.split(REGEX_NEWLINE)
        const firstLine = lines[0]
        
        console.log('[AniDB UDP] First line:', firstLine)
        console.log('[AniDB UDP] Total lines:', lines.length)
        console.log('[AniDB UDP] Data (lines.slice(1)) length:', lines.slice(1).join('\n').length)
        
        // Extract tag from response
        const tagMatch = firstLine.match(REGEX_TAG_CODE)
        if (!tagMatch) {
          console.error('[AniDB UDP] Invalid response format:', firstLine)
          return
        }

        const tag = tagMatch[1]
        const code = tagMatch[2]

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
        client: this.clientName,
        clientver: this.clientVersion,
        enc: 'UTF8',
        comp: '0'  // Explicitly disable compression
      });

      // Extract session key from response
      const sessionMatch = result.data.match(REGEX_SESSION)
      if (sessionMatch) {
        this.sessionKey = sessionMatch[1]
        console.log('[AniDB] UDP authentication successful')
        return this.sessionKey
      } else {
        throw new Error('Failed to extract session key from AUTH response')
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

    const url = `${ANIDB_HTTP_API}?request=file&client=${encodeURIComponent(this.clientName)}&clientver=${encodeURIComponent(String(this.clientVersion))}&protover=1&ed2k=${ed2kHash}&size=${fileSize}`;

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
      const errorMatch = xmlData.match(REGEX_ERROR_TAG)
      if (errorMatch && errorMatch[1].includes('No such file')) {
        return null
      }
      throw new Error(`AniDB HTTP error: ${errorMatch ? errorMatch[1] : 'Unknown error'}`)
    }

    const extractTag = (tag) => {
      const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`)
      const match = xmlData.match(regex)
      return match ? match[1] : null
    }

    return {
      fid: extractTag('fid'),
      aid: extractTag('aid'),
      eid: extractTag('eid'),
  animeTitle: extractTag('anime_title_english') || extractTag('anime_title_romaji'),
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

    const url = `${ANIDB_HTTP_API}?request=anime&client=${encodeURIComponent(this.clientName)}&clientver=${encodeURIComponent(String(this.clientVersion))}&protover=1&aid=${aid}`;

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
            const data = decodeHttpBodyToUtf8(res, chunks, totalLength);
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
   * Get anime info by title using HTTP API
   */
  async getAnimeInfoByTitle(title) {
    await this._waitForHttpRateLimit();

    const query = String(title || '').trim();
    if (!query) {
      throw new Error('AniDB title is required');
    }

    const encodedTitle = encodeURIComponent(query.slice(0, 200));
    const url = `${ANIDB_HTTP_API}?request=anime&client=${encodeURIComponent(this.clientName)}&clientver=${encodeURIComponent(String(this.clientVersion))}&protover=1&aname=${encodedTitle}`;

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
            const data = decodeHttpBodyToUtf8(res, chunks, totalLength);
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
      // Handle both simple tags and CDATA/nested content
      const simpleMatch = xmlData.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
      if (simpleMatch) return simpleMatch[1];
      
      // Try with potential whitespace/newlines
      const complexMatch = xmlData.match(new RegExp(`<${tag}[^>]*>\\s*([^<]+?)\\s*</${tag}>`, 's'));
      return complexMatch ? complexMatch[1].trim() : null;
    };

    const extractAttribute = (tag, attr) => {
      const match = xmlData.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"[^>]*>`));
      return match ? match[1] : null;
    };

    // Extract picture filename - this should be just a filename like "12345.jpg"
    // Try both as a child element <picture>file.jpg</picture> and as an attribute
    // on the root <anime picture="file.jpg"> tag (different API versions differ).
    let picture = extractTag('picture') || extractAttribute('anime', 'picture');
    
    // Check if this anime is restricted (adult content often has restricted flag)
    const isRestricted = xmlData.includes('restricted="true"') || xmlData.includes('restricted="1"');
    
    // Extract anime ID and title for logging context
    const aid = extractTag('aid') || extractAttribute('anime', 'id');
    const title = extractTag('title');
    
    if (!picture) {
      console.log(`[AniDB] No picture found for AID ${aid} (restricted: ${isRestricted})`);
      if (isRestricted) {
        console.log('[AniDB] This appears to be restricted/adult content - AniDB HTTP API may not provide images for such content');
      }
    } else {
      console.log(`[AniDB] Parsed picture for AID ${aid}: ${picture}`);
    }

    return {
      aid: aid,
      title: title,
      type: extractTag('type'),
      episodeCount: extractTag('episodecount'),
      startDate: extractTag('startdate'),
      endDate: extractTag('enddate'),
      description: extractTag('description'),
      picture: picture,
      restricted: isRestricted,
      raw: xmlData
    };
  }
}

  /**
   * Get anime info by AID using the UDP API with user credentials.
   * This returns the picture filename even for series where the HTTP API omits it.
   *
   * Amask breakdown (4 bytes, MSB first):
   *   Byte 1: 0x80 = AID
   *   Byte 2: 0x20 = EnglishName
   *   Byte 3: 0x02 = PicName (picture filename)
   *   Byte 4: 0x00
   *  => amask = "80200200"
   * Response fields (pipe-separated) in amask order: AID | EnglishName | PicName
   */
  async getAnimeInfoByAidUdp(aid) {
    if (!this.username || !this.password) {
      throw new Error('AniDB username and password required for UDP lookup');
    }
    const sessionKey = await this.authenticateUdp();
    await this._waitForUdpRateLimit();

    const amask = '80200200';
    const result = await this._sendUdpCommand('ANIME', {
      s: sessionKey,
      aid: Number(aid),
      amask
    });

    if (!result || !result.data) return null;

    // The data payload is pipe-separated fields matching the amask bit order:
    // AID | EnglishName | PicName
    const fields = String(result.data).split('|');
    const picName = (fields[2] || '').trim();
    const englishName = (fields[1] || '').trim();
    const aidVal = (fields[0] || '').trim();

    return {
      aid: aidVal || String(aid),
      title: englishName || null,
      picture: picName || null,
      restricted: false,
      raw: result.data
    };
  }
}

/**
 * Singleton instance factory
 */
let anidbInstance = null;

function getAniDBClient(username, password, clientName = ANIDB_CLIENT_NAME, clientVersion = ANIDB_CLIENT_VERSION) {
  const normalizedName = String(clientName || ANIDB_CLIENT_NAME);
  const normalizedVersion = Number.isFinite(Number(clientVersion)) ? Number(clientVersion) : ANIDB_CLIENT_VERSION;
  if (!anidbInstance || anidbInstance.username !== username || anidbInstance.password !== password || anidbInstance.clientName !== normalizedName || anidbInstance.clientVersion !== normalizedVersion) {
    anidbInstance = new AniDBClient(username, password, normalizedName, normalizedVersion);
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
