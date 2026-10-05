import { create } from 'zustand'
import { canCompleteBefore, cleanCompletion, lookupCompletionCache, type CompletionCacheEntry } from '@shared/completion'
import { monaco } from './monaco'
import { isInside, relative } from './paths'
import { hasInlineSession } from './inlineEdit'
import { updateSettings, useIde } from '../store/ide'

/** État affiché dans la barre d'état. */
export const useAutocomplete = create<{ pending: boolean; lastError: string | null; lastVia: 'fim' | 'chat' | null }>()(() => ({
  pending: false,
  lastError: null,
  lastVia: null
}))

const PREFIX_CHARS = 6000
const SUFFIX_CHARS = 2000
const CACHE_SIZE = 50

/** Cache des dernières suggestions : revenir en arrière ou taper la suggestion ne relance pas de requête. */
const cache: CompletionCacheEntry[] = []

function remember(entry: CompletionCacheEntry): void {
  cache.unshift(entry)
  if (cache.length > CACHE_SIZE) cache.pop()
}

let counter = 0

function sleep(ms: number, token: monaco.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(!token.isCancellationRequested), ms)
    token.onCancellationRequested(() => {
      clearTimeout(t)
      resolve(false)
    })
  })
}

async function provide(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  context: monaco.languages.InlineCompletionContext,
  token: monaco.CancellationToken
): Promise<monaco.languages.InlineCompletions> {
  const empty = { items: [] }
  const { settings, workspace } = useIde.getState()
  const ref = settings.ai.models.autocomplete
  // Uniquement dans les vrais fichiers (pas dans les vues de différences ni pendant une édition en ligne).
  if (!settings.autocomplete || !ref || model.uri.scheme !== 'file' || hasInlineSession()) return empty

  const line = model.getLineContent(position.lineNumber)
  const restOfLine = line.slice(position.column - 1)
  if (!canCompleteBefore(restOfLine)) return empty

  const full = model.getValue()
  const offset = model.getOffsetAt(position)
  const prefix = full.slice(Math.max(0, offset - PREFIX_CHARS), offset)
  const suffix = full.slice(offset, offset + SUFFIX_CHARS)
  // Rien à compléter sur une ligne vide en début de fichier.
  if (!prefix.trim()) return empty

  const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
  const cached = lookupCompletionCache(prefix, suffix, cache)
  if (cached) return { items: [{ insertText: cached, range }] }

  // Délai avant requête : chaque frappe annule la précédente.
  const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
  if (!explicit && !(await sleep(settings.autocompleteDelay, token))) return empty

  const path = model.uri.fsPath
  const requestId = `cmp-${Date.now()}-${++counter}`
  const cancel = token.onCancellationRequested(() => window.api.ai.abort(requestId))
  useAutocomplete.setState({ pending: true })
  try {
    const res = await window.api.ai.complete(requestId, {
      providerId: ref.providerId,
      model: ref.modelId,
      path: workspace && isInside(workspace, path) ? relative(workspace, path).split('\\').join('/') : path,
      language: model.getLanguageId(),
      prefix,
      suffix
    })
    if (token.isCancellationRequested) return empty
    if (!res.ok) {
      if (res.code !== 'aborted') useAutocomplete.setState({ lastError: res.message })
      return empty
    }
    const text = cleanCompletion(res.result.text, prefix, suffix)
    useAutocomplete.setState({ lastError: null, lastVia: res.result.via })
    if (!text) return empty
    remember({ prefix, suffix, text })
    return { items: [{ insertText: text, range }] }
  } finally {
    cancel.dispose()
    useAutocomplete.setState({ pending: false })
  }
}

let registered = false

/** Enregistre le fournisseur de suggestions grisées pour tous les langages. */
export function registerAutocomplete(): void {
  if (registered) return
  registered = true
  monaco.languages.registerInlineCompletionsProvider('*', {
    displayName: 'Autocomplétion IA',
    provideInlineCompletions: provide,
    disposeInlineCompletions: () => {}
  })
}

export function toggleAutocomplete(): void {
  void updateSettings({ autocomplete: !useIde.getState().settings.autocomplete })
}
