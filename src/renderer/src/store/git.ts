import { create } from 'zustand'
import { describeStatus, isConflict, isStaged, isUnstaged, type GitFileStatus, type GitStatus } from '@shared/git'
import { streamChat } from '../lib/ai'
import { join } from '../lib/paths'
import { openReadonlyDiff } from './review'
import { ask, notify, reportError, useIde } from './ide'

interface GitState {
  status: GitStatus | null
  /** Opération en cours (pour désactiver les boutons). */
  busy: string | null
  message: string
  generating: boolean
  amend: boolean
}

export const useGit = create<GitState>()(() => ({ status: null, busy: null, message: '', generating: false, amend: false }))

const set = useGit.setState
const root = () => useIde.getState().workspace

let refreshTimer: ReturnType<typeof setTimeout> | null = null

export async function refreshGit(): Promise<void> {
  const ws = root()
  if (!ws) return set({ status: null })
  try {
    const status = await window.api.git.status(ws)
    if (root() === ws) set({ status })
  } catch (err) {
    set({ status: { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] } })
    if (!String(err).includes('pas un dépôt')) console.warn(err)
  }
}

function scheduleRefresh(delay = 400): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void refreshGit(), delay)
}

let initialized = false

export function initGit(): void {
  if (initialized) return
  initialized = true
  void refreshGit()
  useIde.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) {
      set({ status: null, message: '' })
      void refreshGit()
    }
  })
  // Les modifications du disque (éditeur, agent, terminal, git en ligne de commande) mettent l'état à jour.
  window.api.fs.onChange(() => scheduleRefresh())
  window.addEventListener('focus', () => scheduleRefresh(100))
}

async function run(label: string, fn: (ws: string) => Promise<unknown>, success?: string): Promise<boolean> {
  const ws = root()
  if (!ws) return false
  set({ busy: label })
  try {
    await fn(ws)
    if (success) notify(success, 'success')
    return true
  } catch (err) {
    reportError(label, err)
    return false
  } finally {
    set({ busy: null })
    await refreshGit()
  }
}

export const stageFiles = (paths: string[]) => run('Indexation impossible', (ws) => window.api.git.stage(ws, paths))
export const unstageFiles = (paths: string[]) => run('Désindexation impossible', (ws) => window.api.git.unstage(ws, paths))
export const initRepo = () => run('Initialisation impossible', (ws) => window.api.git.init(ws), 'Dépôt Git initialisé.')
export const pull = () => run('Échec du pull', (ws) => window.api.git.pull(ws), 'Pull terminé.')
export const push = () => run('Échec du push', (ws) => window.api.git.push(ws), 'Push terminé.')
export const fetchAll = () => run('Échec du fetch', (ws) => window.api.git.fetch(ws), 'Fetch terminé.')
export const checkout = (branch: string, create = false) =>
  run(create ? 'Création de branche impossible' : 'Changement de branche impossible', (ws) => window.api.git.checkout(ws, branch, create), `Branche « ${branch} » ${create ? 'créée' : 'active'}.`)

/** Annule les modifications locales (fichiers suivis restaurés, fichiers non suivis mis à la corbeille). */
export async function discardFiles(files: GitFileStatus[]): Promise<void> {
  if (files.length === 0) return
  const choice = await ask(
    files.length === 1 ? `Annuler les modifications de « ${files[0].path} » ?` : `Annuler les modifications de ${files.length} fichiers ?`,
    'Les modifications non commitées seront perdues (les fichiers non suivis vont à la corbeille).',
    [
      { label: 'Annuler les modifications', value: 'ok', danger: true, primary: true },
      { label: 'Garder', value: 'cancel' }
    ]
  )
  if (choice !== 'ok') return
  await run('Annulation impossible', async (ws) => {
    const tracked = files.filter((f) => f.index !== '?').map((f) => f.path)
    const untracked = files.filter((f) => f.index === '?')
    if (tracked.length) await window.api.git.discard(ws, tracked)
    for (const f of untracked) await window.api.fs.trash(join(ws, f.path))
  })
}

export async function commit(): Promise<void> {
  const { status, message, amend } = useGit.getState()
  if (!status) return
  if (!message.trim()) return notify('Saisissez un message de commit (ou générez-le avec ✨).', 'info')
  const staged = status.files.filter(isStaged)
  if (staged.length === 0 && !amend) {
    const changed = status.files.filter((f) => isUnstaged(f) && !isConflict(f))
    if (changed.length === 0) return notify('Aucune modification à commiter.', 'info')
    const choice = await ask('Aucune modification n’est indexée.', 'Voulez-vous indexer toutes les modifications et les commiter ?', [
      { label: 'Tout indexer et commiter', value: 'all', primary: true },
      { label: 'Annuler', value: 'cancel' }
    ])
    if (choice !== 'all') return
    if (!(await stageFiles(changed.map((f) => f.path)))) return
  }
  const ok = await run('Échec du commit', (ws) => window.api.git.commit(ws, message.trim(), amend), amend ? 'Dernier commit modifié.' : 'Commit créé.')
  if (ok) set({ message: '', amend: false })
}

/** Rédige un message de commit à partir des modifications indexées (ou de toutes, à défaut). */
export async function generateCommitMessage(): Promise<void> {
  const ws = root()
  const { models } = useIde.getState().settings.ai
  const model = models.edit ?? models.chat
  if (!ws) return
  if (!model) return notify('Configurez un modèle (Paramètres › Modèles et clés API) pour générer le message.', 'info')
  set({ generating: true })
  try {
    let diff = await window.api.git.stagedDiff(ws)
    let scope = 'indexées'
    if (!diff.trim()) {
      diff = await window.api.git.diff(ws)
      scope = 'en cours'
    }
    if (!diff.trim() || diff.startsWith('Aucune modification')) {
      notify('Aucune modification à décrire.', 'info')
      return
    }
    const history = await window.api.git.log(ws, 10)
    let text = ''
    const handle = streamChat(
      {
        providerId: model.providerId,
        model: model.modelId,
        maxTokens: 4000,
        system: [
          'Tu rédiges des messages de commit Git.',
          'Réponds UNIQUEMENT avec le message (pas de bloc Markdown, pas de guillemets, pas d’explication).',
          'Première ligne : résumé à l’impératif de 72 caractères au plus. Ensuite, si utile, une ligne vide puis quelques puces courtes.',
          'Respecte la langue et la convention (ex. Conventional Commits) des messages précédents du dépôt ; à défaut, écris en français.'
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: `${history.length ? `Messages de commit précédents :\n${history.map((h) => `- ${h}`).join('\n')}\n\n` : ''}Modifications ${scope} :\n${diff}`
          }
        ]
      },
      (ev) => {
        if (ev.type !== 'text') return
        text += ev.text
        set({ message: text.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '') })
      }
    )
    const res = await handle.result
    if (!res.ok) reportError('Génération impossible', res.message)
    else set({ message: res.text.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim() })
  } catch (err) {
    reportError('Génération impossible', err)
  } finally {
    set({ generating: false })
  }
}

/** Ouvre le diff d'un fichier : indexé (HEAD → index) ou non indexé (index → disque). */
export async function openGitDiff(file: GitFileStatus, staged: boolean): Promise<void> {
  const ws = root()
  if (!ws) return
  const abs = join(ws, file.path)
  try {
    const original = (await window.api.git.show(ws, staged ? 'HEAD' : '', staged ? (file.origPath ?? file.path) : file.path)) ?? ''
    let modified = ''
    if (staged) modified = (await window.api.git.show(ws, '', file.path)) ?? ''
    else if (file.worktree !== 'D' && (await window.api.fs.exists(abs))) modified = await window.api.fs.readFile(abs)
    const s = describeStatus(staged ? file.index : file.index === '?' ? '?' : file.worktree)
    await openReadonlyDiff(`ide://diff/git/${staged ? 'index' : 'wt'}/${abs}`, abs, original, modified, `${file.path.split('/').pop()} (${staged ? 'indexé' : s.label})`)
  } catch (err) {
    reportError('Diff impossible', err)
  }
}

/** État Git d'un chemin absolu (pour colorer l'explorateur). */
export function gitDecorations(status: GitStatus | null, ws: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!status?.isRepo || !ws) return map
  for (const f of status.files) {
    const code = isConflict(f) ? 'U' : f.index === '?' ? '?' : f.worktree !== ' ' ? f.worktree : f.index
    const kind = describeStatus(code).kind
    const abs = join(ws, f.path)
    map.set(abs, kind)
    // Les dossiers parents signalent qu'ils contiennent des modifications.
    let dir = abs
    while ((dir = dir.slice(0, Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')))) && dir.length > ws.length) {
      if (!map.has(dir)) map.set(dir, 'folder')
    }
  }
  return map
}
