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
  rules: [
    { token: 'keyword', foreground: '4cd7f6' },
    { token: 'type', foreground: '4edea3' },
    { token: 'type.identifier', foreground: '4edea3' },
    { token: 'string', foreground: 'f2b8a2' },
    { token: 'number', foreground: 'c0c1ff' },
    { token: 'comment', foreground: '5f6d72', fontStyle: 'italic' }
  ],
  colors: {
    'editor.background': '#0f131b',
    'editor.foreground': '#dfe2ee',
    'editorGutter.background': '#0f131b',
    'editor.lineHighlightBackground': '#161b24',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#4cd7f63d',
    'editor.inactiveSelectionBackground': '#4cd7f61f',
    'editorCursor.foreground': '#4cd7f6',
    'editorLineNumber.foreground': '#3d494c',
    'editorLineNumber.activeForeground': '#bcc9cd',
    'editorIndentGuide.background1': '#1c2028',
    'editorIndentGuide.activeBackground1': '#31353e',
    'editorWidget.background': '#181c24',
    'editorWidget.border': '#31353e',
    'editorSuggestWidget.background': '#181c24',
    'editorSuggestWidget.selectedBackground': '#262a33',
    'editorHoverWidget.background': '#181c24',
    'editorHoverWidget.border': '#31353e',
    'minimap.background': '#0f131b',
    'scrollbarSlider.background': '#262a3399',
    'scrollbarSlider.hoverBackground': '#31353ecc',
    'editorBracketMatch.background': '#4cd7f622',
    'editorBracketMatch.border': '#4cd7f666'
  }
})

monaco.editor.defineTheme('ide-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f1f6f8',
    'editorCursor.foreground': '#0891b2',
    'editor.selectionBackground': '#0891b22e'
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
