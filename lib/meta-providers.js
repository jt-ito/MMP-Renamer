/**
 * Meta Providers Module
 * 
 * Provides unified metadata lookup with multiple provider fallback chain:
 * 1. AniDB (via ED2K hash lookup) - Primary for anime
 * 2. Existing provider chain (AniList -> TVDb -> TMDb) - Fallback
 * 
 * This module wraps the existing metaLookup with AniDB hash-based lookup first
 */

let computeEd2kHash = null;
let getAniDBClient = null;

try {
  const ed2kModule = require('./ed2k-hash');
  computeEd2kHash = ed2kModule.computeEd2kHash;
} catch (e) {
  console.error('[MetaProviders] Failed to load ed2k-hash module:', e.message);
}

try {
  const anidbModule = require('./anidb');
  getAniDBClient = anidbModule.getAniDBClient;
} catch (e) {
  console.error('[MetaProviders] Failed to load anidb module:', e.message);
}

const fs = require('fs');
const path = require('path');

/**
 * Enhanced metadata lookup with AniDB ED2K hash support
 * 
 * @param {string} filePath - Full path to the file being enriched
 * @param {string} title - Parsed title from filename
 * @param {object} opts - Options including:
 *   - anidb_username: AniDB username
 *   - anidb_password: AniDB password
 *   - season: Season number
 *   - episode: Episode number
 *   - year: Release year
 *   - force: Force refresh
 *   - fallbackMetaLookup: The existing metaLookup function to use as fallback
 *   - tmdbApiKey: TMDb API key for fallback
 * @returns {Promise<object|null>} Metadata result or null
 */
async function lookupMetadataWithAniDB(filePath, title, opts = {}) {
  const result = {
    provider: null,
    id: null,
    name: null,
    episodeTitle: null,
    episodeNumber: null,
    seasonNumber: null,
    raw: null,
    source: null
  };

  // Try AniDB ED2K hash lookup first if credentials are available
  if (opts.anidb_username && opts.anidb_password && filePath && fs.existsSync(filePath)) {
    // Check if required modules are available
    if (!computeEd2kHash) {
      console.error('[MetaProviders] ED2K hash module not available, skipping AniDB lookup');
      try {
        const testRequire = require('./ed2k-hash');
        console.error('[MetaProviders] Strange: require succeeded but computeEd2kHash is null:', testRequire);
      } catch (e) {
        console.error('[MetaProviders] Confirmed: ed2k-hash module failed to load:', e.message);
      }
      return null;
    }
    if (!getAniDBClient) {
      console.error('[MetaProviders] AniDB client module not available, skipping AniDB lookup');
      try {
        const testRequire = require('./anidb');
        console.error('[MetaProviders] Strange: require succeeded but getAniDBClient is null:', testRequire);
      } catch (e) {
        console.error('[MetaProviders] Confirmed: anidb module failed to load:', e.message);
      }
      return null;
    }
    
    console.log('[MetaProviders] Modules available - ED2K hash:', !!computeEd2kHash, 'AniDB client:', !!getAniDBClient);
    
    try {
      console.log('[MetaProviders] Attempting AniDB ED2K hash lookup for:', filePath);
      
      // Get file size for cache validation
      const fileSize = fs.statSync(filePath).size;
      
      // Check if we have a cached hash
      let ed2kHash = null;
      try {
        const db = require('./db');
        ed2kHash = db.getEd2kHash(filePath, fileSize);
        if (ed2kHash) {
          console.log('[MetaProviders] Using cached ED2K hash:', ed2kHash);
        }
      } catch (dbErr) {
        console.log('[MetaProviders] Failed to check ED2K cache:', dbErr.message);
      }
      
      // Compute hash if not cached
      if (!ed2kHash) {
        console.log('[MetaProviders] Computing ED2K hash for:', filePath, `(${Math.round(fileSize/1024/1024)}MB)`);
        ed2kHash = await computeEd2kHash(filePath);
        console.log('[MetaProviders] ED2K hash computed:', ed2kHash);
        
        // Cache the computed hash
        try {
          const db = require('./db');
          db.setEd2kHash(filePath, ed2kHash, fileSize);
          console.log('[MetaProviders] Cached ED2K hash for future lookups');
        } catch (dbErr) {
          console.log('[MetaProviders] Failed to cache ED2K hash:', dbErr.message);
        }
      }
      
      console.log('[MetaProviders] Using ED2K hash:', ed2kHash, 'Size:', fileSize);
      
      // Get AniDB client
      const anidbClient = getAniDBClient(opts.anidb_username, opts.anidb_password);
      
      // Try UDP lookup first (more complete data)
      let fileInfo = null;
      try {
        fileInfo = await anidbClient.lookupFileByHash(ed2kHash, fileSize);
      } catch (udpError) {
        console.log('[MetaProviders] AniDB UDP lookup failed, trying HTTP:', udpError.message);
        
        // Fallback to HTTP lookup
        try {
          fileInfo = await anidbClient.lookupFileByHashHttp(ed2kHash, fileSize);
        } catch (httpError) {
          console.log('[MetaProviders] AniDB HTTP lookup also failed:', httpError.message);
        }
      }
      
      if (fileInfo) {
        console.log('[MetaProviders] AniDB file found:', fileInfo.animeTitle || fileInfo.aid);
        
        // Parse AniDB response into standard format
        result.provider = 'anidb';
        result.id = fileInfo.aid;
        result.name = fileInfo.animeTitle || title;
        result.episodeTitle = fileInfo.episodeName || fileInfo.episodeRomaji || null;
        result.episodeNumber = fileInfo.episodeNumber ? parseEpisodeNumber(fileInfo.episodeNumber) : opts.episode;
        result.seasonNumber = opts.season || 1; // AniDB doesn't have seasons like western TV
        result.raw = fileInfo;
        result.source = 'anidb-ed2k';
        
        // If we got metadata from AniDB, try to enrich with additional info
        if (fileInfo.aid) {
          try {
            const animeInfo = await anidbClient.getAnimeInfo(fileInfo.aid);
            if (animeInfo) {
              result.raw.animeInfo = animeInfo;
              // Use full anime title if available
              if (animeInfo.title && !result.name) {
                result.name = animeInfo.title;
              }
            }
          } catch (animeErr) {
            console.log('[MetaProviders] Could not fetch additional anime info:', animeErr.message);
          }
        }
        
        console.log('[MetaProviders] AniDB lookup successful:', {
          name: result.name,
          episode: result.episodeTitle,
          provider: result.provider
        });
        
        return result;
      } else {
        console.log('[MetaProviders] No AniDB file match found for hash');
      }
    } catch (anidbError) {
      console.log('[MetaProviders] AniDB lookup failed:', anidbError.message);
      // Continue to fallback
    }
  }

  // Fallback to existing metaLookup chain (AniList -> TVDb -> TMDb)
  if (opts.fallbackMetaLookup && typeof opts.fallbackMetaLookup === 'function') {
    console.log('[MetaProviders] Falling back to existing metaLookup chain for:', title);
    
    try {
      const fallbackOpts = {
        season: opts.season,
        episode: opts.episode,
        year: opts.year,
        preferredProvider: opts.preferredProvider,
        parsedEpisodeTitle: opts.parsedEpisodeTitle,
        parentCandidate: opts.parentCandidate,
        parentPath: opts.parentPath,
        force: opts.force,
        username: opts.username,
        tvdbOverride: opts.tvdbOverride
      };
      
      const fallbackResult = await opts.fallbackMetaLookup(title, opts.tmdbApiKey, fallbackOpts);
      
      if (fallbackResult) {
        console.log('[MetaProviders] Fallback lookup successful:', fallbackResult.provider);
        return fallbackResult;
      }
    } catch (fallbackError) {
      console.log('[MetaProviders] Fallback lookup failed:', fallbackError.message);
    }
  }

  console.log('[MetaProviders] No metadata found from any provider');
  return null;
}

/**
 * Parse episode number from AniDB format
 * AniDB episode numbers can be: "1", "12", "S1" (special 1), "C1" (credit), "T1" (trailer), etc.
 */
function parseEpisodeNumber(anidbEpisode) {
  if (!anidbEpisode) return null;
  
  const epStr = String(anidbEpisode).trim();
  
  // Special episodes (S prefix)
  if (/^S\d+$/i.test(epStr)) {
    const num = parseInt(epStr.substring(1), 10);
    return isNaN(num) ? null : `0.${num}`; // Represent as season 0 episode
  }
  
  // Credits, Trailers, Parodies, Others (C, T, P, O prefixes) - treat as specials
  if (/^[CTPO]\d+$/i.test(epStr)) {
    const num = parseInt(epStr.substring(1), 10);
    return isNaN(num) ? null : `0.${100 + num}`; // High special numbers to avoid conflicts
  }
  
  // Regular episodes - just a number
  const num = parseInt(epStr, 10);
  return isNaN(num) ? null : num;
}

/**
 * Get AniDB credentials from settings
 * Checks user settings first, then server settings
 */
function getAniDBCredentials(username, serverSettings, users) {
  let anidb_username = null;
  let anidb_password = null;
  
  try {
    // Check user settings first
    if (username && users && users[username] && users[username].settings) {
      if (users[username].settings.anidb_username) {
        anidb_username = users[username].settings.anidb_username;
      }
      if (users[username].settings.anidb_password) {
        anidb_password = users[username].settings.anidb_password;
      }
    }
    
    // Fallback to server settings
    if (!anidb_username && serverSettings && serverSettings.anidb_username) {
      anidb_username = serverSettings.anidb_username;
    }
    if (!anidb_password && serverSettings && serverSettings.anidb_password) {
      anidb_password = serverSettings.anidb_password;
    }
  } catch (e) {
    console.error('[MetaProviders] Error getting AniDB credentials:', e);
  }
  
  return {
    anidb_username,
    anidb_password,
    hasCredentials: !!(anidb_username && anidb_password)
  };
}

module.exports = {
  lookupMetadataWithAniDB,
  getAniDBCredentials,
  parseEpisodeNumber
};
