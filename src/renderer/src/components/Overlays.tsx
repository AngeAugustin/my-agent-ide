import { useEffect, useRef } from 'react'
import { dismissToast, useIde } from '../store/ide'
import { Icon } from './Icon'

export function Dialog() {
  const dialog = useIde((s) => s.dialog)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!dialog) return
    primaryRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dialog.resolve(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialog])

  if (!dialog) return null
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="modal-title">
        <div className="modal-icon">
          <Icon name="info" />
        </div>
        <div className="modal-content">
          <h3 id="modal-title">{dialog.title}</h3>
          {dialog.message && <p>{dialog.message}</p>}
          <div className="modal-buttons">
            {dialog.buttons.map((b) => (
              <button
                key={b.value}
                ref={b.primary ? primaryRef : undefined}
                className={`btn${b.primary ? ' primary' : ''}${b.danger && !b.primary ? ' danger' : ''}${b.danger && b.primary ? ' danger-primary' : ''}`}
                onClick={() => dialog.resolve(b.value)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useIde((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'error' : t.kind === 'success' ? 'pass' : 'info'} />
          <span>{t.message}</span>
          <button className="icon-button" title="Fermer" onClick={() => dismissToast(t.id)}>
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  )
}
