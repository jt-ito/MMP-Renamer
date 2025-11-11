# Fix: Extras Folder Parent Candidate Parsing

## Problem
When enriching files in extras/bonus folders, the parser was incorrectly identifying the extras folder name as the series title instead of looking further up the directory tree to find the actual series folder.

### Example Issue
For the path:
```
/mnt/Tor/Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)/Featurettes/Season 1/AMC Shootout Interview.mkv
```

The parser was:
- ✅ Correctly skipping "Season 1" (season folder)
- ❌ Incorrectly selecting "Featurettes" as the series title
- Instead of selecting "Breaking Bad (2008)..." as the series title

This resulted in incorrect metadata lookups searching for "Kottukkaali Featurettes" on TMDB instead of "Breaking Bad".

## Root Cause
The parent candidate logic was only checking for season folders (e.g., "Season 1", "S01") but not for common extras/bonus folder names. When it encountered "Featurettes", it treated it as a valid series name.

## Solution
Added a new `isExtrasFolderToken()` function that detects common extras/bonus folder names and skips them when searching for the parent series title.

### Detected Extras Folder Keywords
- `featurettes` / `featurette`
- `extras` / `extra`
- `bonus` / `bonuses`
- `behind the scenes` / `bts`
- `interviews` / `interview`
- `deleted scenes`
- `making of`
- `specials` / `special features`
- `documentary` / `documentaries`
- `trailers` / `trailer`
- `promos` / `promo`
- `clips`
- `outtakes`
- `bloopers`

The function matches:
1. Exact keyword matches (case-insensitive)
2. Keyword followed by space and additional text (e.g., "Featurettes 2024")

### Code Changes
**server.js:**
1. Added `isExtrasFolderToken()` function (similar to existing `isSeasonFolderToken()`)
2. Integrated extras folder check into parent candidate loop
3. Added logging for skipped extras folders (`META_PARENT_SKIP_EXTRAS_FOLDER`)

**tests/test-extras-folder-skip.js:**
Created comprehensive test suite with 6 test cases covering:
- Breaking Bad with Featurettes folder
- Series with Extras folder
- Series with Bonus folder
- Series with Deleted Scenes folder
- Regular episodes (should not skip parent)
- Nested extras folders (Extras/Interviews)

## Behavior
Now when processing:
```
/Breaking Bad (2008)/Featurettes/Season 1/AMC Shootout Interview.mkv
```

The parser will:
1. Start from the filename and work backwards
2. Skip "Season 1" (season folder) ✅
3. Skip "Featurettes" (extras folder) ✅
4. Select "Breaking Bad (2008)" as series title ✅
5. Look up "Breaking Bad" on TMDB/TVDb ✅

## Testing
All tests pass:
- 46 existing unit tests ✅
- 6 new extras folder skip tests ✅
- No regressions in existing functionality ✅

## Impact
- **No breaking changes** - Only adds additional filtering logic
- **Improves metadata accuracy** for files in extras/bonus folders
- **Consistent with existing season folder skip behavior**
- **Works with nested extras folders** (e.g., Extras/Interviews)

## Logs
After the fix, you should see logs like:
```
META_PARENT_SKIP_SEASON_FOLDER seg=Season 1
META_PARENT_SKIP_EXTRAS_FOLDER seg=Featurettes
```

Instead of:
```
META_PARENT_PREFERRED_FOR_SPECIAL parent=Featurettes
```
