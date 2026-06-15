import React from 'react';

export function Spinner(){
  return (
    <svg className="icon spinner" viewBox="0 0 50 50" width="18" height="18"><circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="4" strokeOpacity="0.18" fill="none"/><path d="M45 25a20 20 0 0 1-20 20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/></path></svg>
  )
}

export function LoadingIndicator({ status, stage }) {
  const getMessage = () => {
    if (typeof status === 'string') return status
    if (stage === 'init') return 'Starting rescan...'
    if (stage === 'fetching') return 'Computing hash & fetching metadata...'
    return 'Processing...'
  }
  
  return (
    <div className="loading-pulse" style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '4px 10px',
      background: 'var(--bg-700)',
      borderRadius: '6px',
      fontSize: '12px',
      color: 'var(--accent)',
      border: '1px solid var(--bg-600)'
    }}>
      <svg className="icon spinner" viewBox="0 0 50 50" width="14" height="14">
        <circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="4" strokeOpacity="0.18" fill="none"/>
        <path d="M45 25a20 20 0 0 1-20 20" stroke="var(--accent-cta)" strokeWidth="4" strokeLinecap="round" fill="none">
          <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.8s" repeatCount="indefinite"/>
        </path>
      </svg>
      <span style={{ opacity: 0.9, fontWeight: 500 }}>{getMessage()}</span>
    </div>
  )
}
