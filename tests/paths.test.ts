import { describe, expect, it } from 'vitest'
import { basename, dirname, extname, isInside, join, relative, validateFileName } from '../src/renderer/src/lib/paths'

describe('chemins', () => {
  it('fonctionne avec des chemins POSIX', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts')
    expect(dirname('/a/b/c.ts')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
    expect(join('/a/b', 'c.ts')).toBe('/a/b/c.ts')
    expect(relative('/a', '/a/b/c.ts')).toBe('b/c.ts')
    expect(extname('/a/B.TSX')).toBe('.tsx')
    expect(extname('/a/.gitignore')).toBe('')
  })

  it('fonctionne avec des chemins Windows', () => {
    expect(basename('C:\\proj\\src\\a.ts')).toBe('a.ts')
    expect(dirname('C:\\proj\\a.ts')).toBe('C:\\proj')
    expect(dirname('C:\\a.ts')).toBe('C:\\')
    expect(join('C:\\proj', 'a.ts')).toBe('C:\\proj\\a.ts')
  })

  it('isInside ne confond pas les préfixes', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b')).toBe(true)
  })

  it('valide les noms de fichiers', () => {
    expect(validateFileName('index.ts')).toBeNull()
    expect(validateFileName('src/utils.ts')).toBeNull()
    expect(validateFileName('  ')).not.toBeNull()
    expect(validateFileName('a:b')).not.toBeNull()
    expect(validateFileName('..')).not.toBeNull()
  })
})
