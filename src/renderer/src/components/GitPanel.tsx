import { useEffect, useState } from 'react'
import { describeStatus, isConflict, isStaged, isUnstaged, type GitBranch, type GitFileStatus } from '@shared/git'
import {
  checkout,
  commit,
  discardFiles,
  fetchAll,
  generateCommitMessage,
  initRepo,
  openGitDiff,
  pull,
  push,
  refreshGit,
  stageFiles,
  unstageFiles,
  useGit
} from '../store/git'
import { openFile, useIde } from '../store/ide'
import { fileIcon } from '../lib/fileIcons'
import { basename, join } from '../lib/paths'
import { showContextMenu } from './ContextMenu'
import { Icon } from './Icon'

function FileRow({ file, staged }: { file: GitFileStatus; staged: boolean }) {
  const ws = useIde((s) => s.workspace)!
  const code = staged ? file.index : file.index === '?' ? '?' : isConflict(file) ? 'U' : file.worktree
  const st = describeStatus(code)
  const icon = fileIcon(file.path)
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
  return (
    <div
      className="tree-row git-file"
      title={`${file.path} — ${st.label}`}
      onClick={() => openGitDiff(file, staged)}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Voir les modifications', run: () => openGitDiff(file, staged) },
          { label: 'Ouvrir le fichier', disabled: code === 'D', run: () => openFile(join(ws, file.path)) },
          { separator: true },
          staged ? { label: 'Désindexer', run: () => unstageFiles([file.path]) } : { label: 'Indexer', run: () => stageFiles([file.path]) },
          ...(!staged ? [{ label: 'Annuler les modifications', danger: true, run: () => discardFiles([file]) }] : [])
        ])
      }
    >
      <Icon name={icon.icon} color={icon.color} />
      <span className={`tree-label git-${st.kind}`}>{basename(file.path)}</span>
      {dir && <span className="muted small path-hint">{dir}</span>}
      <span className="git-row-actions">
        {code !== 'D' && (
          <button className="icon-button" title="Ouvrir le fichier" onClick={(e) => { e.stopPropagation(); void openFile(join(ws, file.path)) }}>
            <Icon name="go-to-file" />
          </button>
        )}
        {!staged && (
          <button className="icon-button" title="Annuler les modifications" onClick={(e) => { e.stopPropagation(); void discardFiles([file]) }}>
            <Icon name="discard" />
          </button>
        )}
        <button
          className="icon-button"
          title={staged ? 'Désindexer' : 'Indexer'}
          onClick={(e) => {
            e.stopPropagation()
            void (staged ? unstageFiles([file.path]) : stageFiles([file.path]))
          }}
        >
          <Icon name={staged ? 'remove' : 'add'} />
        </button>
      </span>
      <span className={`git-letter git-${st.kind}`}>{st.letter}</span>
    </div>
  )
}

function Section({ title, files, staged, actions }: { title: string; files: GitFileStatus[]; staged: boolean; actions: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  if (files.length === 0) return null
  return (
    <div className="git-section">
      <div className="git-section-header" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{title}</span>
        <span className="git-section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
        <span className="badge">{files.length}</span>
      </div>
      {open && files.map((f) => <FileRow key={`${staged}-${f.path}`} file={f} staged={staged} />)}
    </div>
  )
}

function BranchPicker({ onClose }: { onClose: () => void }) {
  const ws = useIde((s) => s.workspace)!
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [filter, setFilter] = useState('')
  useEffect(() => {
    void window.api.git.branches(ws).then(setBranches, () => setBranches([]))
  }, [ws])
  const name = filter.trim()
  const shown = branches.filter((b) => b.name.toLowerCase().includes(name.toLowerCase()))
  const valid = /^[\w./-]+$/.test(name) && !name.startsWith('-') && !branches.some((b) => b.name === name)
  return (
    <div className="branch-picker">
      <input
        autoFocus
        placeholder="Filtrer ou nommer une nouvelle branche…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && valid) {
            onClose()
            void checkout(name, true)
          }
        }}
      />
      <div className="branch-list">
        {valid && (
          <div className="branch-item create" onClick={() => { onClose(); void checkout(name, true) }}>
            <Icon name="add" /> Créer la branche « {name} »
          </div>
        )}
        {shown.map((b) => (
          <div
            key={b.name}
            className={`branch-item${b.current ? ' current' : ''}`}
            onClick={() => {
              onClose()
              if (!b.current) void checkout(b.remote ? b.name.replace(/^[^/]+\//, '') : b.name)
            }}
          >
            <Icon name={b.remote ? 'cloud' : 'git-branch'} /> {b.name} {b.current && <span className="muted small">(actuelle)</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function GitPanel() {
  const workspace = useIde((s) => s.workspace)
  const { status, busy, message, generating, amend } = useGit()
  const [picker, setPicker] = useState(false)

  useEffect(() => {
    void refreshGit()
  }, [])

  if (!workspace) {
    return (
      <div className="sidebar-section">
        <div className="sidebar-header">
          <span>Contrôle de source</span>
        </div>
        <p className="explorer-empty muted">Ouvrez un dossier pour utiliser Git.</p>
      </div>
    )
  }

  if (status && !status.isRepo) {
    return (
      <div className="sidebar-section">
        <div className="sidebar-header">
          <span>Contrôle de source</span>
        </div>
        <div className="explorer-empty">
          <p className="muted">Ce dossier n’est pas un dépôt Git.</p>
          <button className="btn primary block" disabled={!!busy} onClick={initRepo}>
            Initialiser un dépôt
          </button>
        </div>
      </div>
    )
  }

  const files = status?.files ?? []
  const conflicts = files.filter(isConflict)
  const staged = files.filter((f) => isStaged(f) && !isConflict(f))
  const unstaged = files.filter((f) => isUnstaged(f) && !isConflict(f))

  return (
    <div className="sidebar-section">
      <div className="sidebar-header">
        <span>Contrôle de source</span>
        <div className="sidebar-actions">
          <button className="icon-button" title="Actualiser" onClick={() => refreshGit()}>
            <Icon name="refresh" className={busy ? 'codicon-modifier-spin' : undefined} />
          </button>
          <button className="icon-button" title="Pull" disabled={!!busy} onClick={pull}>
            <Icon name="arrow-down" />
          </button>
          <button className="icon-button" title="Push" disabled={!!busy} onClick={push}>
            <Icon name="arrow-up" />
          </button>
          <button className="icon-button" title="Fetch" disabled={!!busy} onClick={fetchAll}>
            <Icon name="cloud-download" />
          </button>
        </div>
      </div>

      <div className="git-branch" onClick={() => setPicker((v) => !v)} title="Changer de branche">
        <Icon name="git-branch" />
        <span>{status?.branch ?? 'HEAD détachée'}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="muted small">
            {status.ahead > 0 && `↑${status.ahead} `}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        {status && !status.upstream && status.branch && <span className="muted small">(non publiée)</span>}
        <Icon name="chevron-down" className="muted" />
      </div>
      {picker && <BranchPicker onClose={() => setPicker(false)} />}

      <div className="git-commit">
        <div className="git-message">
          <textarea
            rows={3}
            value={message}
            placeholder={`Message de commit (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Entrée pour commiter)`}
            onChange={(e) => useGit.setState({ message: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void commit()
              }
            }}
          />
          <button className="icon-button git-generate" title="Générer le message avec l’IA" disabled={generating} onClick={generateCommitMessage}>
            <Icon name={generating ? 'loading' : 'sparkle'} className={generating ? 'codicon-modifier-spin' : undefined} />
          </button>
        </div>
        <div className="git-commit-row">
          <label className="checkbox small">
            <input type="checkbox" checked={amend} onChange={(e) => useGit.setState({ amend: e.target.checked })} /> Modifier le dernier commit
          </label>
          <button className="btn primary" disabled={!!busy || generating} onClick={commit}>
            <Icon name="check" /> Commit
          </button>
        </div>
      </div>

      <div className="git-files">
        <Section
          title="Conflits"
          files={conflicts}
          staged={false}
          actions={null}
        />
        <Section
          title="Modifications indexées"
          files={staged}
          staged
          actions={
            <button className="icon-button" title="Tout désindexer" onClick={() => unstageFiles(staged.map((f) => f.path))}>
              <Icon name="remove" />
            </button>
          }
        />
        <Section
          title="Modifications"
          files={unstaged}
          staged={false}
          actions={
            <>
              <button className="icon-button" title="Tout annuler" onClick={() => discardFiles(unstaged)}>
                <Icon name="discard" />
              </button>
              <button className="icon-button" title="Tout indexer" onClick={() => stageFiles(unstaged.map((f) => f.path))}>
                <Icon name="add" />
              </button>
            </>
          }
        />
        {status && files.length === 0 && <p className="explorer-empty muted">Aucune modification.</p>}
      </div>
    </div>
  )
}
