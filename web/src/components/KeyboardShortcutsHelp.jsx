import React from 'react'

export default function KeyboardShortcutsHelp({ isOpen, onClose }) {
  if (!isOpen) return null

  const shortcuts = [
    { keys: '? or F1', description: 'Show this help dialog' },
    { keys: 'Esc', description: 'Exit select mode / Close dialogs' },
    { keys: 'Ctrl + A', description: 'Select all visible items (in select mode)' },
    { keys: 'Ctrl + D', description: 'Deselect all items (in select mode)' },
    { keys: 'Ctrl + Shift + C', description: 'Clear all filters' },
    { keys: 'Shift + Click', description: 'Range select items (in select mode)' },
  ]

  return (
    <div className="shortcuts-modal-backdrop" onClick={onClose}>
      <div className="shortcuts-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-modal-header">
          <h2>Keyboard Shortcuts</h2>
          <button className="shortcuts-modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="shortcuts-list">
          {shortcuts.map((shortcut, idx) => (
            <div key={idx} className="shortcut-item">
              <span className="shortcut-description">{shortcut.description}</span>
              <kbd className="shortcut-keys">{shortcut.keys}</kbd>
            </div>
          ))}
        </div>

        <div className="shortcuts-tip">
          <strong>Tip:</strong> Hold Shift while clicking items to select a range
        </div>
      </div>
    </div>
  )
}
