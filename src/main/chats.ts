import { app, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_GIT_OUTPUT = 400_000

function chatFile(workspace: string | null): string {
  const key = createHash('sha1').update(workspace ?? '__global__').digest('hex').slice(0, 16)
  return join(app.getPath('userData'), 'chats', `${key}.json`)
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

/** Modifications Git en cours (indexées ou non) par rapport à HEAD. */
export async function gitDiff(cwd: string): Promise<string> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error("Ce dossier n'est pas un dépôt Git.")
  }
  let diff: string
  try {
    diff = await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff'])
  } catch {
    // Dépôt sans commit : on compare à l'index vide.
    diff = await git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff'])
  }
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).trim()
  let out = diff.trim() || 'Aucune modification par rapport au dernier commit.'
  if (untracked) out += `\n\nFichiers non suivis :\n${untracked}`
  if (out.length > MAX_GIT_OUTPUT) {
    out = `${out.slice(0, MAX_GIT_OUTPUT)}\n\n[… diff tronqué : ${out.length - MAX_GIT_OUTPUT} caractères non inclus]`
  }
  return out
}

export function registerChatHandlers(): void {
  ipcMain.handle('chats:load', async (_e, workspace: string | null) => {
    try {
      return JSON.parse(await fs.readFile(chatFile(workspace), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('chats:save', async (_e, workspace: string | null, data: unknown) => {
    const file = chatFile(workspace)
    await fs.mkdir(join(app.getPath('userData'), 'chats'), { recursive: true })
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
    await fs.rename(tmp, file)
  })

  ipcMain.handle('git:diff', (_e, cwd: string) => gitDiff(cwd))
}
