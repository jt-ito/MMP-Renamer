import React, { useState, useEffect, useRef } from 'react';
import { IconRefresh, IconCopy } from './Icons';

export default function LogsPanel({ logs, refresh, pushToast, logTimezone }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const preRef = useRef(null);
  const displayLogs = React.useMemo(() => {
    try {
      if (!logs || !logTimezone) return logs
      const formatter = new Intl.DateTimeFormat(undefined, {
        timeZone: logTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
      return String(logs)
        .split('\n')
        .map((line) => {
          const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/)
          if (!match) return line
          const dt = new Date(match[1])
          if (Number.isNaN(dt.getTime())) return line
          const parts = formatter.formatToParts(dt)
          const map = {}
          for (const p of parts) map[p.type] = p.value
          const stamp = `${map.year || ''}-${map.month || ''}-${map.day || ''} ${map.hour || ''}:${map.minute || ''}:${map.second || ''}`.trim()
          return `${stamp} ${match[2]}`.trim()
        })
        .join('\n')
    } catch (e) {
      return logs
    }
  }, [logs, logTimezone])

  // Scroll to the bottom whenever logs update so most-recent entries are visible
  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [displayLogs, isExpanded])

  return (
    <div className="logs">
      <h3 
        onClick={() => setIsExpanded(!isExpanded)} 
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' }}
      >
        <span style={{ 
          display: 'inline-block', 
          transition: 'transform 200ms ease',
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          fontSize: '0.9em'
        }}>›</span>
        Logs
      </h3>
      {isExpanded && (
        <>
          <pre ref={preRef}>{displayLogs || 'No logs yet'}</pre>
          <div style={{display:'flex',marginTop:8, alignItems:'center'}}>
            <button className="btn-ghost icon-only" onClick={refresh} title="Refresh logs"><IconRefresh/></button>
            <button className="btn-ghost icon-only" onClick={() => { navigator.clipboard?.writeText(logs); pushToast && pushToast('Logs', 'Copied to clipboard') }} title="Copy logs"><IconCopy/></button>
          </div>
        </>
      )}
    </div>
  )
}
