import { memo, useEffect, useState, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { monaco } from '../lib/monaco'
import { parseFenceInfo } from '../lib/codeBlocks'
import { getActiveEditor } from '../lib/activeEditor'
import { isInside, join } from '../lib/paths'
import { pasteInTerminal } from '../lib/terminalRegistry'
import { applyCodeToFile } from '../store/review'
import { notify, openFile, useIde } from '../store/ide'
import { Icon } from './Icon'

// Le Markdown est converti en éléments React (jamais en HTML brut) : le texte du modèle ne peut pas injecter de code.

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  ps1: 'powershell',
  dockerfile: 'dockerfile'
}

function monacoLanguage(lang: string): string {
  const l = lang.toLowerCase()
  if (!l) return 'plaintext'
  const alias = LANG_ALIASES[l]
  if (alias) return alias
  const found = monaco.languages
    .getLanguages()
    .find((x) => x.id === l || x.aliases?.some((a) => a.toLowerCase() === l) || x.extensions?.includes(`.${l}`))
  return found?.id ?? 'plaintext'
}

const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'cmd', 'bat'])

function resolvePath(path: string): string | null {
  const ws = useIde.getState().workspace
  if (/^([a-zA-Z]:[\\/]|\/)/.test(path)) return ws && isInside(ws, path) ? path : null
  if (!ws) return null
  const clean = path.replace(/^\.\//, '')
  if (clean.split(/[\\/]/).includes('..')) return null
  return join(ws, clean)
}

export function CodeBlock({ code, info, streaming }: { code: string; info: string; streaming?: boolean }) {
  const { lang, path } = parseFenceInfo(info)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const theme = useIde((s) => s.settings.theme)
  const activeId = useIde((s) => s.activeId)
  const languageId = monacoLanguage(lang)

  useEffect(() => {
    let cancelled = false
    // Coloration par Monaco : le HTML produit est échappé par Monaco lui-même.
    const timer = setTimeout(() => {
      monaco.editor.colorize(code, languageId, { tabSize: 2 }).then((h) => !cancelled && setHtml(h), () => !cancelled && setHtml(null))
    }, streaming ? 150 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, languageId, streaming, theme])

  const target = path ? resolvePath(path) : activeId && !activeId.startsWith('ide://') && !activeId.startsWith('untitled:') ? activeId : null
  const isShell = SHELL_LANGS.has(lang.toLowerCase())

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const insert = () => {
    const editor = getActiveEditor()
    const sel = editor?.getSelection()
    if (!editor || !sel || !editor.getModel()) return notify('Ouvrez un fichier pour y insérer le code.', 'info')
    editor.executeEdits('chat', [{ range: sel, text: code, forceMoveMarkers: true }])
    editor.focus()
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{path ?? lang ?? ''}</span>
        <div className="code-block-actions">
          {path && target && (
            <button className="icon-button" title={`Ouvrir ${path}`} onClick={() => openFile(target)}>
              <Icon name="go-to-file" />
            </button>
          )}
          <button className="icon-button" title={copied ? 'Copié !' : 'Copier'} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          {!isShell && (
            <button className="icon-button" title="Insérer au curseur" onClick={insert}>
              <Icon name="insert" />
            </button>
          )}
          {isShell && (
            <button className="code-action" title="Coller dans le terminal (sans exécuter)" disabled={streaming} onClick={() => pasteInTerminal(code)}>
              <Icon name="terminal" /> Terminal
            </button>
          )}
          {!isShell && target && (
            <button className="code-action primary" disabled={streaming} title={`Appliquer à ${target}`} onClick={() => applyCodeToFile(target, code)}>
              <Icon name="check-all" /> Appliquer
            </button>
          )}
        </div>
      </div>
      {html !== null ? (
        <pre className="code-block-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-block-body">{code}</pre>
      )}
    </div>
  )
}

function safeHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null
}

function renderInline(tokens: Token[] | undefined, keyPrefix = ''): ReactNode[] {
  if (!tokens) return []
  return tokens.map((t, i) => {
    const key = `${keyPrefix}${i}`
    switch (t.type) {
      case 'strong':
        return <strong key={key}>{renderInline((t as Tokens.Strong).tokens, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline((t as Tokens.Em).tokens, key)}</em>
      case 'del':
        return <del key={key}>{renderInline((t as Tokens.Del).tokens, key)}</del>
      case 'codespan':
        return <code key={key} className="inline-code">{decode((t as Tokens.Codespan).text)}</code>
      case 'br':
        return <br key={key} />
      case 'link': {
        const link = t as Tokens.Link
        const href = safeHref(link.href)
        return href ? (
          <a key={key} href={href} title={href} onClick={(e) => { e.preventDefault(); void window.api.shell.openExternal(href) }}>
            {renderInline(link.tokens, key)}
          </a>
        ) : (
          <span key={key}>{renderInline(link.tokens, key)}</span>
        )
      }
      case 'image':
        return <span key={key}>[image : {(t as Tokens.Image).text}]</span>
      case 'text': {
        const tt = t as Tokens.Text
        return tt.tokens ? <span key={key}>{renderInline(tt.tokens, key)}</span> : <span key={key}>{decode(tt.text)}</span>
      }
      case 'escape':
        return <span key={key}>{decode((t as Tokens.Escape).text)}</span>
      default:
        return <span key={key}>{decode(t.raw)}</span>
    }
  })
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
}

function renderBlocks(tokens: Token[], streaming: boolean, keyPrefix = ''): ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}${i}`
    switch (t.type) {
      case 'space':
        return null
      case 'paragraph':
        return <p key={key}>{renderInline((t as Tokens.Paragraph).tokens, key)}</p>
      case 'heading': {
        const h = t as Tokens.Heading
        const level = Math.min(Math.max(h.depth + 2, 3), 6)
        const Tag = `h${level}` as 'h3'
        return <Tag key={key}>{renderInline(h.tokens, key)}</Tag>
      }
      case 'code': {
        const c = t as Tokens.Code
        // Un bloc non refermé est encore en cours d'écriture.
        const open = streaming && i === tokens.length - 1 && !/\n\s*(```|~~~)\s*$/.test(c.raw)
        return <CodeBlock key={key} code={c.text} info={c.lang ?? ''} streaming={open} />
      }
      case 'blockquote':
        return <blockquote key={key}>{renderBlocks((t as Tokens.Blockquote).tokens, false, key)}</blockquote>
      case 'list': {
        const l = t as Tokens.List
        const items = l.items.map((item, j) => (
          <li key={j}>
            {item.task && <input type="checkbox" checked={item.checked} readOnly />}
            {renderBlocks(item.tokens, false, `${key}-${j}`)}
          </li>
        ))
        return l.ordered ? (
          <ol key={key} start={typeof l.start === 'number' ? l.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        )
      }
      case 'table': {
        const tb = t as Tokens.Table
        return (
          <div key={key} className="md-table-wrap">
            <table>
              <thead>
                <tr>{tb.header.map((h, j) => <th key={j}>{renderInline(h.tokens, `${key}h${j}`)}</th>)}</tr>
              </thead>
              <tbody>
                {tb.rows.map((row, r) => (
                  <tr key={r}>{row.map((cell, j) => <td key={j}>{renderInline(cell.tokens, `${key}r${r}c${j}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      case 'hr':
        return <hr key={key} />
      case 'text': {
        const tt = t as Tokens.Text
        return <p key={key}>{tt.tokens ? renderInline(tt.tokens, key) : decode(tt.text)}</p>
      }
      case 'html':
        // Le HTML éventuel est affiché comme du texte.
        return <p key={key}>{t.raw}</p>
      default:
        return <p key={key}>{t.raw}</p>
    }
  })
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const tokens = marked.lexer(text, { gfm: true, breaks: false })
  return <div className="markdown">{renderBlocks(tokens, streaming)}</div>
})
