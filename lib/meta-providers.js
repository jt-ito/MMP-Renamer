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
let getAniDBUDPClient = null;

try {
  const ed2kModule = require('./ed2k-hash');
  computeEd2kHash = ed2kModule.computeEd2kHash;
} catch (e) {
  console.error('[MetaProviders] Failed to load ed2k-hash module:', e.message);
}

try {
  const anidbModule = require('./anidb-udp');
  getAniDBUDPClient = anidbModule.getAniDBUDPClient;
} catch (e) {
  console.error('[MetaProviders] Failed to load anidb-udp module:', e.message);
}

const fs = require('fs');
const path = require('path');

function normalizeApostrophes(value) {
  if (value == null) return value;
  return String(value).replace(/[\u0060\u00B4\u2018\u2019\u2032]/g, "'");
}

function safeTrim(value) {
  if (value == null) return '';
  return normalizeApostrophes(String(value)).trim();
}

function pickTitle(value) {
  const trimmed = safeTrim(value);
  return trimmed.length ? trimmed : null;
}

function uniqueList(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const trimmed = safeTrim(value);
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(trimmed);
  }
  return out;
}

function normalizeTitleKey(value) {
  const trimmed = safeTrim(value);
  if (!trimmed) return '';
  let normalized = trimmed;
  try {
    normalized = normalized.normalize('NFKD');
  } catch (e) {
    // ignore if normalize is not supported
  }
  return normalized
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

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
async function lookupMetadataWithAniDB(filePath, title, opts = {}, forceHash = false) {
  const shouldForceHash = !!(forceHash || (opts && opts.force));
  console.log('[MetaProviders] AniDB force options', {
    forceHashArg: forceHash,
    optsForce: opts && opts.force,
    effectiveForce: shouldForceHash
  });
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
      return null;
    }
    if (!getAniDBUDPClient) {
      console.error('[MetaProviders] AniDB UDP client module not available, skipping AniDB lookup');
      return null;
    }
    
    console.log('[MetaProviders] Modules available - ED2K hash:', !!computeEd2kHash, 'AniDB UDP client:', !!getAniDBUDPClient);
    
    try {
      console.log('[MetaProviders] Attempting AniDB ED2K hash lookup for:', filePath);
      
      // Get file size for cache validation
      const fileSize = fs.statSync(filePath).size;
      const fileSizeMB = Math.round(fileSize / 1024 / 1024);
      console.log(`[MetaProviders] File size: ${fileSizeMB}MB`);
      
      // Check if we have a cached hash (unless forceHash is true)
      let ed2kHash = null;
      if (!shouldForceHash) {
        try {
          const db = require('./db');
          ed2kHash = db.getEd2kHash(filePath, fileSize);
          if (ed2kHash) {
            console.log('[MetaProviders] Using cached ED2K hash:', ed2kHash);
          }
        } catch (dbErr) {
          console.log('[MetaProviders] Failed to check ED2K cache:', dbErr.message);
        }
      } else {
        console.log('[MetaProviders] forceHash=true, skipping cache and computing fresh hash');
      }
      
      // If no cached hash and NOT forceHash, queue for background computation and skip AniDB for now
      if (!ed2kHash && !shouldForceHash) {
        console.log('[MetaProviders] No cached hash - queueing for background computation');
        
        // Queue file for background hashing (fire and forget)
        setImmediate(() => {
          (async () => {
            try {
              console.log('[MetaProviders] [Background] Computing ED2K hash for:', filePath, `(${fileSizeMB}MB)`);
              const hash = await computeEd2kHash(filePath);
              console.log('[MetaProviders] [Background] ED2K hash computed:', hash);
              
              // Cache the computed hash
              try {
                const db = require('./db');
                db.setEd2kHash(filePath, hash, fileSize);
                console.log('[MetaProviders] [Background] Cached ED2K hash - will be available on next enrichment');
              } catch (dbErr) {
                console.error('[MetaProviders] [Background] Failed to cache ED2K hash:', dbErr.message);
              }
            } catch (hashErr) {
              console.error('[MetaProviders] [Background] Failed to compute ED2K hash:', hashErr.message);
            }
          })();
        });
        
        // Return null to skip AniDB for this enrichment
        console.log('[MetaProviders] Skipping AniDB for this enrichment - hash will be ready next time');
        return null;
      }
      
      // If force hash requested and no cached hash, compute it now (blocking)
      if (!ed2kHash && shouldForceHash) {
        console.log('[MetaProviders] Forcing ED2K hash computation inline for:', filePath, `(${fileSizeMB}MB)`);
        try {
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
        } catch (hashErr) {
          console.error('[MetaProviders] Failed to compute ED2K hash:', hashErr.message);
          return null;
        }
      }
      
      console.log('[MetaProviders] Using ED2K hash:', ed2kHash, 'Size:', fileSize);
      
      // Get AniDB UDP client with configurable client name/version
      const clientName = opts.anidb_client_name || 'mmprename';
      const clientVersion = opts.anidb_client_version || 1;
      console.log('[MetaProviders] AniDB client config:', { 
        clientName, 
        clientVersion, 
        fromOpts: { 
          name: opts.anidb_client_name, 
          version: opts.anidb_client_version 
        } 
      });
      const anidbClient = getAniDBUDPClient(opts.anidb_username, opts.anidb_password, clientName, clientVersion);
      
      // Try UDP lookup
      let fileInfo = null;
      try {
        fileInfo = await anidbClient.lookupFile(ed2kHash, fileSize);
        console.log('[MetaProviders] AniDB UDP result:', JSON.stringify(fileInfo).slice(0, 500));
      } catch (udpError) {
        console.log('[MetaProviders] AniDB UDP lookup failed:', udpError.message);
      }
      
      if (fileInfo) {
        console.log('[MetaProviders] AniDB file found');
        console.log('[MetaProviders] AniDB fileInfo keys:', Object.keys(fileInfo));
        
        // If we have an episode ID, fetch detailed episode information
        let episodeInfo = null;
        if (fileInfo.eid) {
          try {
            console.log('[MetaProviders] Fetching episode details for eid:', fileInfo.eid);
            episodeInfo = await anidbClient.lookupEpisode(fileInfo.eid);
            if (episodeInfo) {
              console.log('[MetaProviders] Episode info retrieved:', {
                epno: episodeInfo.epno,
                english: episodeInfo.englishName || '<none>',
                romaji: episodeInfo.romajiName || '<none>'
              });
            }
          } catch (epErr) {
            console.log('[MetaProviders] Failed to fetch episode details:', epErr.message);
          }
        }
        
        // Parse AniDB response into standard format
        const englishTitle = pickTitle(fileInfo.animeEnglishName);
        const romajiTitle = pickTitle(fileInfo.animeRomajiName);
        const kanjiTitle = pickTitle(fileInfo.animeKanjiName);
        const otherNames = uniqueList([
          ...(Array.isArray(fileInfo.animeOtherNames) ? fileInfo.animeOtherNames : []),
          fileInfo.animeOtherName
        ]);
        const shortNames = uniqueList(Array.isArray(fileInfo.animeShortNames) ? fileInfo.animeShortNames : []);
        const synonymNames = uniqueList(Array.isArray(fileInfo.animeSynonyms) ? fileInfo.animeSynonyms : []);

        const candidateEntries = [
          { value: englishTitle, source: 'english' },
          { value: romajiTitle, source: 'romaji' },
          { value: kanjiTitle, source: 'kanji' },
          ...shortNames.map((value) => ({ value, source: 'short' })),
          ...synonymNames.map((value) => ({ value, source: 'synonym' })),
          ...otherNames.map((value) => ({ value, source: 'other' }))
        ].filter((entry) => entry.value);

        const englishEntry = candidateEntries.find((entry) => entry.source === 'english') || null;
        const normalizedInput = normalizeTitleKey(title);
        let matchedEntry = null;

        if (normalizedInput) {
          matchedEntry = candidateEntries.find((entry) => normalizeTitleKey(entry.value) === normalizedInput) || null;
          if (!matchedEntry) {
            matchedEntry = candidateEntries.find((entry) => {
              const normalized = normalizeTitleKey(entry.value);
              return normalized && (normalized.includes(normalizedInput) || normalizedInput.includes(normalized));
            }) || null;
          }
        }

        let selectedEntry = null;
        
        // Priority 1: If we have an English title, always prefer it (AniDB English titles are the official localized names)
        if (englishEntry) {
          selectedEntry = englishEntry;
        }
        
        // Priority 2: If no English title and something matched the input, use that
        if (!selectedEntry && matchedEntry) {
          selectedEntry = matchedEntry;
        }

        // Priority 3: Fall back to other title types
        if (!selectedEntry) {
          const fallbackOrder = ['short', 'synonym', 'other', 'romaji', 'kanji'];
          for (const category of fallbackOrder) {
            const candidate = candidateEntries.find((entry) => entry.source === category);
            if (candidate) {
              selectedEntry = candidate;
              break;
            }
          }
        }

        const chosenSeriesName = selectedEntry ? selectedEntry.value : (
          englishTitle ||
          romajiTitle ||
          kanjiTitle ||
          otherNames[0] ||
          synonymNames[0] ||
          title ||
          null
        );

        const episodeEnglish = pickTitle(episodeInfo?.englishName || fileInfo.episodeEnglishName);
        const episodeRomaji = pickTitle(episodeInfo?.romajiName || fileInfo.episodeRomajiName);
        const episodeKanji = pickTitle(episodeInfo?.kanjiName || fileInfo.episodeKanjiName);
        const animeType = safeTrim(fileInfo.animeType) || null;

        let episodeTitle = null;
        let episodeTitleSource = null;
        if (episodeEnglish) {
          episodeTitle = episodeEnglish;
          episodeTitleSource = 'english';
        } else if (episodeRomaji) {
          episodeTitle = episodeRomaji;
          episodeTitleSource = 'romaji';
        } else if (episodeKanji) {
          episodeTitle = episodeKanji;
          episodeTitleSource = 'kanji';
        }

        if (!episodeTitle) {
          const rawEpisodeLabel = safeTrim(fileInfo.episodeNumber);
          if (rawEpisodeLabel) {
            episodeTitle = `Episode ${rawEpisodeLabel}`;
            episodeTitleSource = 'generated';
          } else if (opts.episode != null) {
            episodeTitle = `Episode ${opts.episode}`;
            episodeTitleSource = 'generated-from-filename';
          }
        }

        result.provider = 'anidb';
        result.id = fileInfo.aid;
        result.name = chosenSeriesName || title;
        
        // Strip leading "OVA " prefix from AniDB titles if present
        if (result.name && typeof result.name === 'string') {
          const stripped = result.name.replace(/^OVA\s+/i, '');
          if (stripped !== result.name) {
            console.log('[MetaProviders] Stripped OVA prefix from AniDB title:', result.name, '->', stripped);
            result.name = stripped;
          }
        }
        
        result.anidbTitleSource = selectedEntry ? selectedEntry.source : null;
        result.anidbTitleMatchedInput = !!(normalizedInput && selectedEntry && normalizeTitleKey(selectedEntry.value) === normalizedInput);
        result.anidbMatchedTitleSource = matchedEntry ? matchedEntry.source : null;
        result.animeType = animeType;
        result.alternateTitles = {
          english: englishTitle,
          romaji: romajiTitle,
          kanji: kanjiTitle,
          short: shortNames,
          synonyms: synonymNames,
          other: otherNames
        };
        result.episodeTitle = episodeTitle || null;
        result.episodeTitleSource = episodeTitleSource;
        result.episodeTitles = {
          english: episodeEnglish,
          romaji: episodeRomaji,
          kanji: episodeKanji
        };
        result.episodeNumber = (episodeInfo?.epno || fileInfo.episodeNumber) ? parseEpisodeNumber(episodeInfo?.epno || fileInfo.episodeNumber) : (opts.episode != null ? opts.episode : null);
        result.episodeNumberRaw = episodeInfo?.epno || fileInfo.episodeNumber || null;
        result.seasonNumber = opts.season || 1; // AniDB doesn't have seasons like western TV
        result.raw = fileInfo;
        result.source = 'anidb-ed2k';
        
        console.log('[MetaProviders] AniDB lookup successful:', {
          name: result.name,
          episode: result.episodeTitle,
          provider: result.provider,
          nameSource: result.anidbTitleSource
        });
        
        console.log('[MetaProviders] AniDB title candidates:', {
          english: englishTitle || '<empty>',
          romaji: romajiTitle || '<empty>',
          kanji: kanjiTitle || '<empty>',
          selectedSource: result.anidbTitleSource,
          matchedInput: result.anidbTitleMatchedInput
        });
        
        console.log('[MetaProviders] AniDB episode data:', {
          episodeNumber: fileInfo.episodeNumber || '<empty>',
          episodeEnglish: episodeEnglish || '<empty>',
          episodeRomaji: episodeRomaji || '<empty>',
          episodeKanji: episodeKanji || '<empty>',
          finalTitle: result.episodeTitle || '<empty>',
          source: episodeTitleSource || '<none>',
          fallbackFromOpts: opts.episode || '<none>'
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
  let anidb_client_name = null;
  let anidb_client_version = null;
  
  try {
    // Check user settings first
    if (username && users && users[username] && users[username].settings) {
      if (users[username].settings.anidb_username) {
        anidb_username = users[username].settings.anidb_username;
      }
      if (users[username].settings.anidb_password) {
        anidb_password = users[username].settings.anidb_password;
      }
      if (users[username].settings.anidb_client_name) {
        anidb_client_name = users[username].settings.anidb_client_name;
      }
      if (users[username].settings.anidb_client_version) {
        anidb_client_version = users[username].settings.anidb_client_version;
      }
    }
    
    // Fallback to server settings
    if (!anidb_username && serverSettings && serverSettings.anidb_username) {
      anidb_username = serverSettings.anidb_username;
    }
    if (!anidb_password && serverSettings && serverSettings.anidb_password) {
      anidb_password = serverSettings.anidb_password;
    }
    if (!anidb_client_name && serverSettings && serverSettings.anidb_client_name) {
      anidb_client_name = serverSettings.anidb_client_name;
    }
    if (!anidb_client_version && serverSettings && serverSettings.anidb_client_version) {
      anidb_client_version = serverSettings.anidb_client_version;
    }
  } catch (e) {
    console.error('[MetaProviders] Error getting AniDB credentials:', e);
  }
  
  return {
    anidb_username,
    anidb_password,
    anidb_client_name,
    anidb_client_version,
    hasCredentials: !!(anidb_username && anidb_password)
  };
}

module.exports = {
  lookupMetadataWithAniDB,
  getAniDBCredentials,
  parseEpisodeNumber
};
