// Génère l'icône de l'application (build/icon.png, 1024×1024) sans dépendance :
// carré arrondi violet avec un symbole « </> », encodé en PNG avec zlib.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const S = 1024
const px = new Uint8Array(S * S * 4)

function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

function roundedBox(x, y, half, r) {
  const qx = Math.abs(x) - half + r
  const qy = Math.abs(y) - half + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

const strokes = [
  // « < »
  [370, 330, 230, 512],
  [230, 512, 370, 694],
  // « > »
  [654, 330, 794, 512],
  [794, 512, 654, 694],
  // « / »
  [575, 300, 449, 724]
]

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const d = roundedBox(x - S / 2 + 0.5, y - S / 2 + 0.5, 440, 200)
    const bgAlpha = Math.max(0, Math.min(1, 0.5 - d))
    if (bgAlpha <= 0) continue
    // Dégradé violet (haut gauche) → indigo (bas droit).
    const t = (x + y) / (2 * S)
    let r = 139 + (79 - 139) * t
    let g = 92 + (70 - 92) * t
    let b = 246 + (229 - 246) * t
    let sd = Infinity
    for (const [ax, ay, bx, by] of strokes) sd = Math.min(sd, segDist(x + 0.5, y + 0.5, ax, ay, bx, by))
    const strokeAlpha = Math.max(0, Math.min(1, 38 - sd + 0.5))
    r = r + (255 - r) * strokeAlpha
    g = g + (255 - g) * strokeAlpha
    b = b + (255 - b) * strokeAlpha
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = Math.round(bgAlpha * 255)
  }
}

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log(`build/icon.png (${png.length} octets)`)
