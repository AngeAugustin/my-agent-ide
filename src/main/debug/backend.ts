import type { BreakpointResult, DebugEvent, DebugFrame, DebugScope, DebugVariable, SourceBreakpoint } from '@shared/debug'

/** Moteur de débogage d'une session (Node.js via l'inspecteur V8, ou adaptateur DAP). */
export interface DebugBackend {
  start(): Promise<void>
  setBreakpoints(path: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointResult[]>
  resume(): Promise<void>
  stepOver(): Promise<void>
  stepInto(): Promise<void>
  stepOut(): Promise<void>
  pause(): Promise<void>
  stackTrace(): Promise<DebugFrame[]>
  scopes(frameId: number): Promise<DebugScope[]>
  variables(ref: number): Promise<DebugVariable[]>
  evaluate(expression: string, frameId?: number): Promise<{ value: string; ref: number }>
  stop(): Promise<void>
}

export type EmitDebugEvent = (event: DebugEvent) => void

/** Découpe un flux de sortie en lignes complètes (la dernière ligne partielle est gardée). */
export class LineBuffer {
  private rest = ''
  push(chunk: string): string[] {
    const text = this.rest + chunk
    const lines = text.split('\n')
    this.rest = lines.pop() ?? ''
    return lines.map((l) => `${l}\n`)
  }
  flush(): string {
    const r = this.rest
    this.rest = ''
    return r
  }
}
