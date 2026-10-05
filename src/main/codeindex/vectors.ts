/** Normalise un vecteur (norme 1) pour que le produit scalaire donne la similarité cosinus. */
export function normalize(v: number[] | Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function encodeVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
}

export function decodeVector(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64')
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/**
 * Fusion de classements (Reciprocal Rank Fusion) : combine la recherche lexicale et
 * la recherche sémantique sans avoir à comparer leurs scores.
 */
export function reciprocalRankFusion(rankings: number[][], k = 60): Array<{ id: number; score: number }> {
  const scores = new Map<number, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)))
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}
