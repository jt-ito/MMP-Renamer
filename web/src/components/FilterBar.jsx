import React from 'react'

const PROVIDER_OPTIONS = [
  { value: 'all', label: 'All Providers' },
  { value: 'tmdb', label: 'TMDB' },
  { value: 'tvdb', label: 'TVDB' },
  { value: 'anidb', label: 'AniDB' },
  { value: 'anilist', label: 'AniList' },
  { value: 'kitsu', label: 'Kitsu' },
  { value: 'wikipedia', label: 'Wikipedia' }
]

const SORT_OPTIONS = [
  { value: 'dateAdded-desc', label: 'Recently Added (Newest First)' },
  { value: 'dateAdded-asc', label: 'Recently Added (Oldest First)' },
  { value: 'alphabetical-asc', label: 'Alphabetical (A-Z)' },
  { value: 'alphabetical-desc', label: 'Alphabetical (Z-A)' },
  { value: 'path-asc', label: 'Path (A-Z)' },
  { value: 'path-desc', label: 'Path (Z-A)' }
]

const SHOW_MODE_OPTIONS = [
  { value: 'all', label: 'All Items' },
  { value: 'withMetadata', label: 'With Metadata' },
  { value: 'withoutMetadata', label: 'Without Metadata' },
  { value: 'parsedOnly', label: 'Parsed Only' }
]

export default function FilterBar({
  sortOrder,
  onSortOrderChange,
  provider,
  onProviderChange,
  showMode,
  onShowModeChange,
  totalItems,
  filteredItems,
  onClearFilters
}) {
  const hasActiveFilters = provider !== 'all' || showMode !== 'all' || sortOrder !== 'dateAdded-desc'
  const filterCount = (provider !== 'all' ? 1 : 0) + (showMode !== 'all' ? 1 : 0)

  // Keyboard shortcut: Ctrl+Shift+C to clear filters
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault()
        if (hasActiveFilters) {
          onClearFilters()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasActiveFilters, onClearFilters])

  return (
    <div className="filter-bar">
      <div className="filter-group">
        <label htmlFor="filter-sort">
          <svg style={{ width: 14, height: 14, marginRight: 4, verticalAlign: 'middle', display: 'inline-block' }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 6h18M3 12h12M3 18h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Sort:
        </label>
        <select
          id="filter-sort"
          value={sortOrder}
          onChange={(e) => onSortOrderChange(e.target.value)}
          className="filter-select"
          title="Sort items by different criteria"
        >
          {SORT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="filter-provider">
          <svg style={{ width: 14, height: 14, marginRight: 4, verticalAlign: 'middle', display: 'inline-block' }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2"/>
            <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2"/>
            <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2"/>
            <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2"/>
          </svg>
          Provider:
        </label>
        <select
          id="filter-provider"
          value={provider}
          onChange={(e) => onProviderChange(e.target.value)}
          className="filter-select"
          title="Filter by metadata provider"
        >
          {PROVIDER_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="filter-show-mode">
          <svg style={{ width: 14, height: 14, marginRight: 4, verticalAlign: 'middle', display: 'inline-block' }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Show:
        </label>
        <select
          id="filter-show-mode"
          value={showMode}
          onChange={(e) => onShowModeChange(e.target.value)}
          className="filter-select"
          title="Filter by metadata status"
        >
          {SHOW_MODE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {hasActiveFilters && (
        <button
          className="btn-ghost clear-filters-btn"
          onClick={onClearFilters}
          title="Clear all filters and reset to defaults (Ctrl+Shift+C)"
        >
          <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Clear Filters
          {filterCount > 0 && (
            <span className="filter-badge">{filterCount}</span>
          )}
        </button>
      )}

      <div className="filter-stats">
        {filteredItems !== totalItems && (
          <span style={{ color: 'var(--accent-cta)', marginRight: 8, fontWeight: 600 }}>
            {filteredItems?.toLocaleString() || 0}
          </span>
        )}
        <span style={{ opacity: filteredItems !== totalItems ? 0.7 : 1 }}>
          {filteredItems === totalItems 
            ? `${totalItems?.toLocaleString() || 0} items`
            : `of ${totalItems?.toLocaleString() || 0} items`
          }
        </span>
      </div>
    </div>
  )
}
