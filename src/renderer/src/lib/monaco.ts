import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { basename, extname } from './paths'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

monaco.editor.defineTheme('ide-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1f22',
    'editorGutter.background': '#1e1f22',
    'editor.lineHighlightBackground': '#26282e',
    'editorLineNumber.foreground': '#5a5d63',
    'editorLineNumber.activeForeground': '#c9ccd1',
    'minimap.background': '#1e1f22'
  }
})

monaco.editor.defineTheme('ide-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f3f4f6'
  }
})

// Diagnostics JS/TS : on reste permissif tant qu'il n'y a pas de vrai serveur de langage.
const tsDefaults = monaco.typescript.typescriptDefaults
const jsDefaults = monaco.typescript.javascriptDefaults
const compilerOptions = {
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  strict: true
}
tsDefaults.setCompilerOptions(compilerOptions)
jsDefaults.setCompilerOptions(compilerOptions)
// Sans résolution de modules, les imports produiraient de fausses erreurs : on garde la syntaxe uniquement.
tsDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
jsDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

const SPECIAL_FILES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.babelrc': 'json',
  'tsconfig.json': 'json',
  '.cursorrules': 'markdown'
}

const EXTRA_EXTENSIONS: Record<string, string> = {
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.jsonc': 'json',
  '.mdx': 'markdown',
  '.toml': 'ini',
  '.env': 'ini',
  '.vue': 'html',
  '.svelte': 'html'
}

/** Détermine l'identifiant de langage Monaco à partir du nom de fichier. */
export function languageForPath(path: string): string {
  const name = basename(path).toLowerCase()
  if (SPECIAL_FILES[name]) return SPECIAL_FILES[name]
  if (name.startsWith('.env')) return 'ini'
  const ext = extname(name)
  if (EXTRA_EXTENSIONS[ext]) return EXTRA_EXTENSIONS[ext]
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(ext)) return lang.id
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
  }
  return 'plaintext'
}

export function languageLabel(id: string): string {
  if (id === 'plaintext') return 'Texte brut'
  const lang = monaco.languages.getLanguages().find((l) => l.id === id)
  return lang?.aliases?.[0] ?? id
}

export { monaco }
