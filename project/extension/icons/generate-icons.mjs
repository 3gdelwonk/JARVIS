/**
 * generate-icons.mjs — Generate PNG icons for the Chrome extension
 *
 * Run once:  node extension/icons/generate-icons.mjs
 * Requires:  Node.js 18+ (uses built-in canvas via OffscreenCanvas in workers?
 *            No — uses the 'canvas' npm package if available, or falls back to
 *            writing minimal valid PNG bytes directly.)
 *
 * This script writes icon16.png, icon48.png, icon128.png into the same
 * directory using only Node.js built-ins (no canvas package needed).
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync as write } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Minimal PNG writer ───────────────────────────────────────────────────────
// Writes a solid-colour square PNG without any external dependency.
// Reference: https://www.w3.org/TR/PNG/

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

function crc32(buf) {
  let crc = 0xffffffff
  const table = crc32.table ??= (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[i] = c
    }
    return t
  })()
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function uint32BE(n) {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32BE(n)
  return b
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const dataBytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const crcInput = Buffer.concat([typeBytes, dataBytes])
  return Buffer.concat([uint32BE(dataBytes.length), typeBytes, dataBytes, uint32BE(crc32(crcInput))])
}

function makePNG(size, r, g, b) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR: width, height, bit depth 8, color type 2 (RGB), deflate, adaptive, no interlace
  const ihdrData = Buffer.concat([uint32BE(size), uint32BE(size), Buffer.from([8, 2, 0, 0, 0])])
  const ihdr = chunk('IHDR', ihdrData)

  // IDAT: scanlines (filter byte 0 + RGB per pixel)
  const row = Buffer.allocUnsafe(1 + size * 3)
  row[0] = 0  // filter type None
  for (let i = 0; i < size; i++) { row[1 + i * 3] = r; row[2 + i * 3] = g; row[3 + i * 3] = b }
  const raw = Buffer.concat(Array(size).fill(row))
  const idat = chunk('IDAT', deflateSync(raw))

  const iend = chunk('IEND', Buffer.alloc(0))

  return Buffer.concat([sig, ihdr, idat, iend])
}

// IGA / Milk Manager blue: #2563eb
const R = 0x25, G = 0x63, B = 0xeb

for (const size of [16, 48, 128]) {
  const outPath = join(__dirname, `icon${size}.png`)
  write(outPath, makePNG(size, R, G, B))
  console.log(`Written: ${outPath}`)
}

console.log('Icons generated successfully.')
