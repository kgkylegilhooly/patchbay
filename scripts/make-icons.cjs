'use strict'
// Draws the app and tray icons into resources/. Rerun it after changing the drawing: `node scripts/make-icons.cjs`.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUT = path.join(__dirname, '..', 'resources')
const SAMPLES = 4
const BLUE = [47, 123, 246]
const WHITE = [255, 255, 255]
const RED = [255, 69, 58]

const roundedBox = (x, y, half, radius) => {
  const dx = Math.abs(x - 0.5) - half + radius
  const dy = Math.abs(y - 0.5) - half + radius
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
}

const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

const segment = (x, y, ax, ay, bx, by) => {
  const t = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)))
}

/** Each digit as strokes between named points, like a clock face: a b across the top, c d the middle, e f the bottom. */
const DIGITS = {
  2: ['ab', 'bd', 'dc', 'ce', 'ef'],
  3: ['ab', 'bf', 'fe', 'cd'],
  4: ['ac', 'cd', 'bf'],
  5: ['ba', 'ac', 'cd', 'df', 'fe'],
  6: ['ba', 'ae', 'ef', 'fd', 'dc'],
  7: ['ab', 'bf'],
  8: ['ab', 'bf', 'fe', 'ea', 'cd'],
  9: ['dc', 'ca', 'ab', 'bf', 'fe']
}

function onDigit(x, y, digit, left, right, width) {
  const [top, middle, bottom] = [0.25, 0.5, 0.75]
  if (digit === 1) {
    const mid = (left + right) / 2
    return segment(x, y, mid, top, mid, bottom) <= width || segment(x, y, mid - 0.1, top + 0.09, mid, top) <= width
  }
  const at = { a: [left, top], b: [right, top], c: [left, middle], d: [right, middle], e: [left, bottom], f: [right, bottom] }
  return DIGITS[digit].some(([from, to]) => segment(x, y, ...at[from], ...at[to]) <= width)
}

/** The color at a point, or null outside the icon: two jacks joined by a cable, on a rounded square. */
function shade(x, y, alert) {
  if (typeof alert === 'number' || alert === 'many') {
    if (circle(x, y, 0.5, 0.5, 0.49) > 0) return null
    if (alert === 'many') {
      const plus = segment(x, y, 0.62, 0.5, 0.86, 0.5) <= 0.055 || segment(x, y, 0.74, 0.38, 0.74, 0.62) <= 0.055
      return plus || onDigit(x, y, 9, 0.2, 0.46, 0.065) ? WHITE : RED
    }
    return onDigit(x, y, alert, 0.37, 0.63, 0.075) ? WHITE : RED
  }
  if (alert) {
    if (circle(x, y, 0.76, 0.76, 0.22) <= 0) return RED
    if (circle(x, y, 0.76, 0.76, 0.3) <= 0) return null
  }
  if (roundedBox(x, y, 0.47, 0.17) > 0) return null
  const jack = circle(x, y, 0.3, 0.32, 0.12) <= 0 || circle(x, y, 0.7, 0.68, 0.12) <= 0
  const cable = segment(x, y, 0.3, 0.32, 0.7, 0.68) <= 0.055
  return jack || cable ? WHITE : BLUE
}

function crcTable() {
  return Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
}
const CRC = crcTable()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([len, name, data, crc])
}

function png(size, alert) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1)
    for (let px = 0; px < size; px++) {
      let [r, g, b, covered] = [0, 0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = shade((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, alert)
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          covered++
        }
      }
      const at = row + 1 + px * 4
      if (covered) {
        raw[at] = Math.round(r / covered)
        raw[at + 1] = Math.round(g / covered)
        raw[at + 2] = Math.round(b / covered)
        raw[at + 3] = Math.round((255 * covered) / SAMPLES ** 2)
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** An .ico file can simply hold PNGs. A shortcut's icon has to be one. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(([size, data], i) => {
    const at = 6 + 16 * i
    header[at] = size % 256
    header[at + 1] = size % 256
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map(([, data]) => data)])
}

const files = {
  'icon.png': [256, false],
  'tray.png': [16, false],
  'tray@2x.png': [32, false],
  'tray-alert.png': [16, true],
  'tray-alert@2x.png': [32, true]
}
for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 'many']) {
  files[`badge-${count}.png`] = [16, count]
  files[`badge-${count}@2x.png`] = [32, count]
}
for (const [name, [size, alert]] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), png(size, alert))
  console.log(name)
}
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico([256, 48, 32, 16].map((size) => [size, png(size, false)])))
console.log('icon.ico')
