/**
 * Meta Providers Module
 * 
 * Provides unified metadata lookup with multiple provider fallback chain:
 * 1. AniDB (via ED2K hash lookup) - Primary for anime
 * 2. Existing provider chain (AniList -> TVDb -> TMDb) - Fallback
 * 
 * This module wraps the existing metaLookup with AniDB hash-based lookup first
 */

let computeEd2kHash = null
let getAniDBUDPClient = null

// Pre-compiled regex patterns for performance
const REGEX_APOSTROPHES = /[\u0060\u00B4\u2018\u2019\u2032]/g
const REGEX_QUOTES = /[""«»]/g
const REGEX_SINGLE_QUOTES = /['']/g
const REGEX_DASHES = /[‐‑–—]/g
const REGEX_WHITESPACE = /\s+/g
const REGEX_BASIC_PLACEHOLDER = /^(?:episode|ep|ep\.|no\.?|#|part|special|sp)\s*[\-:\.?]?\s*\d+(?:\.\d+)?$/i
const REGEX_NUMERIC_ONLY = /^\d+(?:\.\d+)?$/
const REGEX_QUOTES_PARENS = /["'`]|\(.*?\)|\[.*?\]/g
const REGEX_DIACRITICS = /[\u0300-\u036f]/g
const REGEX_NON_ALPHANUMERIC = /[^a-z0-9]/gi

try {
  const ed2kModule = require('./ed2k-hash')
  computeEd2kHash = ed2kModule.computeEd2kHash
} catch (e) {
  console.error('[MetaProviders] Failed to load ed2k-hash module:', e.message)
}

try {
  const anidbModule = require('./anidb-udp')
  getAniDBUDPClient = anidbModule.getAniDBUDPClient
} catch (e) {
  console.error('[MetaProviders] Failed to load anidb-udp module:', e.message)
}

const fs = require('fs')
const path = require('path')

function normalizeApostrophes(value) {
  if (value == null) return value
  return String(value).replace(REGEX_APOSTROPHES, "'")
}

function safeTrim(value) {
  if (value == null) return ''
  return normalizeApostrophes(String(value)).trim()
}

/**
 * Detect Part/Cour patterns in anime titles and extract season number
 * Examples: "Part 2", "2nd Part", "Cour 2", "Season 2", "Part II"
 * For "Season X Part Y" format: Season X Part 1 → Season X, Season X Part 2 → Season X+1
 * Returns null if no pattern found, otherwise returns the season number
 */
function extractPartCourSeason(titleList) {
  if (!Array.isArray(titleList)) return null;
  
  const seasonPatterns = [
    /Season\s+(\d+)/i,
    /\bS(\d+)(?:\s|$)/i,  // Matches "S2" at word boundary with space or end of string
    /[a-z](\d{1,2})$/i // Matches trailing 1-2 digits after letter (e.g., "Uzaki2" -> 2)
  ];
  
  const partCourPatterns = [
    /Part\s+(\d+)/i,
    /(\d+)(?:st|nd|rd|th)\s+Part/i,
    /Cour\s+(\d+)/i,
    /Part\s+(II|III|IV|V|VI|VII|VIII|IX|X)/i,
    /(\d+)\s+Cour/i
  ];
  
  const romanToNumber = {
    'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
    'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
  };
  
  let detectedSeason = null;
  let detectedPart = null;
  
  // Check all titles for both Season and Part patterns
  for (const title of titleList) {
    if (!title || typeof title !== 'string') continue;
    
    // Check for Season pattern
    if (!detectedSeason) {
      for (const pattern of seasonPatterns) {
        const match = title.match(pattern);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > 0 && num < 20) {
            detectedSeason = num;
            break;
          }
        }
      }
    }
    
    // Check for Part/Cour pattern
    if (!detectedPart) {
      for (const pattern of partCourPatterns) {
        const match = title.match(pattern);
        if (match) {
          const captured = match[1];
          if (romanToNumber[captured]) {
            detectedPart = romanToNumber[captured];
            break;
          }
          const num = parseInt(captured, 10);
          if (num > 0 && num < 20) {
            detectedPart = num;
            break;
          }
        }
      }
    }
    
    // If we found both, we can stop searching
    if (detectedSeason && detectedPart) break;
  }
  
  // Calculate final season number based on what we found
  if (detectedSeason && detectedPart) {
    // "Season X Part Y" format: Season 2 Part 1 → Season 2, Season 2 Part 2 → Season 3
    const finalSeason = detectedSeason + (detectedPart - 1);
    console.log(`[MetaProviders] Detected Season ${detectedSeason} Part ${detectedPart} → Season ${finalSeason}`);
    return finalSeason;
  } else if (detectedSeason) {
    // Only season found
    console.log(`[MetaProviders] Detected Season ${detectedSeason}`);
    return detectedSeason;
  } else if (detectedPart) {
    // Only part found, treat as season
    console.log(`[MetaProviders] Detected Part ${detectedPart} → Season ${detectedPart}`);
    return detectedPart;
  }
  
  return null;
}

function pickTitle(value) {
  const trimmed = safeTrim(value)
  return trimmed.length ? trimmed : null
}

function uniqueList(values = []) {
  if (!Array.isArray(values) || !values.length) return []
  const out = []
  const seen = new Set()
  for (const value of values) {
    const trimmed = safeTrim(value)
    if (!trimmed) continue
    const normalized = trimmed.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(trimmed)
  }
  return out
}

function normalizeTitleKey(value) {
  const trimmed = safeTrim(value)
  if (!trimmed) return ''
  let normalized = trimmed
  try {
    normalized = normalized.normalize('NFKD')
  } catch (e) {
    // ignore if normalize is not supported
  }
  return normalized
    .replace(REGEX_DIACRITICS, '')
    .replace(REGEX_NON_ALPHANUMERIC, '')
    .toLowerCase()
}

function isPlaceholderEpisodeTitle(value) {
  const trimmed = safeTrim(value);
  if (!trimmed) return true;
  const normalized = trimmed
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;

  const basicPlaceholder = /^(?:episode|ep|ep\.|no\.?|#|part|special|sp)\s*[\-:\.]?\s*\d+(?:\.\d+)?$/i;
  if (basicPlaceholder.test(normalized)) return true;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return true;

  const withoutPunctuation = normalized
    .replace(/["'`]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .trim();
  const words = withoutPunctuation.split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const STOP_WORDS = new Set(['episode', 'ep', 'no', 'no.', '#', 'part', 'pt', 'special', 'sp', 'ova']);
  const hasMeaningfulWord = words.some((word) => {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) return false;
    if (/^\d+(?:\.\d+)?$/.test(lower)) return false;
    return lower.length > 2;
  });
  return !hasMeaningfulWord;
}

function parseAniDbTimestamp(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num > 1e12) {
    return num;
  }
  return num * 1000;
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
  // Treat any of these flags as a signal to compute ED2K inline:
  //  - explicit `forceHash` argument
  //  - `opts.forceHash` provided by callers
  //  - `opts.force` (request-level force)
  const shouldForceHash = !!(forceHash || (opts && (opts.forceHash || opts.force)));
  console.log('[MetaProviders] AniDB force options', {
    forceHashArg: forceHash,
    optsForceHash: opts && opts.forceHash,
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

  if (opts && opts.skipAniDB) {
    console.log('[MetaProviders] skipAniDB=true; bypassing AniDB lookup');
    if (opts.fallbackMetaLookup && typeof opts.fallbackMetaLookup === 'function') {
      try {
        return await opts.fallbackMetaLookup(title, opts.tmdbApiKey, opts);
      } catch (e) {
        console.error('[MetaProviders] fallback metaLookup failed after skipAniDB:', e && e.message ? e.message : e);
        return null;
      }
    }
    return null;
  }

  // Check for manual AniDB episode ID override
  if (opts && opts.manualAnidbEpisodeId && opts.anidb_username && opts.anidb_password) {
    console.log('[MetaProviders] Manual AniDB episode ID provided:', opts.manualAnidbEpisodeId);
    try {
      const clientName = opts.anidb_client_name || 'mmprename';
      const clientVersion = opts.anidb_client_version || 1;
      const anidbClient = getAniDBUDPClient(opts.anidb_username, opts.anidb_password, clientName, clientVersion);
      
      console.log('[MetaProviders] Fetching episode details for manual eid:', opts.manualAnidbEpisodeId);
      const episodeInfo = await anidbClient.lookupEpisode(opts.manualAnidbEpisodeId);
      
      if (episodeInfo && episodeInfo.aid) {
        console.log('[MetaProviders] Manual episode lookup successful - aid:', episodeInfo.aid);
        
        // Get anime details using the aid from episode
        const animeResponse = await anidbClient.lookupAnime(episodeInfo.aid);
        if (animeResponse) {
          console.log('[MetaProviders] Got anime details for manual episode');
          console.log('[MetaProviders] animeResponse fields:', Object.keys(animeResponse));
          
          // Build result using episode info
          // Try to intelligently detect which field is which based on content
          const hasJapaneseChars = (str) => {
            if (!str) return false;
            return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/.test(str);
          };
          
          const hasLatinChars = (str) => {
            if (!str) return false;
            return /[a-zA-Z]/.test(str);
          };
          
          // Extract titles with smart detection
          let englishTitle = pickTitle(animeResponse.englishName || animeResponse.animeEnglishName);
          let romajiTitle = pickTitle(animeResponse.romajiName || animeResponse.animeRomajiName);
          let kanjiTitle = pickTitle(animeResponse.kanjiName || animeResponse.animeKanjiName);
          
          // If we have _allFields from the response, try to detect field order
          if (animeResponse._allFields && Array.isArray(animeResponse._allFields)) {
            const fields = animeResponse._allFields;
            console.log('[MetaProviders] Analyzing field content for title detection');
            
            // Scan fields 3-7 for title patterns
            const titleFields = fields.slice(3, 8).map((f, idx) => ({
              index: idx + 3,
              value: f,
              hasJapanese: hasJapaneseChars(f),
              hasLatin: hasLatinChars(f),
              length: (f || '').length
            })).filter(f => f.length > 0);
            
            console.log('[MetaProviders] Title field analysis:', titleFields);
            
            // Try to identify: Romaji (Latin only), English (Latin only), Kanji (Japanese chars)
            const romajiCandidate = titleFields.find(f => f.hasLatin && !f.hasJapanese);
            const kanjiCandidate = titleFields.find(f => f.hasJapanese);
            const englishCandidate = titleFields.find(f => f.hasLatin && !f.hasJapanese && f !== romajiCandidate);
            
            // Prefer detected fields if parsing seems off
            if (romajiCandidate && !romajiTitle) {
              romajiTitle = romajiCandidate.value;
              console.log('[MetaProviders] Detected romaji from field', romajiCandidate.index);
            }
            if (kanjiCandidate && kanjiCandidate.value && (!kanjiTitle || kanjiCandidate.value.length > (kanjiTitle || '').length)) {
              kanjiTitle = kanjiCandidate.value;
              console.log('[MetaProviders] Detected kanji from field', kanjiCandidate.index);
            }
            if (englishCandidate && !englishTitle) {
              englishTitle = englishCandidate.value;
              console.log('[MetaProviders] Detected english from field', englishCandidate.index);
            }
          }
          
          const animeType = safeTrim(animeResponse.animeType || animeResponse.type) || null;
          
          console.log('[MetaProviders] Extracted titles:', {
            english: englishTitle || '<none>',
            romaji: romajiTitle || '<none>',
            kanji: kanjiTitle || '<none>',
            type: animeType || '<none>'
          });
          
          // Verify title priority selection
          const selectedTitle = englishTitle || romajiTitle || kanjiTitle || title;
          const selectedSource = englishTitle ? 'english' : (romajiTitle ? 'romaji' : (kanjiTitle ? 'kanji' : 'fallback'));
          console.log('[MetaProviders] Selected title:', selectedTitle, 'from source:', selectedSource);
          
          // Get episode title from the episodeInfo
          let episodeTitle = null;
          let episodeTitleSource = null;
          const englishEpTitle = pickTitle(episodeInfo.englishName);
          const romajiEpTitle = pickTitle(episodeInfo.romajiName);
          const kanjiEpTitle = pickTitle(episodeInfo.kanjiName);
          
          const englishIsPlaceholder = isPlaceholderEpisodeTitle(englishEpTitle);
          const romajiIsPlaceholder = isPlaceholderEpisodeTitle(romajiEpTitle);
          const kanjiIsPlaceholder = isPlaceholderEpisodeTitle(kanjiEpTitle);
          
          // Prefer English, then Romaji, then Kanji
          if (englishEpTitle && !englishIsPlaceholder) {
            episodeTitle = englishEpTitle;
            episodeTitleSource = 'english';
          } else if (romajiEpTitle && !romajiIsPlaceholder) {
            episodeTitle = romajiEpTitle;
            episodeTitleSource = 'romaji';
          } else if (kanjiEpTitle && !kanjiIsPlaceholder) {
            episodeTitle = kanjiEpTitle;
            episodeTitleSource = 'kanji';
          } else if (englishEpTitle) {
            episodeTitle = englishEpTitle;
            episodeTitleSource = 'english';
          } else if (romajiEpTitle) {
            episodeTitle = romajiEpTitle;
            episodeTitleSource = 'romaji';
          } else if (kanjiEpTitle) {
            episodeTitle = kanjiEpTitle;
            episodeTitleSource = 'kanji';
          }
          
          // Parse episode number from AniDB format
          const parsedEpNum = parseEpisodeNumber(episodeInfo.epno);
          
          // Construct raw object in the same format as ED2K path
          // This ensures server.js mapping code can find all expected fields
          const rawForMapping = {
            aid: episodeInfo.aid,
            eid: opts.manualAnidbEpisodeId,
            animeEnglishName: englishTitle,
            animeRomajiName: romajiTitle,
            animeKanjiName: kanjiTitle,
            animeType: animeType,
            episodeNumber: episodeInfo.epno,
            episodeEnglishName: englishEpTitle,
            episodeRomajiName: romajiEpTitle,
            episodeKanjiName: kanjiEpTitle,
            animeYear: animeResponse.year || animeResponse.animeYear || null,
            // Store full responses for reference
            _animeResponse: animeResponse,
            _episodeInfo: episodeInfo
          };
          
          result.provider = 'anidb';
          result.id = episodeInfo.aid;
          result.name = englishTitle || romajiTitle || kanjiTitle || title;
          result.animeType = animeType;
          result.anidbTitleSource = 'english'; // Since we prefer English first
          result.alternateTitles = {
            english: englishTitle,
            romaji: romajiTitle,
            kanji: kanjiTitle,
            short: [],
            synonyms: [],
            other: []
          };
          result.episodeTitle = episodeTitle;
          result.episodeTitleSource = episodeTitleSource;
          result.episodeTitles = {
            english: englishEpTitle,
            romaji: romajiEpTitle,
            kanji: kanjiEpTitle
          };
          result.episodeNumber = parsedEpNum;
          result.episodeNumberRaw = episodeInfo.epno;
          result.seasonNumber = opts.season || 1;
          result.raw = rawForMapping;
          result.source = 'manual_episode_id';
          
          // Extract year if available
          if (animeResponse.year || animeResponse.animeYear) {
            const yearCandidate = safeTrim(animeResponse.year || animeResponse.animeYear);
            const yearMatch = yearCandidate ? yearCandidate.match(/\d{4}/) : null;
            if (yearMatch) {
              result.year = yearMatch[0];
            }
          }
          
          console.log('[MetaProviders] Manual AniDB episode result:', {
            name: result.name,
            episodeTitle: result.episodeTitle,
            episodeNumber: result.episodeNumber,
            animeType: result.animeType
          });
          
          return result;
        }
      }
      
      console.log('[MetaProviders] Manual AniDB episode lookup failed or incomplete');
    } catch (manualErr) {
      console.error('[MetaProviders] Manual AniDB episode lookup error:', manualErr.message);
    }
    // Fall through to normal ED2K lookup if manual lookup fails
  }

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
      
      // Always check cached hash first (hashes are stable across rescans)
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
      if (shouldForceHash && !ed2kHash) {
        console.log('[MetaProviders] forceHash=true, no cache available; computing fresh hash');
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
        
        // Priority 2: If no English title and something matched the input, use that ONLY if it's a high-quality match (romaji/english/kanji)
        if (!selectedEntry && matchedEntry) {
          // Only use matched entry if it's not a low-priority source (synonym/other can be Korean, Chinese, etc.)
          const highQualitySources = ['english', 'romaji', 'kanji', 'short'];
          if (highQualitySources.includes(matchedEntry.source)) {
            selectedEntry = matchedEntry;
          }
        }

        // Priority 3: Fall back in proper order: romaji (Japanese romanization) -> kanji (Japanese) -> other alternatives
        if (!selectedEntry) {
          const fallbackOrder = ['romaji', 'kanji', 'short', 'synonym', 'other'];
          for (const category of fallbackOrder) {
            const candidate = candidateEntries.find((entry) => entry.source === category);
            if (candidate) {
              selectedEntry = candidate;
              break;
            }
          }
        }

        // Safety: if we landed on kanji but a romaji title exists, prefer romaji for readability
        if (selectedEntry && selectedEntry.source === 'kanji' && romajiTitle) {
          selectedEntry = { value: romajiTitle, source: 'romaji' };
        }

        const chosenSeriesName = selectedEntry ? selectedEntry.value : (
          englishTitle ||
          romajiTitle ||
          kanjiTitle ||
          shortNames[0] ||
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
        const englishIsPlaceholder = isPlaceholderEpisodeTitle(episodeEnglish);
        const romajiIsPlaceholder = isPlaceholderEpisodeTitle(episodeRomaji);
        const kanjiIsPlaceholder = isPlaceholderEpisodeTitle(episodeKanji);

        if (episodeEnglish && !englishIsPlaceholder) {
          episodeTitle = episodeEnglish;
          episodeTitleSource = 'english';
        } else if (episodeRomaji && !romajiIsPlaceholder) {
          episodeTitle = episodeRomaji;
          episodeTitleSource = 'romaji';
        } else if (episodeKanji && !kanjiIsPlaceholder) {
          episodeTitle = episodeKanji;
          episodeTitleSource = 'kanji';
        } else if (episodeEnglish) {
          episodeTitle = episodeEnglish;
          episodeTitleSource = 'english';
          console.log('[MetaProviders] AniDB episode title fallback: forcing English placeholder');
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

        if (episodeTitleSource === 'romaji' && englishIsPlaceholder && !romajiIsPlaceholder) {
          console.log('[MetaProviders] AniDB episode title fallback: using romaji because English title is placeholder');
        } else if (episodeTitleSource === 'kanji' && englishIsPlaceholder && romajiIsPlaceholder && !kanjiIsPlaceholder) {
          console.log('[MetaProviders] AniDB episode title fallback: using kanji because English/Romaji titles look like placeholders');
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
  
  // AniDB doesn't have seasons like western TV, but many anime have Part/Cour designations
  // Try to detect Part 2, Cour 2, etc. from synonyms and set seasonNumber accordingly
  // AniDB detection takes priority over filename-parsed season for anime
  const allTitles = [
    englishTitle,
    romajiTitle,
    ...shortNames,
    ...synonymNames,
    ...otherNames
  ].filter(Boolean);
  
  const detectedSeason = extractPartCourSeason(allTitles);
  if (detectedSeason) {
    console.log(`[MetaProviders] Detected Part/Cour season ${detectedSeason} from AniDB titles, overriding filename season ${opts.season || 'none'}`);
  }
  
  // Prefer AniDB-detected season over filename-parsed season
  result.seasonNumber = detectedSeason || (opts && typeof opts.season !== 'undefined' && opts.season !== null ? opts.season : null);
        result.raw = fileInfo;
        result.source = 'anidb-ed2k';

        // Capture placeholder diagnostics for downstream consumers when helpful
        result.episodeTitleDiagnostics = {
          englishPlaceholder: englishIsPlaceholder,
          romajiPlaceholder: romajiIsPlaceholder,
          kanjiPlaceholder: kanjiIsPlaceholder,
          selected: episodeTitleSource
        };

        const yearCandidates = [fileInfo.animeYear, fileInfo.year, fileInfo.animeProductionYear]
          .map((candidate) => {
            const trimmed = safeTrim(candidate);
            if (!trimmed) return null;
            const yearMatch = trimmed.match(/\d{4}/);
            return yearMatch ? Number(yearMatch[0]) : null;
          })
          .filter((val) => Number.isFinite(val) && val > 0);
        if (yearCandidates.length) {
          result.year = String(yearCandidates[0]);
        }

        const airedTimestamp = parseAniDbTimestamp(
          (episodeInfo && (episodeInfo.aired || episodeInfo.airDate || episodeInfo.airedDate)) ||
          fileInfo.airedDate ||
          fileInfo.episodeAiredDate
        );
        if (airedTimestamp) {
          try {
            const airedDate = new Date(airedTimestamp);
            if (!Number.isNaN(airedDate.getTime())) {
              if (!result.year) {
                const airedYear = airedDate.getUTCFullYear();
                if (Number.isFinite(airedYear) && airedYear > 0) {
                  result.year = String(airedYear);
                }
              }
              result.airedAt = airedDate.toISOString();
              result.airedYear = String(airedDate.getUTCFullYear());
            }
          } catch (e) {
            // ignore timestamp parsing errors; fall back to existing year detection
          }
        }

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
