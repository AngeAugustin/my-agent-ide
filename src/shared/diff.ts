export type DiffOp =
  | { type: 'equal'; oldStart: number; newStart: number; count: number }
  | { type: 'insert'; newStart: number; count: number; oldIndex: number }
  | { type: 'delete'; oldStart: number; count: number; newIndex: number }

/**
 * Différence ligne à ligne (plus longue sous-séquence commune).
 * Les indices sont en base 0. Les préfixes et suffixes communs sont retirés d'abord
 * pour que les gros fichiers peu modifiés restent rapides.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const n = A.length
  const m = B.length

  // Table LCS (n et m restent petits après l'élagage des parties communes).
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const ops: DiffOp[] = []
  const push = (op: DiffOp) => {
    const last = ops[ops.length - 1]
    if (last && last.type === op.type) {
      last.count += op.count
      return
    }
    ops.push(op)
  }

  if (pre > 0) push({ type: 'equal', oldStart: 0, newStart: 0, count: pre })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      push({ type: 'equal', oldStart: pre + i, newStart: pre + j, count: 1 })
      i++
      j++
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      push({ type: 'insert', newStart: pre + j, count: 1, oldIndex: pre + i })
      j++
    } else {
      push({ type: 'delete', oldStart: pre + i, count: 1, newIndex: pre + j })
      i++
    }
  }
  if (suf > 0) push({ type: 'equal', oldStart: a.length - suf, newStart: b.length - suf, count: suf })
  return ops
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'insert') added += op.count
    else if (op.type === 'delete') removed += op.count
  }
  return { added, removed }
}
