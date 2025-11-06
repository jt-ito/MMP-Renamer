# AniDB Integration Guide

## Overview

This application now supports **AniDB** as the primary metadata provider for anime files using **ED2K file hashing**. This provides more accurate episode identification compared to filename-based parsing alone.

## How It Works

### Provider Chain

1. **AniDB (ED2K Hash)** - Primary method
   - Computes ED2K hash of the actual file
   - Looks up file in AniDB database by hash
   - Provides accurate episode identification even with unconventional filenames

2. **Fallback Chain** - When AniDB doesn't have the file
   - AniList (GraphQL API)
   - TVDb (v4 API)
   - TMDb (The Movie Database)

### ED2K Hashing

ED2K (eDonkey2000) is a file hashing algorithm used by AniDB:

- **Chunk Size**: 9,728,000 bytes (9500 KiB)
- **Algorithm**: MD4 hash per chunk
- **Single chunk**: Returns MD4 hash directly
- **Multiple chunks**: Returns MD4 hash of concatenated chunk hashes

## Configuration

### Required Settings

Add your AniDB credentials in the application settings:

```json
{
  "anidb_username": "your_anidb_username",
  "anidb_password": "your_anidb_password"
}
```

**Important**: Use your AniDB account password, not your API key or UDP client password.

### Settings Location

- **Server-wide**: Configure in `data/settings.json` (admin only)
- **Per-user**: Configure via `/api/settings` endpoint or web UI

## Rate Limiting

AniDB has strict rate limits to prevent abuse:

### API Limits

- **HTTP**: Max 1 request per 2 seconds
- **UDP**: Max 1 packet per 2 seconds (0.5 packets/second)

### Implementation

This application uses **conservative rate limiting**:
- 2.5 seconds between requests (safer than 2s minimum)
- Automatic 5-minute pause every 30 minutes during bulk operations
- Prevents HTTP and UDP bans

### Bulk Operations

When processing large libraries:
1. Files are processed with proper rate limiting
2. Every 30 minutes, the system pauses for 5 minutes
3. Progress is logged for transparency

## API Protocols

### UDP API (Primary)

- **Pros**: Complete metadata, faster responses
- **Cons**: Requires authentication session
- **Use**: File lookups, anime info

### HTTP API (Fallback)

- **Pros**: No authentication required, simpler
- **Cons**: Less detailed metadata, XML parsing
- **Use**: Fallback when UDP fails

## File Hash Lookup Flow

```
1. User adds/scans file
2. System computes ED2K hash (streaming, memory-safe)
3. AniDB UDP lookup by hash + filesize
   ├─ Success: Return anime + episode metadata
   └─ Fail: Try HTTP lookup
       ├─ Success: Return metadata
       └─ Fail: Fall back to filename parsing + AniList/TVDb
```

## Example Usage

### Manual Testing

```javascript
const { computeEd2kHash } = require('./lib/ed2k-hash');
const { getAniDBClient } = require('./lib/anidb');

// Compute hash
const hash = await computeEd2kHash('/path/to/anime/episode.mkv');
console.log('ED2K Hash:', hash);

// Lookup in AniDB
const client = getAniDBClient('username', 'password');
const fileInfo = await client.lookupFileByHash(hash, fileSize);
console.log('Anime:', fileInfo.animeTitle);
console.log('Episode:', fileInfo.episodeName);
```

### Integration in Enrichment

The system automatically tries AniDB first:

```javascript
// In server.js externalEnrich function
const result = await lookupMetadataWithAniDB(
  realPath,              // File path
  seriesLookupTitle,     // Parsed title
  {
    anidb_username,
    anidb_password,
    fallbackMetaLookup,  // Existing provider chain
    season,
    episode
  }
);
```

## Testing

### Run Tests

```bash
# All tests
npm test

# ED2K hash tests only
npm run test:ed2k

# AniDB provider tests only
npm run test:anidb
```

### Test Coverage

- ✅ ED2K hash computation (empty, single-chunk, multi-chunk)
- ✅ Boundary cases (exact chunk sizes, +1 byte)
- ✅ Large file streaming (memory safety)
- ✅ Rate limiting enforcement
- ✅ Response parsing (UDP and HTTP)
- ✅ Episode number parsing (regular, specials, credits)
- ✅ Credential resolution (user vs server settings)
- ✅ Fallback chain integration

## Known Limitations

1. **AniDB Account Required**: Free accounts available at https://anidb.net
2. **Rate Limits**: Slow for large libraries (intentional to respect AniDB)
3. **Anime Only**: AniDB only has anime; Western TV falls back to other providers
4. **File Must Exist**: Hash requires actual file (can't lookup by filename alone)

## Troubleshooting

### "Authentication failed"

- Check username/password in settings
- Ensure AniDB account is active
- Wait a few minutes if recently changed password

### "Request timeout"

- Check network connectivity
- AniDB servers may be under load
- UDP port 9000 must not be blocked

### "No such file"

- File not in AniDB database
- Hash computed correctly but file not matched
- System will fall back to other providers

### "UDP ban" or "HTTP ban"

- Rate limits exceeded
- Wait 24 hours before retrying
- This should not happen with proper rate limiting
- Report as bug if occurs

## Performance Considerations

### ED2K Hash Speed

- **Small files** (<10 MB): ~100ms
- **Medium files** (1-2 GB): ~5-10 seconds
- **Large files** (10+ GB): ~30-60 seconds

Hashing is done **once** and cached.

### Memory Usage

- Streaming implementation: ~10 MB peak memory
- No full-file loading regardless of file size
- Suitable for very large files (50+ GB)

## Best Practices

1. **Configure credentials** before bulk operations
2. **Be patient** with large libraries (rate limits are protective)
3. **Monitor logs** for AniDB responses and errors
4. **Keep credentials secure** (never commit to version control)
5. **Respect AniDB** by not attempting to bypass rate limits

## API Documentation

### AniDB Official Docs

- UDP API: http://wiki.anidb.net/w/UDP_API_Definition
- HTTP API: http://wiki.anidb.net/w/HTTP_API_Definition
- ED2K Links: http://wiki.anidb.net/w/Ed2k-hash

### Implementation References

- Shoko (C# implementation): https://github.com/ShokoAnime/ShokoServer
- AniDB Python Client: https://github.com/adamlounds/python-anidb

## Future Enhancements

Potential improvements:

- [ ] Cache ED2K hashes to avoid recomputation
- [ ] Batch file lookups (if AniDB adds support)
- [ ] MyList integration (mark files as watched)
- [ ] Anime relations/sequels auto-detection
- [ ] Anime calendar/airing schedule integration

## Credits

- **ED2K Algorithm**: eDonkey2000 network
- **AniDB**: Community anime database
- **MD4 Implementation**: Node.js crypto module
