import fs from 'node:fs'
import path from 'node:path'
import { diskFs, findHostInfo, invalidateHostCache, isDir, isFile, readText } from './host-path.js'
import { extractAsarToDir, openAsar } from './asar.js'

const MARKER_NAME = 'dsh-laomao-extract.json'
const REQUIRED_PROBES = [
  'node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js',
  'node_modules/@deepseek-ai/dsh-user-approval/lib/types/index.js',
]

function stateDirFor(info, dshHome) {
  if (info.kind === 'asar' && info.asar) return path.dirname(info.asar)
  return dshHome
}

export function resolveTargetAppDir(info = findHostInfo()) {
  if (info.kind === 'asar' && info.asar) {
    const resources = path.dirname(info.asar)
    return {
      resourcesDir: resources,
      appDir: path.join(resources, 'app'),
      innerRoot: info.innerRoot || 'dsh',
      asar: info.asar,
    }
  }
  if (info.kind === 'extracted' && info.root) {
    const root = info.root
    if (path.basename(root) === 'dsh') {
      const appDir = path.dirname(root)
      return {
        resourcesDir: path.dirname(appDir),
        appDir,
        innerRoot: 'dsh',
        asar: path.join(path.dirname(appDir), 'app.asar'),
      }
    }
    return {
      resourcesDir: path.dirname(root),
      appDir: root,
      innerRoot: null,
      asar: path.join(path.dirname(root), 'app.asar'),
    }
  }
  return null
}

function readMarker(appDir) {
  const fp = path.join(appDir, MARKER_NAME)
  const raw = readText(fp)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeMarker(appDir, payload) {
  const fp = path.join(appDir, MARKER_NAME)
  const tmp = fp + '.tmp'
  try {
    diskFs().mkdirSync(appDir, { recursive: true })
    diskFs().writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    diskFs().renameSync(tmp, fp)
    return true
  } catch {
    try { diskFs().unlinkSync(tmp) } catch { /* 清理失败不阻断 */ }
    return false
  }
}

export function checkExtracted(info = findHostInfo()) {
  const layout = resolveTargetAppDir(info)
  if (!layout) {
    return {
      ok: false,
      reason: 'no-host',
      hint: '没有找到 DSH 安装位置，无法判断是否需要解包',
    }
  }

  const { appDir, innerRoot, asar } = layout
  const innerDir = innerRoot ? path.join(appDir, innerRoot) : appDir
  const marker = readMarker(appDir)
  const asarExists = Boolean(asar) && isFile(asar)

  if (!isDir(innerDir)) {
    return {
      ok: false,
      reason: 'not-extracted',
      needsExtract: true,
      appDir,
      innerRoot,
      asar,
      asarExists,
      layout,
      hint: `源码还在 ${asarExists ? 'app.asar' : '未知位置'} 里，需要先解包到 ${appDir}`,
    }
  }

  const missing = []
  for (const rel of REQUIRED_PROBES) {
    const fp = path.join(innerDir, ...rel.split('/'))
    if (!isFile(fp)) missing.push(rel)
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'incomplete',
      needsExtract: true,
      appDir,
      innerRoot,
      asar,
      asarExists,
      missing,
      layout,
      hint: `目录存在但缺 ${missing.length} 个关键文件，解包可能中断过`,
    }
  }

  return {
    ok: true,
    reason: 'extracted',
    appDir,
    innerRoot,
    asar,
    asarExists,
    marker,
    layout,
    hint: '已解包，补丁可以直接落盘',
  }
}

export function previewExtract(info = findHostInfo()) {
  if (!info || info.kind !== 'asar' || !info.asar) {
    const check = checkExtracted(info)
    return { ok: false, reason: 'already-extracted-or-missing', check }
  }
  const archive = openAsar(info.asar)
  if (!archive) {
    return { ok: false, reason: 'asar-unreadable', hint: '归档无法解析，不敢动' }
  }
  let files = 0
  let bytes = 0
  try {
    const walk = (node) => {
      for (const [, entry] of Object.entries(node.files || {})) {
        if (entry.files) walk(entry)
        else {
          files += 1
          bytes += Number(entry.size || 0)
        }
      }
    }
    walk(archive.header)
  } finally {
    archive.close()
  }
  const layout = resolveTargetAppDir(info)
  return {
    ok: true,
    reason: 'ready',
    asar: info.asar,
    targetDir: layout ? layout.appDir : '(未知)',
    files,
    bytes,
    megabytes: Number((bytes / 1024 / 1024).toFixed(1)),
    diskFreeHint: '解包会占用约 1.5 倍归档大小的磁盘空间',
  }
}

export function extractHost(info = findHostInfo(), options = {}) {
  if (!info || info.kind !== 'asar' || !info.asar) {
    const check = checkExtracted(info)
    return { ok: false, reason: 'not-needed', detail: check }
  }
  if (options.confirm !== true) {
    return {
      ok: false,
      reason: 'needs-confirmation',
      preview: previewExtract(info),
      hint: '解包会向 DSH 安装目录写入约 400MB 文件；调用时传 confirm: true 才会真正执行',
    }
  }

  const layout = resolveTargetAppDir(info)
  if (!layout) return { ok: false, reason: 'no-target' }

  const { appDir } = layout
  if (isDir(appDir)) {
    const existing = checkExtracted(info)
    if (existing.ok) {
      return { ok: true, reason: 'already-extracted', reused: true, detail: existing }
    }
  }

  const started = Date.now()
  const result = extractAsarToDir(info.asar, appDir)
  const elapsed = Date.now() - started

  if (!result.ok) {
    return { ok: false, reason: result.reason || 'extract-failed', appDir }
  }

  invalidateHostCache()

  writeMarker(appDir, {
    extractedAt: new Date().toISOString(),
    asar: info.asar,
    innerRoot: info.root || info.innerRoot || 'dsh',
    files: result.written,
  })

  const after = checkExtracted({
    kind: 'extracted',
    root: path.join(appDir, info.innerRoot || 'dsh'),
    asar: null,
  })

  return {
    ok: after.ok,
    reason: after.ok ? 'extracted' : 'verification-failed',
    appDir,
    filesWritten: result.written,
    elapsedMs: elapsed,
    detail: after,
    restartRequired: true,
    hint: after.ok
      ? '解包完成，重启 DSH 后会优先读取目录；之后补丁就能落盘了'
      : '解包完成但关键文件缺失，请检查磁盘空间或权限',
  }
}

export function removeExtracted(options = {}) {
  if (options.confirm !== true) {
    return { ok: false, reason: 'needs-confirmation' }
  }
  const info = findHostInfo()
  const layout = resolveTargetAppDir(info)
  if (!layout) return { ok: false, reason: 'no-host' }
  if (!isFile(layout.asar)) {
    return {
      ok: false,
      reason: 'asar-missing',
      hint: 'app.asar 不在，删掉解包目录 DSH 会无法启动，已拒绝',
    }
  }
  try {
    diskFs().rmSync(layout.appDir, { recursive: true, force: true })
    invalidateHostCache()
    return { ok: true, reason: 'removed', appDir: layout.appDir, restartRequired: true }
  } catch (err) {
    return { ok: false, reason: 'remove-failed', message: err && err.message ? err.message : String(err) }
  }
}
