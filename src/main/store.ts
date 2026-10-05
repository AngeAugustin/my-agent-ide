import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Petit magasin JSON persistant dans le dossier de données de l'application. */
export class JsonStore<T extends object> {
  private cache: T | null = null
  private readonly file: string

  constructor(
    name: string,
    private readonly defaults: T
  ) {
    this.file = join(app.getPath('userData'), `${name}.json`)
  }

  async get(): Promise<T> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.cache = { ...this.defaults, ...raw }
    } catch {
      this.cache = { ...this.defaults }
    }
    return this.cache!
  }

  async set(value: T): Promise<void> {
    this.cache = value
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }
}
