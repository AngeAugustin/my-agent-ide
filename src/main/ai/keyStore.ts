import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/** Abstraction du chiffrement (safeStorage d'Electron en production, factice dans les tests). */
export interface Encryptor {
  /** Vrai si le chiffrement est réellement protégé par le trousseau du système. */
  isSecure(): boolean
  backend(): string
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

interface StoredKey {
  data: string
  /** « encrypted » : chiffrée par l'Encryptor ; « plain » : simple base64 (aucun chiffrement disponible). */
  encoding: 'encrypted' | 'plain'
  /** Faux si la clé n'est pas protégée par un trousseau du système. */
  secure: boolean
  masked: string
  updatedAt: number
}

interface KeyFile {
  version: 1
  keys: Record<string, StoredKey>
}

/** Masque une clé pour l'affichage : « sk-ant…x9Qz ». */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length <= 8) return '•'.repeat(Math.max(k.length - 2, 1)) + k.slice(-2)
  const prefixEnd = Math.min(6, Math.floor(k.length / 4))
  return `${k.slice(0, prefixEnd)}…${k.slice(-4)}`
}

/** Stocke les clés API chiffrées dans un fichier JSON. Les clés en clair ne sont jamais écrites sur le disque si un trousseau est disponible. */
export class KeyStore {
  private cache: KeyFile | null = null

  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor
  ) {}

  private async load(): Promise<KeyFile> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as KeyFile
      this.cache = parsed?.version === 1 && parsed.keys ? parsed : { version: 1, keys: {} }
    } catch {
      this.cache = { version: 1, keys: {} }
    }
    return this.cache
  }

  private async save(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  async set(providerId: string, key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('La clé est vide.')
    const file = await this.load()
    let data: string
    let encoding: StoredKey['encoding'] = 'encrypted'
    try {
      data = this.encryptor.encrypt(trimmed).toString('base64')
    } catch {
      // Aucun chiffrement disponible : la clé est simplement encodée (et signalée comme non protégée).
      data = Buffer.from(trimmed, 'utf8').toString('base64')
      encoding = 'plain'
    }
    const secure = encoding === 'encrypted' && this.encryptor.isSecure()
    file.keys[providerId] = { data, encoding, secure, masked: maskKey(trimmed), updatedAt: Date.now() }
    await this.save()
  }

  async get(providerId: string): Promise<string | null> {
    const entry = (await this.load()).keys[providerId]
    if (!entry) return null
    const buf = Buffer.from(entry.data, 'base64')
    if (entry.encoding === 'plain') return buf.toString('utf8')
    try {
      return this.encryptor.decrypt(buf)
    } catch {
      // Clé chiffrée sur une autre machine ou trousseau réinitialisé : elle doit être ressaisie.
      return null
    }
  }

  async delete(providerId: string): Promise<void> {
    const file = await this.load()
    delete file.keys[providerId]
    await this.save()
  }

  async list(): Promise<Record<string, { masked: string; updatedAt: number; secure: boolean }>> {
    const file = await this.load()
    return Object.fromEntries(
      Object.entries(file.keys).map(([id, k]) => [id, { masked: k.masked, updatedAt: k.updatedAt, secure: k.secure }])
    )
  }
}
