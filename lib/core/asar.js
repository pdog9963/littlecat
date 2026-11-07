import path from 'node:path'
import { diskFs, isFile } from './host-path.js'

const ASAR_ALIGN = 4

export function readAsarHeader(asarPath) {
  const io = diskFs()
  const fd = io.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    io.readSync(fd, head, 0, 16, 0)
    const size = head.readUInt32LE(12)
    if (size <= 0 || size > 128 * 1024 * 1024) return null
    const payload = Buffer.alloc(size)
    io.readSync(fd, payload, 0, size, 16)
    const header = JSON.parse(payload.toString('utf8'))
    if (!header || typeof header !== 'object' || !header.files) return null
    return header
  } catch {
    return null
  } finally {
    try { io.closeSync(fd) } catch { /* 关闭失败不阻断 */ }
  }
}

function dataOffset(headerPayloadSize) {
  const raw = 16 + headerPayloadSize
  return raw + ((ASAR_ALIGN - (raw % ASAR_ALIGN)) % ASAR_ALIGN)
}

export function openAsar(asarPath) {
  if (!isFile(asarPath)) return null
  const io = diskFs()
  const header = readAsarHeader(asarPath)
  if (!header) return null
  const fd = io.openSync(asarPath, 'r')
  let offsetBase
  try {
    const head = Buffer.alloc(16)
    io.readSync(fd, head, 0, 16, 0)
    offsetBase = dataOffset(head.readUInt32LE(12))
  } catch {
    offsetBase = 0
  }

  const lookup = (relPath) => {
    const parts = String(relPath).split('/').filter(Boolean)
    let node = header
    for (const part of parts) {
      const files = node && node.files
      if (!files || !Object.prototype.hasOwnProperty.call(files, part)) return null
      node = files[part]
    }
    return node || null
  }

  const readFile = (relPath) => {
    const entry = lookup(relPath)
    if (!entry || entry.files) return null
    if (typeof entry.unpacked === 'string' && entry.unpacked) {
      const diskPath = asarPath + '.unpacked/' + entry.unpacked.split(path.sep).join('/')
      try { return io.readFileSync(diskPath) } catch { return null }
    }
    const size = Number(entry.size || 0)
    if (!Number.isFinite(size) || size < 0) return null
    const start = offsetBase + Number(entry.offset || 0)
    try {
      const out = Buffer.alloc(size)
      io.readSync(fd, out, 0, size, start)
      return out
    } catch {
      return null
    }
  }

  const readText = (relPath) => {
    const buf = readFile(relPath)
    if (!buf) return null
    try { return buf.toString('utf8') } catch { return null }
  }

  const list = (relPrefix = '') => {
    const parts = String(relPrefix).split('/').filter(Boolean)
    let node = header
    for (const part of parts) {
      const files = node && node.files
      if (!files || !files[part]) return []
      node = files[part]
    }
    const out = []
    const walk = (cur, prefix) => {
      const files = cur && cur.files
      if (!files) return
      for (const [name, entry] of Object.entries(files)) {
        const next = prefix ? prefix + '/' + name : name
        if (entry && entry.files) walk(entry, next)
        else out.push(next)
      }
    }
    walk(node, relPrefix)
    return out
  }

  const close = () => {
    try { io.closeSync(fd) } catch { /* 已关闭 */ }
  }

  return { header, lookup, readFile, readText, list, close, path: asarPath }
}

export function extractAsarToDir(asarPath, destDir) {
  const archive = openAsar(asarPath)
  if (!archive) return { ok: false, reason: 'asar-unreadable' }
  const io = diskFs()
  let written = 0
  try {
    const walk = (node, relDir) => {
      const files = node && node.files
      if (!files) return
      for (const [name, entry] of Object.entries(files)) {
        const rel = relDir ? relDir + '/' + name : name
        if (entry && entry.files) {
          const dir = path.join(destDir, ...rel.split('/'))
          try { io.mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
          walk(entry, rel)
        } else {
          const buf = archive.readFile(rel)
          if (!buf) continue
          const fp = path.join(destDir, ...rel.split('/'))
          try {
            io.mkdirSync(path.dirname(fp), { recursive: true })
            io.writeFileSync(fp, buf)
            written += 1
          } catch { /* 单个文件失败不阻断整包 */ }
        }
      }
    }
    walk(archive.header, '')
  } finally {
    archive.close()
  }
  return { ok: true, written }
}
