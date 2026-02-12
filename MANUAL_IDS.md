# Manual Provider ID Override System

## Overview

When the automatic metadata lookup fails due to unusual naming (e.g., "Sean Diddy Combs Netflix Documentary The Reckoning"), you can manually specify provider IDs to force the system to use specific series from AniList, TMDB, or TVDB.

## Setup

1. Copy `config/manual-ids.template.json` to `data/manual-ids.json`
2. Add entries for series that need manual overrides

## Configuration Format

```json
{
  "Exact Series Title From Filename": {
    "tmdb": 12345,
    "tvdb": 67890,
    "anilist": 54321,
    "anidbEpisode": 300154
  }
}
```

**Important:** The key must match the **exact series title** extracted from your filename. Check your logs for the `META_LOOKUP_RAW title=` value to see what title the parser extracted.

## Finding Provider IDs

### TMDB (The Movie Database)
1. Go to [themoviedb.org](https://www.themoviedb.org)
2. Search for the series
3. The ID is in the URL: `themoviedb.org/tv/[ID]`
   - Example: `themoviedb.org/tv/246145` → ID is `246145`

### TVDB (TheTVDB)
1. Go to [thetvdb.com](https://www.thetvdb.com)
2. Search for the series
3. The ID is in the URL: `thetvdb.com/dereferrer/series/[ID]`
   - Example: `thetvdb.com/dereferrer/series/123456` → ID is `123456`

### AniList
1. Go to [anilist.co](https://anilist.co)
2. Search for the anime
3. The ID is in the URL: `anilist.co/anime/[ID]`
   - Example: `anilist.co/anime/21` → ID is `21`

### AniDB Episode ID
1. Go to [anidb.net](https://anidb.net)
2. Open the episode page
3. The ID is in the URL: `anidb.net/episode/[ID]`
  - Example: `anidb.net/episode/300154` → ID is `300154`

## Example: Sean Combs: The Reckoning

Based on your logs, the parser extracts: `"Sean Diddy Combs Netflix Documentary The Reckoning"`

The actual series on TMDB is "Sean Combs: The Reckoning" with ID 246145.

Add to `data/manual-ids.json`:
```json
{
  "Sean Diddy Combs Netflix Documentary The Reckoning": {
    "tmdb": 246145
  }
}
```

## How It Works

1. System checks `manual-ids.json` before attempting automatic search
2. If a match is found, it fetches metadata directly by ID
3. Logs show `MANUAL_ID_OVERRIDE` and `MANUAL_ID_[PROVIDER]_SUCCESS`
4. Episode information is still fetched normally

## Provider Priority

You only need to specify one provider ID. The system will:
- Use TVDB if specified and enabled
- Fall back to AniList/TMDB based on your provider order settings
- Still attempt episode lookups from all enabled providers

## Troubleshooting

- **Title doesn't match:** Check logs for `META_LOOKUP_RAW title=` to see the exact extracted title
- **ID not working:** Verify the ID by visiting the provider URL directly
- **Still not finding episodes:** Make sure season/episode numbers in filename are correct
- **Multiple providers:** You can specify IDs for multiple providers - the system uses them in order

## Reload

After editing `data/manual-ids.json`, the file is loaded at server startup. Restart the server to apply changes.

## Log Messages

- `MANUAL_ID_OVERRIDE`: Shows which manual IDs were found for a title
- `MANUAL_ID_[PROVIDER]_FETCH`: Attempting to fetch by ID
- `MANUAL_ID_[PROVIDER]_SUCCESS`: Successfully fetched metadata
- `MANUAL_ID_[PROVIDER]_ERROR`: Failed to fetch (check ID is correct)
