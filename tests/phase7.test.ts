import { describe, expect, it } from 'vitest'
import { globToRegExp, parseRule, rulesPrompt, selectRules } from '../src/shared/rules'
import { parseStatus } from '../src/main/git'
import { describeStatus, isConflict, isStaged, isUnstaged } from '../src/shared/git'
import { mcpToolName, parseMcpConfig } from '../src/shared/mcp'
import { acceptsUri, encodeLspMessage, LspFramer, uriExtension } from '../src/shared/lsp'

describe('règles de projet', () => {
  it('lit l’en-tête des fichiers .mdc', () => {
    const r = parseRule('.cursor/rules/ts.mdc', '---\ndescription: Conventions TS\nglobs: src/**/*.ts, *.tsx\nalwaysApply: false\n---\nTypes explicites.\n')
    expect(r).toEqual({ source: '.cursor/rules/ts.mdc', content: 'Types explicites.', description: 'Conventions TS', globs: ['src/**/*.ts', '*.tsx'], alwaysApply: false })
    expect(parseRule('x.mdc', '---\nglobs: ["a/*.py", "b.py"]\n---\nX').globs).toEqual(['a/*.py', 'b.py'])
  })

  it('applique toujours les fichiers racine et ceux sans en-tête', () => {
    expect(parseRule('AGENTS.md', '# Règles\nSois clair.').alwaysApply).toBe(true)
    expect(parseRule('.cursor/rules/style.md', 'Pas de var.').alwaysApply).toBe(true)
  })

  it('convertit les motifs glob', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('lib/c.ts')).toBe(false)
    expect(globToRegExp('*.{js,jsx}').test('deep/x.jsx')).toBe(true)
    expect(globToRegExp('*.ts').test('a.tsx')).toBe(false)
  })

  it('sélectionne selon les fichiers concernés', () => {
    const rules = [
      parseRule('AGENTS.md', 'Toujours.'),
      parseRule('.cursor/rules/ts.mdc', '---\nglobs: *.ts\n---\nTS'),
      parseRule('.cursor/rules/tests.mdc', '---\ndescription: Tests\n---\nVitest')
    ]
    const sel = selectRules(rules, ['src/a.py'])
    expect(sel.applied.map((r) => r.source)).toEqual(['AGENTS.md'])
    expect(sel.available.map((r) => r.source)).toEqual(['.cursor/rules/tests.mdc'])
    expect(selectRules(rules, ['src/a.ts']).applied).toHaveLength(2)
    const prompt = rulesPrompt('Sois bref.', sel.applied, sel.available)
    expect(prompt).toContain('Sois bref.')
    expect(prompt).toContain('Règles du projet (AGENTS.md)')
    expect(prompt).toContain('.cursor/rules/tests.mdc : Tests')
    expect(rulesPrompt('', [], [])).toBe('')
  })
})

describe('git status', () => {
  it('analyse branche, avance/retard et fichiers', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'M  src/b.ts', '?? nouveau.txt', 'R  neuf.ts', 'ancien.ts', 'UU conflit.ts', ''].join('\0')
    const s = parseStatus(out)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(s.files).toEqual([
      { path: 'src/a.ts', index: ' ', worktree: 'M' },
      { path: 'src/b.ts', index: 'M', worktree: ' ' },
      { path: 'nouveau.txt', index: '?', worktree: '?' },
      { path: 'neuf.ts', index: 'R', worktree: ' ', origPath: 'ancien.ts' },
      { path: 'conflit.ts', index: 'U', worktree: 'U' }
    ])
    expect(s.files.map(isStaged)).toEqual([false, true, false, true, true])
    expect(s.files.map(isUnstaged)).toEqual([true, false, true, false, true])
    expect(isConflict(s.files[4])).toBe(true)
    expect(describeStatus('?').label).toBe('non suivi')
  })

  it('gère un dépôt sans commit et une tête détachée', () => {
    expect(parseStatus('## No commits yet on main\0').branch).toBe('main')
    expect(parseStatus('## HEAD (no branch)\0').branch).toBeNull()
    expect(parseStatus('## feature/x\0')).toMatchObject({ branch: 'feature/x', upstream: null, ahead: 0 })
  })
})

describe('configuration MCP', () => {
  it('lit le format mcpServers', () => {
    const servers = parseMcpConfig('{"mcpServers":{"fs":{"command":"npx","args":["-y","x"]},"web":{"url":"https://a.b/mcp"}}}')
    expect(Object.keys(servers)).toEqual(['fs', 'web'])
  })

  it('signale clairement les erreurs', () => {
    expect(() => parseMcpConfig('{')).toThrow(/JSON invalide/)
    expect(() => parseMcpConfig('{"mcpServers":{"x":{}}}')).toThrow(/command.*url/)
    expect(() => parseMcpConfig('{"mcpServers":{"x":{"url":"ftp://a"}}}')).toThrow(/http/)
    expect(() => parseMcpConfig('{"mcpServers":{"x":{"command":"a","args":"b"}}}')).toThrow(/args/)
    expect(parseMcpConfig('  ')).toEqual({})
  })

  it('construit des noms d’outils valides', () => {
    expect(mcpToolName('mon serveur', 'créer.issue')).toBe('mcp__mon_serveur__cr_er_issue')
    expect(mcpToolName('a'.repeat(50), 'b'.repeat(50))).toHaveLength(64)
  })
})

describe('protocole LSP', () => {
  it('découpe les messages même fragmentés', () => {
    const framer = new LspFramer()
    const bytes = new Uint8Array([...encodeLspMessage({ id: 1, result: 'é' }), ...encodeLspMessage({ method: 'x' })])
    const out: unknown[] = []
    for (let i = 0; i < bytes.length; i += 7) out.push(...framer.push(bytes.slice(i, i + 7)))
    expect(out).toEqual([{ id: 1, result: 'é' }, { method: 'x' }])
  })

  it('ne transmet que les fichiers du langage', () => {
    expect(uriExtension('file:///a/b.TS')).toBe('ts')
    expect(acceptsUri(['ts'], 'file:///a/b.ts')).toBe(true)
    expect(acceptsUri(['ts'], 'file:///a/b.py')).toBe(false)
    expect(acceptsUri(['ts'], 'inmemory://model/1')).toBe(false)
    expect(acceptsUri(['ts'], undefined)).toBe(true)
  })
})
