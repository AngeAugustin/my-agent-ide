import { monaco, languageForPath } from './monaco'
import * as models from './editorModels'
import { basename, isInside, relative } from './paths'
import { fileBlock, type ResolvedContext } from './prompts'
import { activeTerminalText } from './terminalRegistry'
import { getFileIndex, useIde } from '../store/ide'
import { debugContextText } from '../store/debug'

export type ContextItem =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'selection'; path: string; startLine: number; endLine: number; text: string; language: string }
  | { kind: 'problems' }
  | { kind: 'git' }
  | { kind: 'terminal' }
  /** Texte sélectionné dans le terminal. */
  | { kind: 'snippet'; source: 'terminal'; text: string }
  | { kind: 'codebase' }
  | { kind: 'web' }
  | { kind: 'debug' }
  | { kind: 'docs'; id: string; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'image'; name: string; mediaType: string; data: string }

export function contextKey(item: ContextItem): string {
  switch (item.kind) {
    case 'file':
    case 'folder':
      return `${item.kind}:${item.path}`
    case 'selection':
      return `selection:${item.path}:${item.startLine}-${item.endLine}`
    case 'image':
      return `image:${item.name}:${item.data.length}`
    case 'docs':
      return `docs:${item.id}`
    case 'url':
      return `url:${item.url}`
    case 'snippet':
      return `snippet:${item.text.length}:${item.text.slice(0, 80)}`
    default:
      return item.kind
  }
}

function rel(path: string): string {
  const ws = useIde.getState().workspace
  return ws && isInside(ws, path) ? relative(ws, path).split('\\').join('/') : path
}

export function contextLabel(item: ContextItem): string {
  switch (item.kind) {
    case 'file':
      return basename(item.path)
    case 'folder':
      return `${basename(item.path)}/`
    case 'selection':
      return `${basename(item.path)} (${item.startLine}-${item.endLine})`
    case 'problems':
      return 'Problèmes'
    case 'git':
      return 'Modifications Git'
    case 'terminal':
      return 'Terminal'
    case 'snippet': {
      const lines = item.text.split('\n').length
      return `Terminal (${lines} ligne${lines > 1 ? 's' : ''})`
    }
    case 'codebase':
      return 'Codebase'
    case 'web':
      return 'Web'
    case 'debug':
      return 'Débogueur'
    case 'docs':
      return item.name
    case 'url':
      return item.url.replace(/^https?:\/\//, '').slice(0, 40)
    case 'image':
      return item.name
  }
}

export function contextIcon(item: ContextItem): string {
  return {
    file: 'file',
    folder: 'folder',
    selection: 'selection',
    problems: 'warning',
    git: 'git-compare',
    terminal: 'terminal',
    codebase: 'database',
    web: 'globe',
    snippet: 'terminal',
    debug: 'debug-alt',
    docs: 'book',
    url: 'link',
    image: 'file-media'
  }[item.kind]
}

async function readText(path: string): Promise<string> {
  // Le contenu de l'éditeur (éventuellement non enregistré) prime sur le disque.
  const entry = models.getEntry(path)
  return entry ? entry.model.getValue() : window.api.fs.readFile(path)
}

const FOLDER_BUDGET = 80_000
const FOLDER_MAX_FILE = 30_000

/** Transforme un élément de contexte en texte pour le prompt (instantané au moment de l'envoi). */
export async function resolveContext(item: ContextItem, question = ''): Promise<ResolvedContext | null> {
  switch (item.kind) {
    case 'file': {
      const content = await readText(item.path)
      return fileBlock(rel(item.path), content, languageForPath(item.path))
    }
    case 'folder': {
      const files = (await getFileIndex()).filter((f) => isInside(item.path, f))
      const listing = files.map(rel).join('\n')
      const parts: string[] = []
      let used = 0
      let skipped = 0
      for (const f of files) {
        try {
          const content = await readText(f)
          if (content.length > FOLDER_MAX_FILE || used + content.length > FOLDER_BUDGET || content.includes('\u0000')) {
            skipped++
            continue
          }
          used += content.length
          parts.push(fileBlock(rel(f), content, languageForPath(f)).text)
        } catch {
          skipped++
        }
      }
      const note = skipped > 0 ? `\n[${skipped} fichier(s) trop volumineux ou au-delà du budget : seul leur nom est inclus]` : ''
      return {
        label: `${rel(item.path)}/`,
        text: `<dossier chemin="${rel(item.path)}">\nFichiers :\n${listing}${note}\n\n${parts.join('\n\n')}\n</dossier>`,
        truncated: skipped > 0
      }
    }
    case 'selection':
      return {
        label: contextLabel(item),
        text: `<selection fichier="${rel(item.path)}" lignes="${item.startLine}-${item.endLine}">\n\`\`\`${item.language}\n${item.text}\n\`\`\`\n</selection>`
      }
    case 'problems': {
      const markers = monaco.editor.getModelMarkers({})
      const sev = (s: monaco.MarkerSeverity) =>
        s === monaco.MarkerSeverity.Error ? 'erreur' : s === monaco.MarkerSeverity.Warning ? 'avertissement' : 'info'
      const lines = markers.map((m) => `${rel(m.resource.fsPath || m.resource.path)}:${m.startLineNumber}:${m.startColumn} — ${sev(m.severity)} : ${m.message}`)
      return { label: 'Problèmes', text: `<problemes>\n${lines.join('\n') || 'Aucun problème détecté dans les fichiers ouverts.'}\n</problemes>` }
    }
    case 'git': {
      const ws = useIde.getState().workspace
      if (!ws) return { label: 'Git', text: '<git>Aucun dossier ouvert.</git>' }
      const diff = await window.api.git.diff(ws)
      return { label: 'Modifications Git', text: `<git_diff>\n${diff}\n</git_diff>`, truncated: diff.includes('[… diff tronqué') }
    }
    case 'terminal': {
      const text = activeTerminalText()
      return { label: 'Terminal', text: `<terminal>\n${text ?? 'Aucun terminal ouvert.'}\n</terminal>` }
    }
    case 'codebase': {
      // Les extraits les plus pertinents pour la question, trouvés par l'index du projet.
      const hits = await window.api.index.search(question, 12)
      const body = hits.length
        ? hits.map((h) => `<extrait fichier="${h.path}" lignes="${h.startLine}-${h.endLine}">\n${h.text}\n</extrait>`).join('\n\n')
        : 'Aucun extrait pertinent trouvé dans l’index.'
      return { label: 'Codebase', text: `<extraits_du_projet>\n${body}\n</extraits_du_projet>` }
    }
    case 'web': {
      // Recherche avec la question, puis lecture des premières pages trouvées.
      const results = await window.api.web.search(question, 6)
      const pages = await Promise.all(results.slice(0, 3).map((r) => window.api.web.fetch(r.url, 8000).catch(() => null)))
      const body = results
        .map((r, i) => {
          const page = pages[i]
          return `<resultat titre="${attr(r.title)}" url="${r.url}">\n${page ? page.text : r.snippet}\n</resultat>`
        })
        .join('\n\n')
      return { label: 'Web', text: `<recherche_web requete="${attr(question.slice(0, 200))}">\n${body || 'Aucun résultat.'}\n</recherche_web>\nCite les adresses (url) des sources que tu utilises.` }
    }
    case 'docs': {
      const hits = await window.api.docs.search([item.id], question, 8)
      const body = hits.length
        ? hits.map((h) => `<extrait page="${attr(h.title)}" url="${h.url}">\n${h.text}\n</extrait>`).join('\n\n')
        : 'Aucun extrait pertinent trouvé (la documentation est peut-être encore en cours d’indexation).'
      return { label: item.name, text: `<documentation nom="${attr(item.name)}">\n${body}\n</documentation>` }
    }
    case 'snippet':
      return { label: contextLabel(item), text: `<selection_terminal>\n\`\`\`\n${item.text}\n\`\`\`\n</selection_terminal>` }
    case 'debug':
      return { label: 'Débogueur', text: `<debogueur>\n${await debugContextText()}\n</debogueur>` }
    case 'url': {
      const page = await window.api.web.fetch(item.url, 40_000)
      return { label: contextLabel(item), text: `<page_web url="${page.url}" titre="${attr(page.title)}">\n${page.text}\n</page_web>`, truncated: page.truncated }
    }
    case 'image':
      return null
  }
}

function attr(text: string): string {
  return text.replace(/"/g, '\'').replace(/\s+/g, ' ')
}

/** Sélection courante de l'éditeur, sous forme d'élément de contexte. */
export function currentSelection(editor: monaco.editor.ICodeEditor | null, path: string | null): ContextItem | null {
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!model || !sel || sel.isEmpty() || !path || path.startsWith('ide://')) return null
  const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
  const range = new monaco.Range(sel.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine))
  return {
    kind: 'selection',
    path,
    startLine: sel.startLineNumber,
    endLine,
    text: model.getValueInRange(range),
    language: model.getLanguageId()
  }
}
