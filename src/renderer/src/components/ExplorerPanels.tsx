import { useEffect, useState, type ReactNode } from 'react'
import { describeStatus } from '@shared/git'
import { extractOutline, type OutlineItem } from '@shared/outline'
import { useGit, openGitDiff } from '../store/git'
import { useCodeIndex } from '../store/codeIndex'
import { reportError, useIde } from '../store/ide'
import { addContext, focusChat, sendMessage, setMode, newConversation } from '../store/chat'
import { getActiveEditor, onActiveEditorChange } from '../lib/activeEditor'
import { formatTokens } from '../lib/ai'
import { basename } from '../lib/paths'
import { Icon } from './Icon'

function Collapsible({ id, title, extra, children }: { id: string; title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => localStorage.getItem(`panel:${id}`) !== 'closed')
  return (
    <section className="explorer-panel">
      <div
        className="explorer-panel-header"
        onClick={() => {
          setOpen(!open)
          try {
            localStorage.setItem(`panel:${id}`, open ? 'closed' : 'open')
          } catch {
            // stockage indisponible
          }
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="explorer-panel-title">{title}</span>
        {extra && <span className="explorer-panel-extra">{extra}</span>}
      </div>
      {open && children}
    </section>
  )
}

/** Fichiers modifiés depuis le dernier commit, avec lignes ajoutées et supprimées. */
function ActiveDiffset() {
  const ws = useIde((s) => s.workspace)
  const status = useGit((s) => s.status)
  const [stats, setStats] = useState<Record<string, { added: number; removed: number }>>({})
  useEffect(() => {
    if (!ws || !status?.isRepo) return
    const t = setTimeout(() => void window.api.git.numstat(ws).then(setStats, () => setStats({})), 200)
    return () => clearTimeout(t)
  }, [ws, status])
  if (!ws || !status?.isRepo || status.files.length === 0) return null
  const added = Object.values(stats).reduce((n, s) => n + s.added, 0)
  const removed = Object.values(stats).reduce((n, s) => n + s.removed, 0)
  const label = (code: string) => {
    const k = describeStatus(code).kind
    return k === 'added' || k === 'untracked' ? 'NOUV.' : k === 'deleted' ? 'SUPPR.' : k === 'renamed' ? 'RENOM.' : k === 'conflict' ? 'CONFL.' : 'MOD.'
  }
  return (
    <div className="diffset-card">
      <div className="diffset-header">
        <span>DIFF ACTIF</span>
        <span>
          <span className="diff-plus">+{added}</span> <span className="diff-minus">-{removed}</span>
        </span>
      </div>
      {status.files.slice(0, 6).map((f) => {
        const code = f.worktree !== ' ' && f.worktree !== '?' ? f.worktree : f.index === '?' ? '?' : f.index
        const k = describeStatus(code).kind
        return (
          <button key={f.path} className="diffset-row" title={f.path} onClick={() => void openGitDiff(f, f.index !== ' ' && f.index !== '?' && f.worktree === ' ')}>
            <span className="diffset-name">{basename(f.path)}</span>
            <span className={`diffset-kind k-${k}`}>{label(code)}</span>
          </button>
        )
      })}
      {status.files.length > 6 && <div className="muted small diffset-more">et {status.files.length - 6} autre(s)…</div>}
      <button
        className="diffset-review"
        title="Demande à l’IA une revue du diff Git"
        onClick={() => {
          newConversation()
          setMode('ask')
          addContext({ kind: 'git' })
          focusChat()
          sendMessage('Fais une revue de mes modifications : bugs probables, cas limites, sécurité et lisibilité. Classe les remarques par importance et propose les corrections.').catch((err: unknown) =>
            reportError('Revue impossible', err)
          )
        }}
      >
        <Icon name="sparkle" /> Revue par l’IA
      </button>
    </div>
  )
}

const KIND_ICON: Record<OutlineItem['kind'], string> = {
  class: 'symbol-class',
  interface: 'symbol-interface',
  type: 'symbol-structure',
  struct: 'symbol-structure',
  function: 'symbol-method',
  method: 'symbol-method'
}

/** Structure du fichier actif (classes, fonctions, méthodes). */
function Outline() {
  const activeId = useIde((s) => s.activeId)
  const [items, setItems] = useState<OutlineItem[]>([])
  const [editorVersion, setEditorVersion] = useState(0)
  useEffect(() => onActiveEditorChange(() => setEditorVersion((v) => v + 1)), [])
  useEffect(() => {
    const editor = getActiveEditor()
    if (!editor || !activeId || activeId.startsWith('ide://')) return setItems([])
    let timer: ReturnType<typeof setTimeout> | null = null
    let contentSub: { dispose(): void } | null = null
    // Suit le modèle affiché par l'éditeur (il change juste après l'onglet actif).
    const attach = () => {
      contentSub?.dispose()
      const model = editor.getModel()
      if (!model) return setItems([])
      const compute = () => setItems(extractOutline(model.getValue()))
      compute()
      contentSub = model.onDidChangeContent(() => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(compute, 400)
      })
    }
    attach()
    const modelSub = editor.onDidChangeModel(attach)
    return () => {
      modelSub.dispose()
      contentSub?.dispose()
      if (timer) clearTimeout(timer)
    }
  }, [activeId, editorVersion])
  if (!activeId || activeId.startsWith('ide://')) return null
  return (
    <Collapsible id="outline" title={`STRUCTURE : ${basename(activeId)}`}>
      <div className="outline-list">
        {items.length === 0 && <div className="muted small outline-empty">Aucun symbole détecté.</div>}
        {items.map((it) => (
          <button
            key={`${it.line}:${it.name}`}
            className={`outline-item k-${it.kind}`}
            style={{ paddingLeft: 12 + it.depth * 12 }}
            onClick={() => {
              const editor = getActiveEditor()
              if (!editor) return
              editor.revealLineInCenterIfOutsideViewport(it.line)
              editor.setPosition({ lineNumber: it.line, column: 1 })
              editor.focus()
            }}
          >
            <Icon name={KIND_ICON[it.kind]} />
            <span>{it.name}</span>
          </button>
        ))}
      </div>
    </Collapsible>
  )
}

function IndexFooter() {
  const status = useCodeIndex((s) => s.status)
  if (!status) return null
  const busy = status.state === 'scanning' || status.state === 'embedding'
  return (
    <div className="explorer-footer">
      <span className={`explorer-footer-state${busy ? ' busy' : status.state === 'error' ? ' error' : ''}`}>
        <Icon name={busy ? 'loading' : status.state === 'error' ? 'error' : 'pass'} className={busy ? 'codicon-modifier-spin' : undefined} />
        {busy ? 'Indexation…' : status.state === 'error' ? 'Index en erreur' : 'Index synchronisé'}
      </span>
      <span className="muted">{formatTokens(status.chunks)} extraits</span>
    </div>
  )
}

/** Panneaux sous l'arborescence : diff actif, structure du fichier, état de l'index. */
export function ExplorerPanels() {
  return (
    <>
      <div className="explorer-panels">
        <ActiveDiffset />
        <Outline />
      </div>
      <IndexFooter />
    </>
  )
}
