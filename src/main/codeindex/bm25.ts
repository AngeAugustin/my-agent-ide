/**
 * Découpe un texte en termes de recherche : identifiants séparés (camelCase, snake_case),
 * minuscules, sans accents. Les identifiants composés sont aussi conservés entiers.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const words = text.normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[A-Za-z0-9_$]+/g) ?? []
  for (const word of words) {
    const lower = word.toLowerCase()
    if (lower.length >= 2 && lower.length <= 64) out.push(lower)
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
    if (parts.length > 1) {
      for (const p of parts) {
        const pl = p.toLowerCase()
        if (pl.length >= 2) out.push(pl)
      }
    }
  }
  return out
}

/** Index lexical BM25 (k1 = 1,2 ; b = 0,75). */
export class Bm25Index {
  private docs: Array<Map<string, number> | null> = []
  private lengths: number[] = []
  private df = new Map<string, number>()
  private totalLength = 0
  private count = 0

  /** Ajoute un document et renvoie son identifiant. */
  add(text: string): number {
    const tf = new Map<string, number>()
    const tokens = tokenize(text)
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    this.docs.push(tf)
    this.lengths.push(tokens.length)
    this.totalLength += tokens.length
    this.count++
    return this.docs.length - 1
  }

  remove(id: number): void {
    const tf = this.docs[id]
    if (!tf) return
    for (const t of tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1
      if (n <= 0) this.df.delete(t)
      else this.df.set(t, n)
    }
    this.totalLength -= this.lengths[id]
    this.docs[id] = null
    this.count--
  }

  get size(): number {
    return this.count
  }

  search(query: string, limit: number): Array<{ id: number; score: number }> {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0 || this.count === 0) return []
    const avg = this.totalLength / this.count || 1
    const k1 = 1.2
    const b = 0.75
    const scores = new Map<number, number>()
    for (const term of terms) {
      const df = this.df.get(term)
      if (!df) continue
      const idf = Math.log(1 + (this.count - df + 0.5) / (df + 0.5))
      this.docs.forEach((tf, id) => {
        const f = tf?.get(term)
        if (!f) return
        const norm = f + k1 * (1 - b + (b * this.lengths[id]) / avg)
        scores.set(id, (scores.get(id) ?? 0) + (idf * (f * (k1 + 1))) / norm)
      })
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit)
  }
}
