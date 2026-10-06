import { useEffect, useRef, useState } from 'react'
import { openPalette, openSettings, pickWorkspace, reportError, showSidebarView, useIde } from '../store/ide'
import { focusChat, sendMessage } from '../store/chat'
import { useGit } from '../store/git'
import { modelLabel, useAi } from '../store/ai'
import { basename } from '../lib/paths'
import { formatKeybinding } from '../lib/keybindings'
import { Icon } from './Icon'

const isMac = window.api.platform === 'darwin'

/** Logo : chevrons et point central, aux couleurs de l'accent. */
export function AppLogo({ size = 28 }: { size?: number }) {
  return (
    <svg className="app-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4cd7f6" />
          <stop offset="1" stopColor="#6d7cff" />
        </linearGradient>
      </defs>
      <path d="M11 8 4 16l7 8" fill="none" stroke="url(#logo-grad)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m21 8 7 8-7 8" fill="none" stroke="url(#logo-grad)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="2.6" fill="#4cd7f6" />
    </svg>
  )
}

function Notifications({ onClose }: { onClose: () => void }) {
  const items = useIde((s) => s.notifications)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])
  return (
    <div className="titlebar-popover" ref={ref} role="dialog" aria-label="Notifications">
      <div className="titlebar-popover-header">
        <span>Notifications</span>
        {items.length > 0 && (
          <button className="link-button" onClick={() => useIde.setState({ notifications: [] })}>
            Tout effacer
          </button>
        )}
      </div>
      {items.length === 0 && <div className="muted small titlebar-popover-empty">Aucune notification.</div>}
      {items.map((n) => (
        <div key={n.id} className={`notification-item ${n.kind}`}>
          <Icon name={n.kind === 'error' ? 'error' : n.kind === 'success' ? 'pass' : 'info'} />
          <div>
            <div>{n.message}</div>
            <div className="muted small">{new Date(n.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Barre de titre intégrée : projet et branche, champ « Demandez à l'IA », état de l'IA et actions rapides. */
export function TitleBar() {
  const workspace = useIde((s) => s.workspace)
  const unread = useIde((s) => s.unreadNotifications)
  const chatModel = useIde((s) => s.settings.ai.models.chat)
  const providers = useAi((s) => s.providers)
  const git = useGit((s) => s.status)
  const [ask, setAsk] = useState('')
  const [showNotifications, setShowNotifications] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusNonce = useIde((s) => s.askFocusNonce)

  useEffect(() => {
    if (focusNonce) inputRef.current?.focus()
  }, [focusNonce])

  const provider = chatModel ? providers.find((p) => p.id === chatModel.providerId) : undefined
  const aiReady = !!chatModel && !!provider && (provider.hasKey || !provider.requiresKey)
  const dirty = (git?.files.length ?? 0) > 0

  const submit = () => {
    const text = ask.trim()
    if (!text) return
    setAsk('')
    if (text.startsWith('>')) return openPalette('commands', text.slice(1).trim())
    focusChat()
    sendMessage(text).catch((err: unknown) => reportError('Envoi impossible', err))
  }

  return (
    <header className={`titlebar${isMac ? ' mac' : ''}`} onDoubleClick={(e) => e.target === e.currentTarget && window.api.app.toggleFullScreen()}>
      {!isMac && (
        <button
          className="titlebar-icon no-drag"
          title="Menu de l’application"
          aria-label="Menu de l’application"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            window.api.app.popupMenu(r.left, r.bottom + 4)
          }}
        >
          <Icon name="menu" />
        </button>
      )}
      <div className="titlebar-brand">
        <AppLogo />
        <span className="titlebar-name">My Agent IDE</span>
      </div>
      <button
        className="titlebar-project no-drag"
        title={workspace ? `${workspace}${git?.branch ? ` — branche ${git.branch}` : ''}` : 'Ouvrir un dossier'}
        onClick={() => (workspace ? showSidebarView('git') : void pickWorkspace())}
      >
        <Icon name="repo" />
        <span className="titlebar-project-name">{workspace ? basename(workspace) : 'Aucun dossier'}</span>
        {git?.branch && (
          <>
            <span className="titlebar-sep">·</span>
            <span className="titlebar-branch">
              {git.branch}
              {dirty ? '*' : ''}
            </span>
          </>
        )}
      </button>
      <div className="titlebar-ask no-drag">
        <Icon name="terminal" />
        <input
          ref={inputRef}
          value={ask}
          placeholder="Demandez à l’IA ou tapez > pour une commande…"
          aria-label="Demander à l’IA"
          onChange={(e) => {
            const v = e.target.value
            if (v === '>') {
              setAsk('')
              openPalette('commands')
              return
            }
            setAsk(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') {
              setAsk('')
              inputRef.current?.blur()
            }
          }}
        />
        <kbd>{formatKeybinding('Mod+E')}</kbd>
      </div>
      <div className="titlebar-actions no-drag">
        <button
          className={`titlebar-pill${aiReady ? ' ready' : ' off'}`}
          title={aiReady ? `Modèle de chat : ${modelLabel(chatModel)}` : 'Aucun modèle configuré : cliquez pour ajouter une clé API'}
          onClick={() => openSettings('ai')}
        >
          <span className="dot" />
          {aiReady ? 'IA prête' : 'Configurer l’IA'}
        </button>
        {workspace && git?.isRepo && (
          <button className="titlebar-button" title="Contrôle de source (Ctrl+Maj+G)" onClick={() => showSidebarView('git')}>
            <Icon name="git-commit" /> Commit{dirty ? ` (${git.files.length})` : ''}
          </button>
        )}
        <div className="titlebar-popover-anchor">
          <button
            className="titlebar-icon"
            title="Notifications"
            aria-label="Notifications"
            onClick={() => {
              setShowNotifications((v) => !v)
              useIde.setState({ unreadNotifications: 0 })
            }}
          >
            <Icon name="bell" />
            {unread > 0 && <span className="titlebar-badge">{unread > 9 ? '9+' : unread}</span>}
          </button>
          {showNotifications && <Notifications onClose={() => setShowNotifications(false)} />}
        </div>
        <button className="titlebar-icon" title="Paramètres (Ctrl+,)" aria-label="Paramètres" onClick={() => openSettings()}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
