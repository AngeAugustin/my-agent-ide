import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch, normalize } from '../src/renderer/src/lib/fuzzy'

describe('fuzzyMatch', () => {
  it('trouve les caractères dans l’ordre', () => {
    expect(fuzzyMatch('idx', 'src/index.ts')).not.toBeNull()
    expect(fuzzyMatch('xdi', 'src/index.ts')).toBeNull()
  })

  it('ignore les accents et la casse', () => {
    expect(normalize('Thème Élégant')).toBe('theme elegant')
    expect(fuzzyMatch('theme', 'Basculer entre thème clair et sombre')).not.toBeNull()
  })

  it('classe une sous-chaîne exacte avant une correspondance éparpillée', () => {
    const labels = ['Fichier : Fermer le dossier', 'Préférences : Basculer entre thème clair et sombre']
    const [first] = fuzzyFilter('theme', labels, (l) => l)
    expect(first.item).toBe(labels[1])
  })

  it('favorise le nom de fichier plutôt que le chemin', () => {
    const files = ['app/components/button.tsx', 'app/store/app.ts']
    const [first] = fuzzyFilter('app', files, (f) => f)
    expect(first.item).toBe('app/store/app.ts')
  })

  it('renvoie les positions correspondantes', () => {
    expect(fuzzyMatch('rd', 'README.md')?.positions).toEqual([0, 3])
  })
})
