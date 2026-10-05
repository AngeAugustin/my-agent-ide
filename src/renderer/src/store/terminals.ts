import { create } from 'zustand'
import { togglePanel, useIde } from './ide'

export interface TerminalInfo {
  key: number
  title: string
  /** Identifiant du processus côté principal (null tant qu'il n'est pas créé). */
  ptyId: number | null
  exited: boolean
  /** Dossier de démarrage ; par défaut, l'espace de travail. */
  cwd: string | null
}

interface TerminalsState {
  terminals: TerminalInfo[]
  activeKey: number | null
}

export const useTerminals = create<TerminalsState>()(() => ({ terminals: [], activeKey: null }))

let counter = 1

export function newTerminal(cwd: string | null = null): void {
  const key = counter++
  useTerminals.setState((s) => ({
    terminals: [...s.terminals, { key, title: `Terminal ${key}`, ptyId: null, exited: false, cwd }],
    activeKey: key
  }))
  togglePanel(true)
}

export function setPtyId(key: number, ptyId: number): void {
  useTerminals.setState((s) => ({
    terminals: s.terminals.map((t) => (t.key === key ? { ...t, ptyId } : t))
  }))
}

export function markExited(ptyId: number): void {
  useTerminals.setState((s) => ({
    terminals: s.terminals.map((t) => (t.ptyId === ptyId ? { ...t, exited: true, title: `${t.title} (terminé)` } : t))
  }))
}

export function setActiveTerminal(key: number): void {
  useTerminals.setState({ activeKey: key })
}

export function killTerminal(key: number | null = useTerminals.getState().activeKey): void {
  if (key === null) return
  const { terminals } = useTerminals.getState()
  const term = terminals.find((t) => t.key === key)
  if (term?.ptyId != null && !term.exited) window.api.terminal.kill(term.ptyId)
  const remaining = terminals.filter((t) => t.key !== key)
  useTerminals.setState({ terminals: remaining, activeKey: remaining[remaining.length - 1]?.key ?? null })
  if (remaining.length === 0) togglePanel(false)
}

/** Affiche le panneau terminal, en créant un terminal s'il n'y en a aucun. */
export function toggleTerminalPanel(): void {
  const visible = useIde.getState().panelVisible
  if (!visible && useTerminals.getState().terminals.length === 0) newTerminal()
  else togglePanel()
}
