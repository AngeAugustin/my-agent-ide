export interface FuzzyMatch {
  score: number
  /** Indices des caractères correspondants dans la cible. */
  positions: number[]
}

/** Minuscules sans accents, en conservant la longueur (pour garder les positions). */
export function normalize(text: string): string {
  // Découpage par unité UTF-16 (et non par point de code) pour que les indices restent alignés.
  return text
    .split('')
    .map((ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()[0] ?? ch)
    .join('')
}

const SEPARATORS = new Set(['/', '\\', '_', '-', '.', ' ', ':'])

/**
 * Recherche floue façon « ouverture rapide » : tous les caractères de la requête
 * doivent apparaître dans l'ordre. Les suites contiguës, les débuts de mots et
 * les correspondances dans le nom de fichier sont favorisés ; les trous pénalisés.
 * Les accents et la casse sont ignorés (« theme » trouve « thème »).
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = normalize(query.replace(/\s+/g, ''))
  if (!q) return { score: 0, positions: [] }
  const t = normalize(target)

  // Une sous-chaîne exacte est presque toujours ce que l'on cherche.
  const sub = t.indexOf(q)
  if (sub >= 0) {
    const atWordStart = sub === 0 || SEPARATORS.has(target[sub - 1])
    const positions = Array.from({ length: q.length }, (_, i) => sub + i)
    return { score: 100 + q.length * 10 + (atWordStart ? 30 : 0) - target.length * 0.1, positions }
  }

  const positions: number[] = []
  let score = 0
  let ti = 0
  let prev = -1

  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti)
    if (found === -1) return null

    let s = 1
    if (found === prev + 1) s += 5
    else if (prev >= 0) s -= Math.min(found - prev - 1, 8) * 0.4
    const before = target[found - 1]
    if (found === 0 || SEPARATORS.has(before)) s += 8
    else if (target[found] !== target[found].toLowerCase() && before === before.toLowerCase()) s += 6 // camelCase
    score += s
    positions.push(found)
    prev = found
    ti = found + 1
  }

  // Favorise les correspondances dans le nom de fichier plutôt que dans le chemin.
  const lastSep = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  score += positions.filter((p) => p > lastSep).length * 2
  score -= target.length * 0.05
  return { score, positions }
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit = 200
): Array<{ item: T; match: FuzzyMatch }> {
  const out: Array<{ item: T; match: FuzzyMatch }> = []
  for (const item of items) {
    const match = fuzzyMatch(query, key(item))
    if (match) out.push({ item, match })
  }
  out.sort((a, b) => b.match.score - a.match.score)
  return out.slice(0, limit)
}
