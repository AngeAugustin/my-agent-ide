import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildSearchRegExp, globsToRegExps, searchInContent, searchText } from '../src/main/search'
import { walkFiles } from '../src/main/walk'

const base = { caseSensitive: false, wholeWord: false, regex: false }

describe('buildSearchRegExp', () => {
  it('échappe le texte littéral', () => {
    expect(buildSearchRegExp('a.b', base).test('axb')).toBe(false)
    expect(buildSearchRegExp('a.b', base).test('a.b')).toBe(true)
  })

  it('respecte les options', () => {
    expect(buildSearchRegExp('Foo', { ...base, caseSensitive: true }).test('foo')).toBe(false)
    expect(buildSearchRegExp('foo', { ...base, wholeWord: true }).test('foobar')).toBe(false)
    expect(buildSearchRegExp('fo+', { ...base, regex: true }).test('fooo')).toBe(true)
  })
})

describe('globsToRegExps', () => {
  it('gère les motifs courants', () => {
    const [ts] = globsToRegExps('*.ts')
    expect(ts.test('src/a/index.ts')).toBe(true)
    expect(ts.test('src/a/index.tsx')).toBe(false)
    const [src] = globsToRegExps('src/**')
    expect(src.test('src/a/b.ts')).toBe(true)
    expect(src.test('lib/src/b.ts')).toBe(false)
  })
})

describe('searchInContent', () => {
  it('renvoie lignes et colonnes (base 1)', () => {
    const matches = searchInContent('un\ndeux trois deux', /deux/gi)
    expect(matches.map((m) => [m.line, m.column])).toEqual([
      [2, 1],
      [2, 12]
    ])
  })
})

describe('recherche dans un dossier', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ide-search-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'const bonjour = 1\n')
    writeFileSync(join(root, 'src', 'b.md'), 'Bonjour le monde\n')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'bonjour\n')
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 98, 111, 110, 106, 111, 117, 114]))
  })

  it('ignore les dossiers exclus', async () => {
    const files = await walkFiles(root, { excluded: ['node_modules'] })
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
    expect(files).toHaveLength(3)
  })

  it('trouve les occurrences et ignore les fichiers binaires', async () => {
    const res = await searchText(root, 'bonjour', base, ['node_modules'])
    expect(res.totalMatches).toBe(2)
    expect(res.files.map((f) => f.path.split(/[\\/]/).pop()).sort()).toEqual(['a.ts', 'b.md'])
  })

  it('applique les filtres d’inclusion', async () => {
    const res = await searchText(root, 'bonjour', { ...base, include: '*.md' }, ['node_modules'])
    expect(res.files).toHaveLength(1)
  })
})
