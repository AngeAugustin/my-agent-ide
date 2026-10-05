import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  type FileEntry,
  type FsChangeEvent,
  type SessionState,
  type Settings
} from '@shared/types'
import * as models from '../lib/editorModels'
import { basename, dirname, isInside, join } from '../lib/paths'

export type TabKind = 'file' | 'untitled' | 'settings'
export type SidebarView = 'explorer' | 'search'
export type PaletteMode = 'files' | 'commands' | 'line' | 'models'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  dirty: boolean
  /** Onglet d'aperçu : remplacé à la prochaine ouverture tant qu'il n'est pas modifié. */
  preview: boolean
}

export interface Reveal {
  path: string
  line: number
  column: number
  length?: number
  nonce: number
}

export interface DialogButton {
  label: string
  value: string
  primary?: boolean
  danger?: boolean
}

export interface DialogRequest {
  title: string
  message?: string
  buttons: DialogButton[]
  resolve: (value: string | null) => void
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  message: string
}

export interface PendingInput {
  /** Dossier parent pour une création, chemin de l'élément pour un renommage. */
  path: string
  mode: 'newFile' | 'newFolder' | 'rename'
}

export interface CursorInfo {
  line: number
  column: number
  selected: number
  language: string
  eol: 'LF' | 'CRLF'
  tabSize: number
  insertSpaces: boolean
}

interface IdeState {
  ready: boolean
  settings: Settings
  workspace: string | null
  recentWorkspaces: string[]

  tree: Record<string, FileEntry[]>
  expanded: Record<string, boolean>
  selectedPath: string | null
  pendingInput: PendingInput | null
  fileIndex: string[] | null

  tabs: Tab[]
  activeId: string | null
  reveal: Reveal | null
  cursor: CursorInfo | null

  sidebarVisible: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  panelVisible: boolean
  panelHeight: number
  palette: { open: boolean; mode: PaletteMode; initial: string; nonce: number }
  dialog: DialogRequest | null
  toasts: Toast[]
  searchFocusNonce: number
  settingsSection: string
}

const initialState: IdeState = {
  ready: false,
  settings: DEFAULT_SETTINGS,
  workspace: null,
  recentWorkspaces: [],
  tree: {},
  expanded: {},
  selectedPath: null,
  pendingInput: null,
  fileIndex: null,
  tabs: [],
  activeId: null,
  reveal: null,
  cursor: null,
  sidebarVisible: true,
  sidebarView: 'explorer',
  sidebarWidth: 260,
  panelVisible: false,
  panelHeight: 260,
  palette: { open: false, mode: 'files', initial: '', nonce: 0 },
  dialog: null,
  toasts: [],
  searchFocusNonce: 0,
  settingsSection: 'general'
}

export const SETTINGS_TAB = 'ide://settings'

export const useIde = create<IdeState>()(() => initialState)

const set = useIde.setState
const get = useIde.getState
let untitledCounter = 1
let toastCounter = 1

// ---------------------------------------------------------------------------
// Notifications et boîtes de dialogue
// ---------------------------------------------------------------------------

export function notify(message: string, kind: Toast['kind'] = 'info'): void {
  const id = toastCounter++
  set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4000)
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Retire le préfixe ajouté par Electron sur les erreurs IPC.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function reportError(context: string, err: unknown): void {
  notify(`${context} : ${errorMessage(err)}`, 'error')
}

export function ask(title: string, message: string | undefined, buttons: DialogButton[]): Promise<string | null> {
  return new Promise((resolve) => {
    set({
      dialog: {
        title,
        message,
        buttons,
        resolve: (value) => {
          set({ dialog: null })
          resolve(value)
        }
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Initialisation et session
// ---------------------------------------------------------------------------

export async function initialize(): Promise<void> {
  const [settings, session] = await Promise.all([window.api.settings.get(), window.api.session.get()])
  set({
    settings: { ...DEFAULT_SETTINGS, ...settings, ai: { ...DEFAULT_SETTINGS.ai, ...settings.ai } },
    recentWorkspaces: session.recentWorkspaces ?? []
  })

  if (session.workspace && (await window.api.fs.exists(session.workspace))) {
    await openWorkspace(session.workspace, { restore: false })
    for (const file of session.openFiles ?? []) {
      if (await window.api.fs.exists(file)) await openFile(file, { preview: false, focus: false })
    }
    if (session.activeFile && get().tabs.some((t) => t.id === session.activeFile)) {
      set({ activeId: session.activeFile })
    }
  }
  set({ ready: true })
}

let sessionTimer: ReturnType<typeof setTimeout> | null = null

function persistSession(): void {
  if (!get().ready) return
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = setTimeout(() => {
    const s = get()
    const session: SessionState = {
      workspace: s.workspace,
      openFiles: s.tabs.filter((t) => t.kind === 'file').map((t) => t.id),
      activeFile: s.activeId && !s.activeId.startsWith('ide://') ? s.activeId : null,
      recentWorkspaces: s.recentWorkspaces
    }
    void window.api.session.set(session)
  }, 300)
}

useIde.subscribe((state, prev) => {
  if (state.tabs !== prev.tabs || state.activeId !== prev.activeId || state.workspace !== prev.workspace) {
    persistSession()
  }
})

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

export function updateSettings(partial: Partial<Settings>): Promise<void> {
  const settings = { ...get().settings, ...partial }
  set({ settings })
  return window.api.settings.set(settings)
}

export function toggleTheme(): void {
  void updateSettings({ theme: get().settings.theme === 'dark' ? 'light' : 'dark' })
}

// ---------------------------------------------------------------------------
// Espace de travail et arborescence
// ---------------------------------------------------------------------------

export async function openWorkspace(path: string, _opts: { restore?: boolean } = {}): Promise<void> {
  if (get().workspace === path) return
  if (get().workspace && !(await closeAllTabs())) return

  const recent = [path, ...get().recentWorkspaces.filter((p) => p !== path)].slice(0, 10)
  set({
    workspace: path,
    recentWorkspaces: recent,
    tree: {},
    expanded: { [path]: true },
    selectedPath: null,
    fileIndex: null,
    sidebarVisible: true,
    sidebarView: 'explorer'
  })
  await loadDir(path)
  void window.api.fs.watch(path)
}

export async function pickWorkspace(): Promise<void> {
  const path = await window.api.dialog.openFolder()
  if (path) await openWorkspace(path)
}

export async function closeWorkspace(): Promise<void> {
  if (!(await closeAllTabs())) return
  set({ workspace: null, tree: {}, expanded: {}, selectedPath: null, fileIndex: null })
}

export async function loadDir(path: string): Promise<void> {
  try {
    const entries = await window.api.fs.readDir(path)
    set((s) => ({ tree: { ...s.tree, [path]: entries } }))
  } catch (err) {
    set((s) => {
      const tree = { ...s.tree }
      delete tree[path]
      return { tree }
    })
    if (path === get().workspace) reportError('Impossible de lire le dossier', err)
  }
}

export async function toggleDir(path: string, open?: boolean): Promise<void> {
  const next = open ?? !get().expanded[path]
  set((s) => ({ expanded: { ...s.expanded, [path]: next } }))
  if (next && !get().tree[path]) await loadDir(path)
}

export function collapseAll(): void {
  const ws = get().workspace
  set({ expanded: ws ? { [ws]: true } : {} })
}

export async function refreshTree(): Promise<void> {
  const { tree } = get()
  set({ fileIndex: null })
  await Promise.all(Object.keys(tree).map((dir) => loadDir(dir)))
}

/** Déplie l'arborescence jusqu'au fichier et le sélectionne. */
export async function revealInExplorer(path: string): Promise<void> {
  const ws = get().workspace
  if (!ws || !isInside(ws, path)) return
  const chain: string[] = []
  let dir = dirname(path)
  while (isInside(ws, dir) && dir !== ws) {
    chain.unshift(dir)
    dir = dirname(dir)
  }
  for (const d of chain) await toggleDir(d, true)
  set({ selectedPath: path })
}

export async function getFileIndex(): Promise<string[]> {
  const { fileIndex, workspace } = get()
  if (fileIndex) return fileIndex
  if (!workspace) return []
  const files = await window.api.fs.listFiles(workspace)
  set({ fileIndex: files })
  return files
}

let fsTimer: ReturnType<typeof setTimeout> | null = null
const changedDirs = new Set<string>()
const changedFiles = new Set<string>()

/** Réagit aux modifications faites hors de l'éditeur (git, terminal, autres outils). */
export function handleFsChanges(events: FsChangeEvent[]): void {
  for (const ev of events) {
    changedDirs.add(dirname(ev.path))
    changedFiles.add(ev.path)
  }
  if (fsTimer) return
  fsTimer = setTimeout(async () => {
    fsTimer = null
    const dirs = [...changedDirs]
    const files = [...changedFiles]
    changedDirs.clear()
    changedFiles.clear()

    const { tree, tabs } = get()
    set({ fileIndex: null })
    await Promise.all(dirs.filter((d) => tree[d]).map((d) => loadDir(d)))

    for (const file of files) {
      const tab = tabs.find((t) => t.id === file && t.kind === 'file')
      if (!tab || models.isDirty(file)) continue
      try {
        models.reloadContent(file, await window.api.fs.readFile(file))
      } catch {
        // Fichier supprimé : on garde l'onglet ouvert avec son contenu.
      }
    }
  }, 100)
}

// ---------------------------------------------------------------------------
// Onglets et fichiers
// ---------------------------------------------------------------------------

export interface OpenOptions {
  preview?: boolean
  focus?: boolean
  line?: number
  column?: number
  length?: number
}

export async function openFile(path: string, opts: OpenOptions = {}): Promise<void> {
  const preview = opts.preview ?? false
  let tabs = get().tabs
  const existing = tabs.find((t) => t.id === path)

  if (!existing) {
    if (!models.getEntry(path)) {
      try {
        const content = await window.api.fs.readFile(path)
        if (content.slice(0, 8000).includes('\u0000')) {
          notify(`« ${basename(path)} » est un fichier binaire et ne peut pas être affiché.`, 'error')
          return
        }
        models.createModel(path, content)
      } catch (err) {
        reportError(`Impossible d'ouvrir « ${basename(path)} »`, err)
        return
      }
    }
    tabs = get().tabs
    const tab: Tab = { id: path, kind: 'file', title: basename(path), dirty: false, preview }
    const previewIdx = preview ? tabs.findIndex((t) => t.preview && !t.dirty) : -1
    if (previewIdx >= 0) {
      const replaced = tabs[previewIdx]
      tabs = tabs.map((t, i) => (i === previewIdx ? tab : t))
      if (replaced.kind === 'file') models.disposeModel(replaced.id)
    } else {
      const activeIdx = tabs.findIndex((t) => t.id === get().activeId)
      tabs = [...tabs]
      tabs.splice(activeIdx >= 0 ? activeIdx + 1 : tabs.length, 0, tab)
    }
  } else if (!preview && existing.preview) {
    tabs = tabs.map((t) => (t.id === path ? { ...t, preview: false } : t))
  }

  set({
    tabs,
    activeId: opts.focus === false && get().activeId ? get().activeId : path,
    selectedPath: path,
    reveal: opts.line
      ? { path, line: opts.line, column: opts.column ?? 1, length: opts.length, nonce: Date.now() }
      : get().reveal
  })
}

export async function pickAndOpenFile(): Promise<void> {
  const path = await window.api.dialog.openFile()
  if (path) await openFile(path)
}

export function newUntitled(): void {
  const id = `untitled:Sans titre-${untitledCounter++}`
  models.createModel(id, '', 'plaintext')
  const tab: Tab = { id, kind: 'untitled', title: id.slice('untitled:'.length), dirty: false, preview: false }
  set((s) => ({ tabs: [...s.tabs, tab], activeId: id }))
}

export function openSettings(section?: string): void {
  if (section) set({ settingsSection: section })
  const { tabs } = get()
  if (!tabs.some((t) => t.id === SETTINGS_TAB)) {
    set({ tabs: [...tabs, { id: SETTINGS_TAB, kind: 'settings', title: 'Paramètres', dirty: false, preview: false }] })
  }
  set({ activeId: SETTINGS_TAB })
}

export function setActive(id: string): void {
  set({ activeId: id })
}

export function pinTab(id: string): void {
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.preview ? { ...t, preview: false } : t)) }))
}

export function setDirty(id: string, dirty: boolean): void {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty, preview: dirty ? false : t.preview } : t))
  }))
}

export function cycleTab(delta: number): void {
  const { tabs, activeId } = get()
  if (tabs.length === 0) return
  const idx = tabs.findIndex((t) => t.id === activeId)
  set({ activeId: tabs[(idx + delta + tabs.length) % tabs.length].id })
}

export function moveTab(id: string, toIndex: number): void {
  set((s) => {
    const tabs = [...s.tabs]
    const from = tabs.findIndex((t) => t.id === id)
    if (from < 0) return {}
    const [tab] = tabs.splice(from, 1)
    tabs.splice(Math.min(toIndex, tabs.length), 0, tab)
    return { tabs }
  })
}

/** Ferme un onglet ; demande confirmation si le fichier n'est pas enregistré. Renvoie false si annulé. */
export async function closeTab(id: string, force = false): Promise<boolean> {
  const tab = get().tabs.find((t) => t.id === id)
  if (!tab) return true

  if (!force && tab.dirty) {
    set({ activeId: id })
    const choice = await ask(
      `Voulez-vous enregistrer les modifications apportées à « ${tab.title} » ?`,
      'Vos modifications seront perdues si vous ne les enregistrez pas.',
      [
        { label: 'Enregistrer', value: 'save', primary: true },
        { label: 'Ne pas enregistrer', value: 'discard', danger: true },
        { label: 'Annuler', value: 'cancel' }
      ]
    )
    if (choice === 'save') {
      if (!(await saveTab(id))) return false
    } else if (choice !== 'discard') return false
  }

  const { tabs, activeId } = get()
  const idx = tabs.findIndex((t) => t.id === id)
  const remaining = tabs.filter((t) => t.id !== id)
  let nextActive = activeId
  if (activeId === id) nextActive = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null
  set({ tabs: remaining, activeId: nextActive })
  if (tab.kind !== 'settings') models.disposeModel(id)
  return true
}

export async function closeOtherTabs(keepId: string): Promise<void> {
  for (const t of get().tabs.filter((t) => t.id !== keepId)) {
    if (!(await closeTab(t.id))) return
  }
}

/** Propose d'enregistrer les fichiers modifiés. Renvoie false si l'utilisateur annule. */
export async function confirmUnsaved(): Promise<boolean> {
  const dirty = get().tabs.filter((t) => t.dirty)
  if (dirty.length === 0) return true
  const choice = await ask(
    dirty.length === 1
      ? `Voulez-vous enregistrer les modifications apportées à « ${dirty[0].title} » ?`
      : `Voulez-vous enregistrer les modifications apportées aux ${dirty.length} fichiers suivants ?`,
    dirty.length > 1 ? dirty.map((t) => t.title).join(', ') : 'Vos modifications seront perdues si vous ne les enregistrez pas.',
    [
      { label: dirty.length > 1 ? 'Tout enregistrer' : 'Enregistrer', value: 'save', primary: true },
      { label: 'Ne pas enregistrer', value: 'discard', danger: true },
      { label: 'Annuler', value: 'cancel' }
    ]
  )
  if (choice === 'save') return saveAll()
  return choice === 'discard'
}

export async function closeAllTabs(): Promise<boolean> {
  if (!(await confirmUnsaved())) return false
  for (const t of get().tabs) await closeTab(t.id, true)
  return true
}

export async function saveTab(id: string | null = get().activeId): Promise<boolean> {
  if (!id) return false
  const tab = get().tabs.find((t) => t.id === id)
  const entry = models.getEntry(id)
  if (!tab || !entry) return false

  if (tab.kind === 'untitled') return saveTabAs(id)

  try {
    await window.api.fs.writeFile(id, entry.model.getValue())
    models.markSaved(id)
    setDirty(id, false)
    return true
  } catch (err) {
    reportError(`Échec de l'enregistrement de « ${tab.title} »`, err)
    return false
  }
}

export async function saveTabAs(id: string | null = get().activeId): Promise<boolean> {
  if (!id) return false
  const tab = get().tabs.find((t) => t.id === id)
  const entry = models.getEntry(id)
  if (!tab || !entry) return false

  const ws = get().workspace
  const defaultPath = tab.kind === 'untitled' ? (ws ? join(ws, 'sans-titre.txt') : undefined) : id
  const target = await window.api.dialog.saveFile(defaultPath)
  if (!target) return false
  try {
    await window.api.fs.writeFile(target, entry.model.getValue())
  } catch (err) {
    reportError("Échec de l'enregistrement", err)
    return false
  }

  if (target !== id) {
    // Si le fichier cible est déjà ouvert dans un autre onglet, celui-ci est remplacé.
    const others = get().tabs.filter((t) => t.id !== target)
    if (others.length !== get().tabs.length) models.disposeModel(target)
    models.moveModel(id, target)
    set({
      tabs: others.map((t) =>
        t.id === id ? { ...t, id: target, kind: 'file', title: basename(target), preview: false } : t
      ),
      activeId: target
    })
  }
  models.markSaved(target)
  setDirty(target, false)
  return true
}

export async function saveAll(): Promise<boolean> {
  let ok = true
  for (const t of get().tabs.filter((t) => t.dirty)) ok = (await saveTab(t.id)) && ok
  return ok
}

// ---------------------------------------------------------------------------
// Opérations sur les fichiers (explorateur)
// ---------------------------------------------------------------------------

export function startInput(input: PendingInput): void {
  if (input.mode !== 'rename') void toggleDir(input.path, true)
  set({ pendingInput: input })
}

export function cancelInput(): void {
  set({ pendingInput: null })
}

/** Dossier cible pour une création : la sélection courante si c'est un dossier, sinon son parent. */
export function targetDirectory(): string | null {
  const { selectedPath, workspace, tree } = get()
  if (!workspace) return null
  if (!selectedPath || !isInside(workspace, selectedPath)) return workspace
  const isDir = Object.values(tree).some((entries) =>
    entries.some((e) => e.path === selectedPath && e.isDirectory)
  )
  return isDir ? selectedPath : dirname(selectedPath)
}

export async function createEntry(parent: string, name: string, isDirectory: boolean): Promise<void> {
  const path = join(parent, name.trim())
  try {
    if (isDirectory) await window.api.fs.createDir(path)
    else await window.api.fs.createFile(path)
    await loadDir(parent)
    // Les noms comme « a/b/c.ts » créent des dossiers intermédiaires.
    if (name.includes('/')) await refreshTree()
    set({ fileIndex: null, selectedPath: path })
    if (!isDirectory) await openFile(path)
  } catch (err) {
    reportError('Création impossible', err)
  }
}

function remapPath(path: string, from: string, to: string): string {
  return path === from ? to : isInside(from, path) ? to + path.slice(from.length) : path
}

export async function renameEntry(from: string, to: string): Promise<void> {
  if (from === to) return
  try {
    await window.api.fs.rename(from, to)
  } catch (err) {
    reportError('Renommage impossible', err)
    return
  }
  // Met à jour les onglets ouverts sur le fichier (ou les fichiers du dossier) renommé.
  const tabs = get().tabs.map((t) => {
    if (t.kind !== 'file' || !isInside(from, t.id)) return t
    const next = remapPath(t.id, from, to)
    models.moveModel(t.id, next)
    return { ...t, id: next, title: basename(next) }
  })
  const activeId = get().activeId ? remapPath(get().activeId!, from, to) : null
  set({ tabs, activeId, selectedPath: to, fileIndex: null })
  await Promise.all([loadDir(dirname(from)), loadDir(dirname(to))])
}

export async function deleteEntry(path: string): Promise<void> {
  const choice = await ask(
    `Voulez-vous vraiment supprimer « ${basename(path)} » ?`,
    "L'élément sera déplacé dans la corbeille.",
    [
      { label: 'Déplacer dans la corbeille', value: 'delete', danger: true, primary: true },
      { label: 'Annuler', value: 'cancel' }
    ]
  )
  if (choice !== 'delete') return
  try {
    await window.api.fs.trash(path)
  } catch (err) {
    reportError('Suppression impossible', err)
    return
  }
  for (const t of get().tabs.filter((t) => t.kind === 'file' && isInside(path, t.id))) {
    await closeTab(t.id, true)
  }
  set({ selectedPath: null, fileIndex: null })
  await loadDir(dirname(path))
}

// ---------------------------------------------------------------------------
// Disposition de l'interface
// ---------------------------------------------------------------------------

export function showSidebarView(view: SidebarView): void {
  const s = get()
  if (s.sidebarVisible && s.sidebarView === view && view === 'explorer') {
    set({ sidebarVisible: false })
    return
  }
  set({ sidebarVisible: true, sidebarView: view })
  if (view === 'search') set({ searchFocusNonce: Date.now() })
}

export function toggleSidebar(): void {
  set((s) => ({ sidebarVisible: !s.sidebarVisible }))
}

export function togglePanel(visible?: boolean): void {
  set((s) => ({ panelVisible: visible ?? !s.panelVisible }))
}

export function setSidebarWidth(width: number): void {
  set({ sidebarWidth: Math.max(170, Math.min(width, 700)) })
}

export function setPanelHeight(height: number): void {
  set({ panelHeight: Math.max(100, Math.min(height, window.innerHeight - 200)) })
}

export function openPalette(mode: PaletteMode, initial = ''): void {
  set({ palette: { open: true, mode, initial, nonce: Date.now() } })
}

export function closePalette(): void {
  set((s) => ({ palette: { ...s.palette, open: false } }))
}

export function setCursor(cursor: CursorInfo | null): void {
  set({ cursor })
}

export function revealLine(line: number, column = 1): void {
  const { activeId } = get()
  if (activeId) set({ reveal: { path: activeId, line, column, nonce: Date.now() } })
}
