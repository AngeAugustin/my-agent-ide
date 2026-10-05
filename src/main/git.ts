import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import type { GitBranch, GitFileStatus, GitStatus } from '@shared/git'

const MAX_DIFF = 400_000

/** Exécute git sans jamais attendre une saisie (identifiants, éditeur, pager). */
export function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat', LC_ALL: 'C' }
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).trim()
          reject(new Error(msg.includes('ENOENT') ? 'Git n’est pas installé ou introuvable dans le PATH.' : msg))
        } else resolve(stdout)
      }
    )
  })
}

/** Analyse la sortie de `git status --porcelain=v1 -z -b`. */
export function parseStatus(out: string): Omit<GitStatus, 'isRepo'> {
  const parts = out.split('\0')
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      // Ex. : « main...origin/main [ahead 1, behind 2] », « No commits yet on main », « HEAD (no branch) ».
      let head = entry.slice(3).replace(/^(No commits yet on|Initial commit on) /, '')
      const info = head.match(/ \[(.*)\]$/)?.[1] ?? ''
      head = head.replace(/ \[.*\]$/, '')
      if (head.startsWith('HEAD (no branch)')) branch = null
      else {
        const [name, up] = head.split('...')
        branch = name
        upstream = up ?? null
      }
      ahead = Number(info.match(/ahead (\d+)/)?.[1] ?? 0)
      behind = Number(info.match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }
    const index = entry[0]
    const worktree = entry[1]
    const path = entry.slice(3)
    const file: GitFileStatus = { path, index, worktree }
    // Renommage ou copie : le chemin d'origine suit dans l'élément suivant.
    if (index === 'R' || index === 'C') file.origPath = parts[++i]
    files.push(file)
  }
  return { branch, upstream, ahead, behind, files }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  }
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'])
  return { isRepo: true, ...parseStatus(out) }
}

async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

function truncate(text: string): string {
  return text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n[… diff tronqué : ${text.length - MAX_DIFF} caractères non inclus]` : text
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_e, cwd: string) => gitStatus(cwd))
  ipcMain.handle('git:init', (_e, cwd: string) => git(cwd, ['init']))
  ipcMain.handle('git:stage', (_e, cwd: string, paths: string[]) => git(cwd, ['add', '--', ...paths]))
  ipcMain.handle('git:unstage', async (_e, cwd: string, paths: string[]) =>
    (await hasCommits(cwd)) ? git(cwd, ['restore', '--staged', '--', ...paths]) : git(cwd, ['rm', '--cached', '-r', '-q', '--', ...paths])
  )
  /** Annule les modifications de fichiers suivis (les fichiers non suivis sont mis à la corbeille par l'interface). */
  ipcMain.handle('git:discard', (_e, cwd: string, paths: string[]) => git(cwd, ['restore', '--worktree', '--', ...paths]))
  ipcMain.handle('git:commit', (_e, cwd: string, message: string, amend: boolean) =>
    git(cwd, ['commit', ...(amend ? ['--amend'] : []), '-m', message])
  )
  ipcMain.handle('git:branches', async (_e, cwd: string): Promise<GitBranch[]> => {
    const out = await git(cwd, ['branch', '--all', '--format=%(HEAD)%09%(refname:short)%09%(refname)'])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [head, name, ref] = line.split('\t')
        return { name, current: head === '*', remote: ref.startsWith('refs/remotes/') }
      })
      .filter((b) => !b.name.endsWith('/HEAD'))
  })
  ipcMain.handle('git:checkout', (_e, cwd: string, branch: string, create: boolean) =>
    git(cwd, create ? ['checkout', '-b', branch] : ['checkout', branch])
  )
  ipcMain.handle('git:push', async (_e, cwd: string) => {
    const status = await gitStatus(cwd)
    return git(cwd, status.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], 120_000)
  })
  ipcMain.handle('git:pull', (_e, cwd: string) => git(cwd, ['pull', '--no-edit'], 120_000))
  ipcMain.handle('git:fetch', (_e, cwd: string) => git(cwd, ['fetch', '--all', '--prune'], 120_000))
  /** Contenu d'un fichier à une révision (« HEAD » ou index « : »), vide s'il n'existe pas. */
  ipcMain.handle('git:show', async (_e, cwd: string, ref: string, path: string) => {
    try {
      return await git(cwd, ['show', `${ref}:${path}`])
    } catch {
      return null
    }
  })
  ipcMain.handle('git:stagedDiff', async (_e, cwd: string) => truncate(await git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff'])))
  ipcMain.handle('git:log', async (_e, cwd: string, count: number) => {
    if (!(await hasCommits(cwd))) return []
    return (await git(cwd, ['log', `-n${count}`, '--pretty=%s'])).split('\n').filter(Boolean)
  })
}
