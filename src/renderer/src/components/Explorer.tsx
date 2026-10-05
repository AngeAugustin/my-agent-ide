import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { FileEntry } from '@shared/types'
import {
  cancelInput,
  collapseAll,
  createEntry,
  deleteEntry,
  openFile,
  openWorkspace,
  pickWorkspace,
  refreshTree,
  renameEntry,
  startInput,
  targetDirectory,
  toggleDir,
  useIde,
  type PendingInput
} from '../store/ide'
import { fileIcon } from '../lib/fileIcons'
import { basename, dirname, isInside, join, relative, validateFileName } from '../lib/paths'
import { Icon } from './Icon'
import { showContextMenu, type MenuItem } from './ContextMenu'
import { newTerminal } from '../store/terminals'

const INDENT = 12

function InlineInput({
  input,
  depth,
  isDirectory
}: {
  input: PendingInput
  depth: number
  isDirectory: boolean
}) {
  const initial = input.mode === 'rename' ? basename(input.path) : ''
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Sélectionne le nom sans l'extension, comme VS Code.
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 && !isDirectory ? dot : initial.length)
  }, [initial, isDirectory])

  const error = value && value !== initial ? validateFileName(value) : null

  const commit = () => {
    if (done.current) return
    done.current = true
    cancelInput()
    if (!value.trim() || value === initial || validateFileName(value)) return
    if (input.mode === 'rename') void renameEntry(input.path, join(dirname(input.path), value.trim()))
    else void createEntry(input.path, value, input.mode === 'newFolder')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') {
      done.current = true
      cancelInput()
    }
  }

  const icon = isDirectory ? { icon: 'folder', color: 'var(--folder)' } : fileIcon(value || 'x')
  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * INDENT + 16 }}>
      <Icon name={icon.icon} color={icon.color} />
      <div className="tree-input-wrap">
        <input
          ref={ref}
          className={`tree-input${error ? ' invalid' : ''}`}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
        {error && <div className="tree-input-error">{error}</div>}
      </div>
    </div>
  )
}

function TreeNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  const expanded = useIde((s) => !!s.expanded[entry.path])
  const children = useIde((s) => s.tree[entry.path])
  const selected = useIde((s) => s.selectedPath === entry.path)
  const active = useIde((s) => s.activeId === entry.path)
  const dirty = useIde((s) => s.tabs.some((t) => t.id === entry.path && t.dirty))
  const pending = useIde((s) => s.pendingInput)
  const workspace = useIde((s) => s.workspace)!
  const [dropTarget, setDropTarget] = useState(false)

  if (pending?.mode === 'rename' && pending.path === entry.path) {
    return <InlineInput input={pending} depth={depth} isDirectory={entry.isDirectory} />
  }

  const onClick = () => {
    useIde.setState({ selectedPath: entry.path })
    if (entry.isDirectory) void toggleDir(entry.path)
    else void openFile(entry.path, { preview: true })
  }

  const onDoubleClick = () => {
    if (!entry.isDirectory) void openFile(entry.path, { preview: false })
  }

  const dir = entry.isDirectory ? entry.path : dirname(entry.path)
  const menu: MenuItem[] = [
    ...(entry.isDirectory
      ? [
          { label: 'Nouveau fichier…', run: () => startInput({ path: dir, mode: 'newFile' }) },
          { label: 'Nouveau dossier…', run: () => startInput({ path: dir, mode: 'newFolder' }) },
          { label: 'Ouvrir dans le terminal intégré', run: () => openTerminalAt(dir) },
          { separator: true }
        ]
      : [{ label: 'Ouvrir', run: () => openFile(entry.path) }, { separator: true }]),
    { label: 'Révéler dans le gestionnaire de fichiers', run: () => window.api.shell.revealInFolder(entry.path) },
    { separator: true },
    { label: 'Copier le chemin', run: () => navigator.clipboard.writeText(entry.path) },
    { label: 'Copier le chemin relatif', run: () => navigator.clipboard.writeText(relative(workspace, entry.path)) },
    { separator: true },
    { label: 'Renommer…', keybinding: 'F2', run: () => startInput({ path: entry.path, mode: 'rename' }) },
    { label: 'Supprimer', keybinding: 'Delete', danger: true, run: () => deleteEntry(entry.path) }
  ]

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('application/x-ide-path', entry.path)
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (e: DragEvent) => {
    if (!entry.isDirectory || !e.dataTransfer.types.includes('application/x-ide-path')) return
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(true)
  }

  const onDrop = (e: DragEvent) => {
    setDropTarget(false)
    const source = e.dataTransfer.getData('application/x-ide-path')
    if (!source || !entry.isDirectory) return
    e.preventDefault()
    e.stopPropagation()
    if (isInside(source, entry.path) || dirname(source) === entry.path) return
    void renameEntry(source, join(entry.path, basename(source))).then(() => toggleDir(entry.path, true))
  }

  const icon = entry.isDirectory
    ? { icon: expanded ? 'folder-opened' : 'folder', color: 'var(--folder)' }
    : fileIcon(entry.path)

  return (
    <>
      <div
        className={`tree-row${selected ? ' selected' : ''}${active ? ' active' : ''}${dropTarget ? ' drop-target' : ''}`}
        style={{ paddingLeft: 8 + depth * INDENT }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          useIde.setState({ selectedPath: entry.path })
          showContextMenu(e, menu)
        }}
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => setDropTarget(false)}
        onDrop={onDrop}
        title={entry.path}
        data-path={entry.path}
      >
        <span className="twistie">
          {entry.isDirectory && <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />}
        </span>
        <Icon name={icon.icon} color={icon.color} />
        <span className="tree-label">{entry.name}</span>
        {dirty && <span className="dirty-dot" title="Non enregistré" />}
      </div>
      {entry.isDirectory && expanded && (
        <TreeChildren dir={entry.path} entries={children} depth={depth + 1} />
      )}
    </>
  )
}

function TreeChildren({ dir, entries, depth }: { dir: string; entries?: FileEntry[]; depth: number }) {
  const pending = useIde((s) => s.pendingInput)
  const creating = pending && pending.mode !== 'rename' && pending.path === dir
  if (!entries) return <div className="tree-row muted" style={{ paddingLeft: 8 + depth * INDENT + 16 }}>Chargement…</div>
  return (
    <>
      {creating && <InlineInput input={pending} depth={depth} isDirectory={pending.mode === 'newFolder'} />}
      {entries.map((e) => (
        <TreeNode key={e.path} entry={e} depth={depth} />
      ))}
    </>
  )
}

function openTerminalAt(dir: string) {
  newTerminal(dir)
}

export function Explorer() {
  const workspace = useIde((s) => s.workspace)
  const rootEntries = useIde((s) => (s.workspace ? s.tree[s.workspace] : undefined))
  const recent = useIde((s) => s.recentWorkspaces)
  const [rootDrop, setRootDrop] = useState(false)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { selectedPath, pendingInput } = useIde.getState()
    if (!selectedPath || pendingInput || selectedPath === workspace) return
    if (e.key === 'F2') {
      e.preventDefault()
      startInput({ path: selectedPath, mode: 'rename' })
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      e.preventDefault()
      void deleteEntry(selectedPath)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void openFile(selectedPath, { preview: false })
    }
  }

  if (!workspace) {
    return (
      <div className="sidebar-section">
        <div className="sidebar-header">
          <span>Explorateur</span>
        </div>
        <div className="explorer-empty">
          <p>Aucun dossier n’est ouvert.</p>
          <button className="btn primary block" onClick={pickWorkspace}>
            Ouvrir un dossier
          </button>
          {recent.length > 0 && (
            <>
              <p className="muted small">Récents</p>
              {recent.slice(0, 5).map((r) => (
                <button key={r} className="link-button" title={r} onClick={() => openWorkspace(r)}>
                  {basename(r)}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    )
  }

  const newIn = (mode: 'newFile' | 'newFolder') => {
    const dir = targetDirectory()
    if (dir) startInput({ path: dir, mode })
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-header">
        <span className="sidebar-title" title={workspace}>
          {basename(workspace)}
        </span>
        <div className="sidebar-actions">
          <button className="icon-button" title="Nouveau fichier" onClick={() => newIn('newFile')}>
            <Icon name="new-file" />
          </button>
          <button className="icon-button" title="Nouveau dossier" onClick={() => newIn('newFolder')}>
            <Icon name="new-folder" />
          </button>
          <button className="icon-button" title="Actualiser l’explorateur" onClick={refreshTree}>
            <Icon name="refresh" />
          </button>
          <button className="icon-button" title="Réduire les dossiers" onClick={collapseAll}>
            <Icon name="collapse-all" />
          </button>
        </div>
      </div>
      <div
        className={`tree${rootDrop ? ' drop-target' : ''}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (e.target === e.currentTarget) useIde.setState({ selectedPath: null })
        }}
        onContextMenu={(e) =>
          showContextMenu(e, [
            { label: 'Nouveau fichier…', run: () => startInput({ path: workspace, mode: 'newFile' }) },
            { label: 'Nouveau dossier…', run: () => startInput({ path: workspace, mode: 'newFolder' }) },
            { separator: true },
            { label: 'Ouvrir dans le terminal intégré', run: () => openTerminalAt(workspace) },
            { label: 'Révéler dans le gestionnaire de fichiers', run: () => window.api.shell.revealInFolder(workspace) },
            { label: 'Actualiser', run: refreshTree }
          ])
        }
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-ide-path')) return
          e.preventDefault()
          setRootDrop(true)
        }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={(e) => {
          setRootDrop(false)
          const source = e.dataTransfer.getData('application/x-ide-path')
          if (source && dirname(source) !== workspace) void renameEntry(source, join(workspace, basename(source)))
        }}
      >
        <TreeChildren dir={workspace} entries={rootEntries} depth={0} />
      </div>
    </div>
  )
}
