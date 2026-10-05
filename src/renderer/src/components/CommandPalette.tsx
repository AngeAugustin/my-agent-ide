import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { closePalette, getFileIndex, openFile, openSettings, revealLine, useIde, type PaletteMode } from '../store/ide'
import { readyProviders, setModelForRole } from '../store/ai'
import { commands } from '../lib/commands'
import { fuzzyFilter } from '../lib/fuzzy'
import { formatKeybinding } from '../lib/keybindings'
import { fileIcon } from '../lib/fileIcons'
import { basename, relative } from '../lib/paths'
import { getActiveEditor } from '../lib/activeEditor'
import { monaco } from '../lib/monaco'
import { Icon } from './Icon'

interface Item {
  key: string
  label: string
  description?: string
  positions?: number[]
  icon?: { icon: string; color?: string }
  keybinding?: string
  run: () => void
}

function Highlighted({ text, positions }: { text: string; positions?: number[] }) {
  if (!positions || positions.length === 0) return <>{text}</>
  const set = new Set(positions)
  const out: ReactNode[] = []
  let buf = ''
  let inMatch = false
  for (let i = 0; i <= text.length; i++) {
    const m = set.has(i)
    if (i === text.length || m !== inMatch) {
      if (buf) out.push(inMatch ? <mark key={i}>{buf}</mark> : <span key={i}>{buf}</span>)
      buf = ''
      inMatch = m
    }
    if (i < text.length) buf += text[i]
  }
  return <>{out}</>
}

function languageCommands(): Item[] {
  const editor = getActiveEditor()
  const model = editor?.getModel()
  if (!model) return []
  return monaco.languages
    .getLanguages()
    .map((l) => ({
      key: `lang:${l.id}`,
      label: `Langage : ${l.aliases?.[0] ?? l.id}`,
      description: l.id === model.getLanguageId() ? 'actuel' : undefined,
      run: () => monaco.editor.setModelLanguage(model, l.id)
    }))
}

export function CommandPalette() {
  const palette = useIde((s) => s.palette)
  if (!palette.open) return null
  // Remonté à chaque ouverture : l'état repart de zéro sans effet de bord asynchrone.
  return <PaletteBody key={palette.nonce} mode={palette.mode} initial={palette.initial} />
}

function initialValue(mode: PaletteMode, initial: string): string {
  const prefix = mode === 'commands' ? '>' : mode === 'line' ? ':' : ''
  return prefix && initial.startsWith(prefix) ? initial : prefix + initial
}

function modelItems(query: string): Item[] {
  const current = useIde.getState().settings.ai.models.chat
  const all: Item[] = readyProviders().flatMap((p) =>
    p.models.map((m) => ({
      key: `${p.id}::${m.id}`,
      label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id,
      description: p.name + (current?.providerId === p.id && current.modelId === m.id ? ' · actuel' : ''),
      icon: { icon: 'sparkle' },
      run: () => setModelForRole('chat', { providerId: p.id, modelId: m.id })
    }))
  )
  const configure: Item = { key: 'configure', label: 'Configurer les fournisseurs et les clés API…', icon: { icon: 'settings-gear' }, run: () => openSettings('ai') }
  if (!query) return [...all, configure]
  return [...fuzzyFilter(query, all, (i) => `${i.label} ${i.description}`).map(({ item }) => item), configure]
}

function PaletteBody({ mode: initialMode, initial }: { mode: PaletteMode; initial: string }) {
  const workspace = useIde((s) => s.workspace)
  const tabs = useIde((s) => s.tabs)
  const [value, setValue] = useState(() => initialValue(initialMode, initial))
  const [selected, setSelected] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  const mode: PaletteMode =
    initialMode === 'models' ? 'models' : value.startsWith('>') ? 'commands' : value.startsWith(':') ? 'line' : 'files'
  const query = mode === 'files' || mode === 'models' ? value.trim() : value.slice(1).trim()

  useEffect(() => {
    if (mode === 'files' && files.length === 0) void getFileIndex().then(setFiles)
  }, [mode, files.length])

  const items: Item[] = useMemo(() => {
    if (mode === 'models') return modelItems(query)
    if (mode === 'commands') {
      const available = commands
        .filter((c) => !c.when || c.when())
        .map<Item>((c) => ({
          key: c.id,
          label: c.category ? `${c.category} : ${c.title}` : c.title,
          keybinding: c.keybinding,
          run: () => void c.run()
        }))
      const pool = /^lang/i.test(query) ? [...available, ...languageCommands()] : available
      if (!query) return pool
      return fuzzyFilter(query, pool, (i) => i.label).map(({ item, match }) => ({ ...item, positions: match.positions }))
    }

    if (mode === 'line') {
      const editor = getActiveEditor()
      const model = editor?.getModel()
      if (!model) return [{ key: 'none', label: 'Ouvrez un fichier pour aller à une ligne.', run: () => {} }]
      const [l, c] = query.split(/[:,]/).map((x) => parseInt(x, 10))
      const count = model.getLineCount()
      if (!query || Number.isNaN(l)) {
        return [{ key: 'hint', label: `Tapez un numéro de ligne entre 1 et ${count}.`, run: () => {} }]
      }
      return [
        {
          key: 'go',
          label: `Aller à la ligne ${l}${c ? `, colonne ${c}` : ''}`,
          run: () => revealLine(Math.min(l, count), c || 1)
        }
      ]
    }

    const toItem = (path: string, positions?: number[], recent = false): Item => {
      const rel = workspace ? relative(workspace, path) : path
      const name = basename(path)
      const nameOffset = rel.length - name.length
      return {
        key: path,
        label: name,
        description: (recent ? 'récemment ouvert · ' : '') + rel.slice(0, nameOffset).replace(/[\\/]$/, ''),
        positions: positions?.filter((p) => p >= nameOffset).map((p) => p - nameOffset),
        icon: fileIcon(path),
        run: () => void openFile(path)
      }
    }

    const open = tabs.filter((t) => t.kind === 'file').map((t) => t.id)
    if (!query) {
      const rest = files.filter((f) => !open.includes(f)).slice(0, 100)
      return [...open.map((p) => toItem(p, undefined, true)), ...rest.map((p) => toItem(p))]
    }
    return fuzzyFilter(query, files, (f) => (workspace ? relative(workspace, f) : f), 100).map(({ item, match }) =>
      toItem(item, match.positions)
    )
  }, [mode, query, files, tabs, workspace])

  useEffect(() => setSelected(0), [query, mode])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const accept = (item: Item | undefined) => {
    if (!item) return
    closePalette()
    // Laisse la palette se fermer avant d'exécuter (certaines commandes déplacent le focus).
    setTimeout(item.run, 0)
  }

  const placeholder =
    mode === 'models'
      ? 'Choisissez le modèle de chat'
      : mode === 'commands'
      ? 'Tapez le nom d’une commande'
      : mode === 'line'
        ? 'Numéro de ligne (ex. : 42 ou 42:10)'
        : workspace
          ? 'Rechercher un fichier par nom (« > » pour les commandes, « : » pour une ligne)'
          : 'Ouvrez un dossier pour rechercher des fichiers (« > » pour les commandes)'

  return (
    <div className="palette-backdrop" onMouseDown={closePalette}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Palette de commandes">
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected((i) => Math.min(i + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              accept(items[selected])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              closePalette()
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">Aucun résultat</div>}
          {items.map((item, i) => (
            <div
              key={item.key}
              className={`palette-item${i === selected ? ' selected' : ''}`}
              onMouseMove={() => setSelected(i)}
              onClick={() => accept(item)}
            >
              {item.icon && <Icon name={item.icon.icon} color={item.icon.color} />}
              <span className="palette-label">
                <Highlighted text={item.label} positions={item.positions} />
              </span>
              {item.description && <span className="palette-description">{item.description}</span>}
              {item.keybinding && <kbd>{formatKeybinding(item.keybinding)}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
