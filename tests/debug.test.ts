
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DebugEvent } from '../src/shared/debug'
import { formatRemoteObject, nodeUrlRegex, nodeUrlToPath, parseLaunchJson, resolveLaunchEntry, stripJsonc, substituteVariables } from '../src/shared/debug'
import { NodeDebugBackend } from '../src/main/debug/node'
import { DapDebugBackend, findPython } from '../src/main/debug/dap'

describe('configurations de lancement', () => {
  const launch = `{
    // commentaire
    "version": "0.2.0",
    "configurations": [
      { "type": "node", "request": "launch", "name": "Serveur", "program": "\${workspaceFolder}/src/app.js", "args": ["--port", "\${env:PORT}"], },
      { "type": "debugpy", "name": "Fichier", "program": "\${file}", "cwd": "\${fileDirname}" },
      { "type": "node", "request": "attach", "name": "Attacher" },
      { "type": "chrome", "name": "Web", "program": "x" }, /* bloc */
    ]
  }`

  it('lit le JSON avec commentaires et ne garde que les lancements pris en charge', () => {
    expect(stripJsonc('{"a": "// pas un commentaire", /* x */ "b": [1,],}')).toBe('{"a": "// pas un commentaire",  "b": [1]}')
    expect(parseLaunchJson(launch).map((c) => c.name)).toEqual(['Serveur', 'Fichier'])
  })

  it('remplace les variables', () => {
    const ctx = { workspaceFolder: '/p', file: '/p/src/x.py', env: { PORT: '8080' } }
    expect(substituteVariables('${fileDirname}|${fileBasenameNoExtension}|${relativeFile}|${env:PORT}|${inconnue}', ctx)).toBe('/p/src|x|src/x.py|8080|${inconnue}')
    const [server, file] = parseLaunchJson(launch)
    expect(resolveLaunchEntry(server, ctx)).toMatchObject({ type: 'node', program: '/p/src/app.js', args: ['--port', '8080'], cwd: '/p' })
    expect(resolveLaunchEntry(file, ctx)).toMatchObject({ type: 'python', program: '/p/src/x.py', cwd: '/p/src' })
    expect(resolveLaunchEntry({ name: 'x', type: 'node' }, ctx)).toHaveProperty('error')
  })

  it('associe chemins et URL des scripts Node', () => {
    const re = new RegExp(nodeUrlRegex('/home/u/a.b.js'))
    expect(re.test('file:///home/u/a.b.js')).toBe(true)
    expect(re.test('/home/u/a.b.js')).toBe(true)
    expect(re.test('/home/u/aXb.js')).toBe(false)
    const win = new RegExp(nodeUrlRegex('C:\\p\\a.js'))
    expect(win.test('file:///C:/p/a.js')).toBe(true)
    expect(win.test('c:\\p\\a.js')).toBe(true)
    expect(nodeUrlToPath('file:///C:/p/a%20b.js', true)).toBe('C:\\p\\a b.js')
    expect(nodeUrlToPath('node:internal/x')).toBeUndefined()
  })

  it('affiche les valeurs de V8', () => {
    expect(formatRemoteObject({ type: 'string', value: 'a"b' })).toBe('"a\\"b"')
    expect(formatRemoteObject({ type: 'object', subtype: 'null' })).toBe('null')
    expect(formatRemoteObject({ type: 'object', subtype: 'array', description: 'Array(3)' })).toBe('Array(3)')
    expect(formatRemoteObject({ type: 'function', description: 'function somme(a, b) { return a + b }' })).toBe('ƒ somme(a, b)')
  })
})

function collector() {
  const events: DebugEvent[] = []
  const waiters: Array<{ pred: (e: DebugEvent) => boolean; resolve: (e: DebugEvent) => void }> = []
  return {
    events,
    emit: (e: DebugEvent) => {
      events.push(e)
      for (const w of [...waiters]) if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(e)
      }
    },
    wait: (pred: (e: DebugEvent) => boolean, ms = 15000) =>
      new Promise<DebugEvent>((resolve, reject) => {
        const found = events.find(pred)
        if (found) return resolve(found)
        waiters.push({ pred, resolve })
        setTimeout(() => reject(new Error(`délai dépassé ; événements : ${JSON.stringify(events)}`)), ms)
      })
  }
}

describe('débogage Node.js', () => {
  it('s’arrête sur un point d’arrêt, inspecte, avance pas à pas et termine', async () => {
    // Dossier atteint par un lien symbolique (comme /var → /private/var sous macOS).
    const realDir = mkdtempSync(join(tmpdir(), 'dbg-'))
    let dir = realDir
    try {
      symlinkSync(realDir, `${realDir}-lien`, 'junction')
      dir = `${realDir}-lien`
    } catch {
      // liens symboliques indisponibles : dossier réel
    }
    const file = join(dir, 'prog.js')
    writeFileSync(file, ['function somme(a, b) {', '  const total = a + b', '  return total', '}', 'const liste = [1, 2, 3]', 'console.log("début")', 'const r = somme(liste[0], 41)', 'console.log("résultat", r)', ''].join('\n'))
    const c = collector()
    const be = new NodeDebugBackend({ name: 't', type: 'node', program: file, args: [], cwd: dir, env: {}, stopOnEntry: false }, c.emit)
    await be.setBreakpoints(file, [{ line: 3 }])
    await be.start()
    const stop = await c.wait((e) => e.type === 'stopped')
    expect(stop).toMatchObject({ reason: 'breakpoint' })
    const frames = await be.stackTrace()
    expect(frames[0]).toMatchObject({ name: 'somme', path: file, line: 3 })
    expect(frames[1].line).toBe(7)
    const scopes = await be.scopes(frames[0].id)
    expect(scopes[0].name).toBe('Locales')
    const vars = await be.variables(scopes[0].ref)
    expect(vars.find((v) => v.name === 'total')?.value).toBe('42')
    expect((await be.evaluate('a * 10', frames[0].id)).value).toBe('10')
    await expect(be.evaluate('inconnu', frames[0].id)).rejects.toThrow(/inconnu/)
    // Objet développable
    const caller = await be.scopes(frames[1].id)
    const moduleVars = await be.variables(caller[0].ref)
    const liste = moduleVars.find((v) => v.name === 'liste')!
    expect(liste.value).toBe('Array(3)')
    expect((await be.variables(liste.ref)).map((v) => v.value)).toEqual(['1', '2', '3', '3'])
    // Pas à pas : sortie de la fonction
    c.events.length = 0
    await be.stepOut()
    const s2 = await c.wait((e) => e.type === 'stopped')
    expect(s2.type).toBe('stopped')
    expect([7, 8]).toContain((await be.stackTrace())[0].line)
    await be.resume()
    const end = await c.wait((e) => e.type === 'terminated')
    expect(end).toMatchObject({ exitCode: 0 })
    const out = c.events.filter((e) => e.type === 'output').map((e) => (e as { text: string }).text).join('')
    expect(out).toContain('résultat 42')
    expect(out).not.toContain('Debugger')
  }, 30000)
})

const python = findPython(undefined, tmpdir())
describe.skipIf('error' in python)('débogage Python (debugpy)', () => {
  it('s’arrête sur un point d’arrêt et lit les variables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbgpy-'))
    const file = join(dir, 'prog.py')
    writeFileSync(file, ['def somme(a, b):', '    total = a + b', '    return total', '', 'valeurs = {"x": 1}', 'r = somme(1, 41)', 'print("résultat", r)', ''].join('\n'))
    const c = collector()
    const py = python as { python: string }
    const be = new DapDebugBackend(
      { name: 't', type: 'python', program: file, args: [], cwd: dir, env: {}, stopOnEntry: false },
      { command: py.python, args: ['-m', 'debugpy.adapter'], adapterID: 'debugpy', launchArgs: { type: 'python', request: 'launch', program: file, cwd: dir, console: 'internalConsole', justMyCode: true, redirectOutput: true } },
      c.emit
    )
    await be.setBreakpoints(file, [{ line: 3 }])
    await be.start()
    await c.wait((e) => e.type === 'stopped', 30000)
    const frames = await be.stackTrace()
    expect(frames[0]).toMatchObject({ name: 'somme', line: 3 })
    const scopes = await be.scopes(frames[0].id)
    const vars = await be.variables(scopes[0].ref)
    expect(vars.find((v) => v.name === 'total')?.value).toBe('42')
    expect((await be.evaluate('a + 1', frames[0].id)).value).toBe('2')
    await be.resume()
    await c.wait((e) => e.type === 'terminated', 30000)
    const out = c.events.filter((e) => e.type === 'output').map((e) => (e as { text: string }).text).join('')
    expect(out).toContain('résultat 42')
  }, 60000)
})


