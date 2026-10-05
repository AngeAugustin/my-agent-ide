import { useEffect, useRef, useState } from 'react'
import type { InlineState } from '../lib/inlineEdit'
import { modelLabel } from '../store/ai'
import { formatKeybinding } from '../lib/keybindings'
import { Icon } from './Icon'

interface Props {
  state: InlineState
  onSubmit(instruction: string): void
  onAccept(): void
  onReject(): void
  onStop(): void
}

/** Boîte affichée au-dessus du code pendant l'édition en ligne (Ctrl+K). */
export function InlineEditWidget({ state, onSubmit, onAccept, onReject, onStop }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const { status } = state

  useEffect(() => {
    if (status === 'input' || status === 'review' || status === 'error') ref.current?.focus()
  }, [status])

  const placeholder =
    status === 'review'
      ? 'Affiner la modification…'
      : state.hasSelection
        ? 'Décrivez la modification à apporter au code sélectionné…'
        : 'Décrivez le code à générer ici…'

  return (
    <div
      className={`inline-edit ${status}`}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="inline-edit-row">
        <Icon name="sparkle" />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={status === 'streaming'}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && status === 'review') {
              e.preventDefault()
              onAccept()
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (text.trim()) {
                onSubmit(text.trim())
                setText('')
              }
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onReject()
            }
          }}
        />
        <button className="icon-button" title="Fermer (Échap)" onClick={onReject}>
          <Icon name="close" />
        </button>
      </div>
      <div className="inline-edit-footer">
        <span className="muted small">{modelLabel(state.model)}</span>
        {state.history.length > 0 && <span className="muted small inline-edit-last">« {state.history[state.history.length - 1]} »</span>}
        {status === 'streaming' && (
          <>
            <span className="small">
              <Icon name="loading" className="codicon-modifier-spin" /> Génération…
            </span>
            <button className="btn small-btn" onClick={onStop}>
              Arrêter
            </button>
          </>
        )}
        {status === 'review' && (
          <>
            {state.stats && (
              <span className="diff-stats small">
                <span className="added">+{state.stats.added}</span> <span className="removed">−{state.stats.removed}</span>
              </span>
            )}
            <button className="btn small-btn danger" onClick={onReject} title="Rejeter (Échap)">
              Rejeter <kbd>Échap</kbd>
            </button>
            <button className="btn small-btn primary" onClick={onAccept} title="Accepter">
              Accepter <kbd>{formatKeybinding('Mod+Enter')}</kbd>
            </button>
          </>
        )}
        {status === 'error' && <span className="error-text small">{state.error}</span>}
        {status === 'input' && <span className="muted small">Entrée pour envoyer · Échap pour fermer</span>}
      </div>
    </div>
  )
}
