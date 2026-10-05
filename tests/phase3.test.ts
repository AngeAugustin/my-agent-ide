import { describe, expect, it } from 'vitest'
import { diffLines, diffStats } from '../src/renderer/src/lib/diff'
import { extractCode, hasElisionMarkers, parseFenceInfo } from '../src/renderer/src/lib/codeBlocks'
import { buildUserMessage, fileBlock, inlineEditPrompt } from '../src/renderer/src/lib/prompts'

function apply(a: string[], b: string[]): string[] {
  // Reconstruit b à partir de a et des opérations pour vérifier leur cohérence.
  const out: string[] = []
  for (const op of diffLines(a, b)) {
    if (op.type === 'equal') out.push(...a.slice(op.oldStart, op.oldStart + op.count))
    else if (op.type === 'insert') out.push(...b.slice(op.newStart, op.newStart + op.count))
  }
  return out
}

describe('diffLines', () => {
  it('détecte ajouts et suppressions', () => {
    const a = ['a', 'b', 'c', 'd']
    const b = ['a', 'B', 'c', 'd', 'e']
    expect(diffStats(diffLines(a, b))).toEqual({ added: 2, removed: 1 })
    expect(apply(a, b)).toEqual(b)
  })

  it('gère les cas limites', () => {
    expect(diffLines([], [])).toEqual([])
    expect(diffStats(diffLines([], ['x', 'y']))).toEqual({ added: 2, removed: 0 })
    expect(diffStats(diffLines(['x'], []))).toEqual({ added: 0, removed: 1 })
    const same = ['1', '2', '3']
    expect(diffLines(same, same)).toEqual([{ type: 'equal', oldStart: 0, newStart: 0, count: 3 }])
  })

  it('reste cohérent sur des modifications dispersées', () => {
    const a = Array.from({ length: 200 }, (_, i) => `ligne ${i}`)
    const b = [...a]
    b.splice(10, 2, 'nouvelle')
    b.splice(150, 0, 'insérée 1', 'insérée 2')
    b.pop()
    expect(apply(a, b)).toEqual(b)
    expect(diffStats(diffLines(a, b))).toEqual({ added: 3, removed: 3 })
  })

  it('positionne les suppressions dans le nouveau texte', () => {
    const ops = diffLines(['a', 'x', 'b'], ['a', 'b'])
    expect(ops.find((o) => o.type === 'delete')).toMatchObject({ oldStart: 1, count: 1, newIndex: 1 })
  })
})

describe('blocs de code', () => {
  it('lit le langage et le chemin', () => {
    expect(parseFenceInfo('ts:src/app.ts')).toEqual({ lang: 'ts', path: 'src/app.ts' })
    expect(parseFenceInfo('python')).toEqual({ lang: 'python', path: undefined })
    expect(parseFenceInfo('ts path=src/a.ts')).toEqual({ lang: 'ts', path: 'src/a.ts' })
    expect(parseFenceInfo('')).toEqual({ lang: '' })
  })

  it('extrait le code d’une réponse complète ou en cours', () => {
    expect(extractCode('```ts\nconst a = 1\n```')).toEqual({ code: 'const a = 1', complete: true })
    expect(extractCode('Voici :\n```js\nlet x\nlet y\n``')).toEqual({ code: 'let x\nlet y', complete: false })
    expect(extractCode('```')).toEqual({ code: '', complete: false })
    expect(extractCode('return 42\n')).toEqual({ code: 'return 42', complete: true })
  })

  it('repère les extraits partiels', () => {
    expect(hasElisionMarkers('function a() {}\n// ... code existant ...\n')).toBe(true)
    expect(hasElisionMarkers('// ... existing code ...')).toBe(true)
    expect(hasElisionMarkers('const a = [1, 2, 3]')).toBe(false)
  })
})

describe('prompts', () => {
  it('balise le contexte avant la question', () => {
    const ctx = fileBlock('src/a.ts', 'export const a = 1', 'typescript')
    const msg = buildUserMessage('Explique', [ctx])
    expect(msg).toBe('<fichier chemin="src/a.ts">\n```typescript\nexport const a = 1\n```\n</fichier>\n\nExplique')
  })

  it('signale un fichier tronqué', () => {
    const big = 'x'.repeat(130_000)
    const ctx = fileBlock('big.txt', big)
    expect(ctx.truncated).toBe(true)
    expect(ctx.text).toContain('fichier tronqué')
  })

  it('distingue sélection et insertion pour l’édition en ligne', () => {
    const withSel = inlineEditPrompt({ path: 'a.ts', language: 'typescript', before: 'avant\n', selection: 'code', after: '\napres', instruction: 'renomme' })
    expect(withSel).toContain('<selection>\ncode\n</selection>')
    expect(withSel).toContain('Instruction : renomme')
    const insert = inlineEditPrompt({ path: 'a.ts', language: 'typescript', before: 'avant\n', selection: '', after: '\napres', instruction: 'ajoute' })
    expect(insert).toContain('avant\n<curseur/>\napres')
  })
})
