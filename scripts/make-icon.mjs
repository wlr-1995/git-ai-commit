/**
 * 生成 build/icon.ico（蓝色圆角方块 + 白色对勾）。
 *
 * 手写 PNG/ICO 之外的最小实现：ICO 容器 + 32bpp BGRA DIB（DIB 比 PNG 简单，
 * 不依赖任何图像库）。用法：node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SIZES = [256, 48, 32, 16]
const ACCENT = [0x25, 0x63, 0xeb]

const pad = (size) => Math.round(size * 0.06)
const radius = (size) => size * 0.22

function roundedCoverage(x, y, size) {
  const p = pad(size)
  const r = radius(size)
  const left = p + r
  const right = size - p - r
  const top = p + r
  const bottom = size - p - r
  const cx = x < left ? left : x > right ? right : x
  const cy = y < top ? top : y > bottom ? bottom : y
  const distance = Math.hypot(x - cx, y - cy)
  return Math.max(0, Math.min(1, r + 0.5 - distance))
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const length2 = vx * vx + vy * vy
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / length2))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

function renderPixels(size) {
  const stroke = size * 0.11
  const a = [size * 0.27, size * 0.53]
  const b = [size * 0.43, size * 0.69]
  const c = [size * 0.74, size * 0.33]
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5
      const cy = y + 0.5
      const bg = roundedCoverage(cx, cy, size)
      const distance = Math.min(
        segmentDistance(cx, cy, a[0], a[1], b[0], b[1]),
        segmentDistance(cx, cy, b[0], b[1], c[0], c[1]),
      )
      const check = Math.max(0, Math.min(1, stroke / 2 + 0.5 - distance))
      const offset = (y * size + x) * 4
      pixels[offset] = Math.round(ACCENT[2] * (1 - check) + 255 * check)
      pixels[offset + 1] = Math.round(ACCENT[1] * (1 - check) + 255 * check)
      pixels[offset + 2] = Math.round(ACCENT[0] * (1 - check) + 255 * check)
      pixels[offset + 3] = Math.round(bg * 255)
    }
  }
  return pixels
}

function dibFor(size) {
  const pixels = renderPixels(size)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(pixels.length, 20)

  const rows = []
  for (let y = size - 1; y >= 0; y -= 1) {
    rows.push(pixels.subarray(y * size * 4, (y + 1) * size * 4))
  }
  const maskRowBytes = Math.ceil(size / 32) * 4
  return Buffer.concat([header, Buffer.concat(rows), Buffer.alloc(maskRowBytes * size)])
}

const images = SIZES.map((size) => ({ size, data: dibFor(size) }))
const directory = Buffer.alloc(6 + images.length * 16)
directory.writeUInt16LE(0, 0)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(images.length, 4)

let offset = directory.length
images.forEach((image, index) => {
  const entry = 6 + index * 16
  const dimension = image.size >= 256 ? 0 : image.size
  directory.writeUInt8(dimension, entry)
  directory.writeUInt8(dimension, entry + 1)
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(image.data.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += image.data.length
})

const target = join(process.cwd(), "build")
mkdirSync(target, { recursive: true })
const icon = Buffer.concat([directory, ...images.map((image) => image.data)])
writeFileSync(join(target, "icon.ico"), icon)
console.log(`已生成 build/icon.ico（${SIZES.join("/")}，${icon.length} 字节）`)
