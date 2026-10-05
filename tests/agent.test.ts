import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  DEFAULT_AGENT_SETTINGS,
  isCommandAllowed,
  resolveWorkspacePath,
  truncateOutput,
  validateToolInput
} from '../src/shared/agent'
import { agentStepMessages } from '../src/renderer/src/lib/agentHistory'
import { runCommand } from '../src/main/agentCommands'

describe('validateToolInput', () => {
  it('vérifie les champs requis et les types', () => {
    expect(validateToolInput('read_file', { path: 'a.ts' })).toBeNull()
    expect(validateToolInput('read_file', {})).toContain('manquant')
    expect(validateToolInput('read_file', { path: 3 })).toContain('Type invalide')
    expect(validateToolInput('read_file', { path: 'a', start_line: 1.5 })).toContain('integer')
    expect(validateToolInput('inconnu', {})).toContain('inconnu')
    expect(validateToolInput('edit_file', 'texte')).toContain('objet')
  })
})

describe('resolveWorkspacePath', () => {
  const root = '/home/moi/projet'
  it('accepte les chemins internes', () => {
    expect(resolveWorkspacePath(root, 'src/a.ts')).toEqual({ path: '/home/moi/projet/src/a.ts' })
    expect(resolveWorkspacePath(root, './src/../lib/b.ts')).toEqual({ path: '/home/moi/projet/lib/b.ts' })
    expect(resolveWorkspacePath(root, '.')).toEqual({ path: root })
    expect(resolveWorkspacePath(root, '/home/moi/projet/x.md')).toEqual({ path: '/home/moi/projet/x.md' })
  })

  it('refuse de sortir du projet ou de toucher .git', () => {
    expect(resolveWorkspacePath(root, '../secret.txt')).toHaveProperty('error')
    expect(resolveWorkspacePath(root, 'src/../../x')).toHaveProperty('error')
    expect(resolveWorkspacePath(root, '/etc/passwd')).toHaveProperty('error')
    expect(resolveWorkspacePath(root, '/home/moi/projet-voisin/a')).toHaveProperty('error')
    expect(resolveWorkspacePath(root, '.git/config')).toHaveProperty('error')
  })

  it('gère les chemins Windows', () => {
    expect(resolveWorkspacePath('C:\\proj', 'src\\a.ts')).toEqual({ path: 'C:\\proj\\src\\a.ts' })
  })
})

describe('isCommandAllowed', () => {
  const s = { ...DEFAULT_AGENT_SETTINGS, allowlist: ['git status', 'npm test', 'ls'] }
  it('autorise les commandes listées (mot entier)', () => {
    expect(isCommandAllowed('git status', s)).toBe(true)
    expect(isCommandAllowed('npm test -- --watch=false', s)).toBe(true)
    expect(isCommandAllowed('ls -la src', s)).toBe(true)
    expect(isCommandAllowed('lsof -i', s)).toBe(false)
    expect(isCommandAllowed('npm install', s)).toBe(false)
  })

  it('refuse les enchaînements et redirections', () => {
    expect(isCommandAllowed('ls; rm -rf /', s)).toBe(false)
    expect(isCommandAllowed('ls && curl x', s)).toBe(false)
    expect(isCommandAllowed('ls | sh', s)).toBe(false)
    expect(isCommandAllowed('ls > f', s)).toBe(false)
    expect(isCommandAllowed('ls $(whoami)', s)).toBe(false)
    expect(isCommandAllowed('ls `id`', s)).toBe(false)
  })

  it('respecte les politiques', () => {
    expect(isCommandAllowed('rm -rf build', { ...s, commandPolicy: 'always' })).toBe(true)
    expect(isCommandAllowed('git status', { ...s, allowlist: [] })).toBe(false)
  })
})

describe('applyEdit', () => {
  it('remplace une occurrence unique', () => {
    expect(applyEdit('a\nb\nc', 'b', 'B')).toEqual({ content: 'a\nB\nc', count: 1 })
  })

  it('signale les cas ambigus ou introuvables', () => {
    expect(applyEdit('x x', 'x', 'y')).toHaveProperty('error')
    expect(applyEdit('x x', 'x', 'y', true)).toEqual({ content: 'y y', count: 2 })
    expect(applyEdit('abc', 'z', 'y')).toHaveProperty('error')
    expect(applyEdit('abc', '', 'y')).toHaveProperty('error')
  })

  it('n’interprète pas les motifs spéciaux de remplacement', () => {
    expect(applyEdit('prix', 'prix', '$& et $1')).toEqual({ content: '$& et $1', count: 1 })
  })

  it('fonctionne sur un fichier en fins de ligne Windows', () => {
    expect(applyEdit('a\r\nb\r\nc', 'a\nb', 'A\nB')).toEqual({ content: 'A\r\nB\r\nc', count: 1 })
  })
})

describe('truncateOutput', () => {
  it('garde le début et la fin', () => {
    const out = truncateOutput('d'.repeat(100) + 'f'.repeat(100), 50)
    expect(out.startsWith('d'.repeat(20))).toBe(true)
    expect(out.endsWith('f'.repeat(30))).toBe(true)
    expect(out).toContain('caractères omis')
  })
})

describe('agentStepMessages', () => {
  it('fait suivre chaque appel d’outil de son résultat, même interrompu', () => {
    const msgs = agentStepMessages([
      {
        id: 's1',
        text: 'Je lis.',
        reasoning: '',
        tools: [
          { call: { id: 't1', name: 'read_file', input: { path: 'a' } }, status: 'done', output: '1| x' },
          { call: { id: 't2', name: 'run_command', input: { command: 'ls' } }, status: 'pending' }
        ],
        providerData: { providerId: 'anthropic', model: 'm', raw: [] }
      },
      { id: 's2', text: 'Fini.', reasoning: '', tools: [] }
    ])
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toMatchObject({ role: 'assistant', providerData: { providerId: 'anthropic' } })
    expect(msgs[1].content).toEqual([
      { type: 'tool_result', toolCallId: 't1', toolName: 'read_file', content: '1| x', isError: false },
      { type: 'tool_result', toolCallId: 't2', toolName: 'run_command', content: 'Exécution interrompue par l’utilisateur.', isError: true }
    ])
    expect(msgs[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Fini.' }] })
  })
})

describe('exécution des commandes', () => {
  it('capture la sortie et le code de retour', async () => {
    const chunks: string[] = []
    const { done } = runCommand('echo bonjour && echo erreur 1>&2 && exit 3', process.cwd(), 10_000, (c) => chunks.push(c))
    const res = await done
    expect(res.exitCode).toBe(3)
    expect(res.output).toContain('bonjour')
    expect(res.output).toContain('erreur')
    expect(chunks.join('')).toContain('bonjour')
  })

  it('arrête une commande trop longue', async () => {
    const started = Date.now()
    const res = await runCommand('sleep 30', process.cwd(), 300, () => {}).done
    expect(res.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
