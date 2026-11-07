import path from 'node:path'
import { diskFs, findDshHome, findHostInfo, isFile, laomaoStateDir, readText } from './host-path.js'
import { checkExtracted, extractHost, previewExtract } from './extract.js'
import { applyPatches, probe } from './patches.js'

const BOOT_STATE = 'boot.json'
const SCHEMA = 1

function bootStatePath(dshHome) {
  return path.join(laomaoStateDir(dshHome), BOOT_STATE)
}

function readBootState(dshHome) {
  const raw = readText(bootStatePath(dshHome))
  if (!raw) return { schema: SCHEMA, attempts: [], lastAsar: null, lastOutcome: null }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('bad state')
    return {
      schema: SCHEMA,
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      lastAsar: parsed.lastAsar || null,
      lastOutcome: parsed.lastOutcome || null,
    }
  } catch {
    return { schema: SCHEMA, attempts: [], lastAsar: null, lastOutcome: null }
  }
}

function writeBootState(dshHome, state) {
  const fp = bootStatePath(dshHome)
  const tmp = fp + '.' + process.pid + '.tmp'
  try {
    diskFs().mkdirSync(path.dirname(fp), { recursive: true })
    diskFs().writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    diskFs().renameSync(tmp, fp)
    return true
  } catch {
    try { diskFs().unlinkSync(tmp) } catch { /* 清理失败不阻断 */ }
    return false
  }
}

function asarIdentity(asarPath) {
  if (!asarPath || !isFile(asarPath)) return null
  try {
    const io = diskFs()
    const stat = io.statSync(asarPath)
    return {
      path: asarPath,
      size: stat.size,
      mtime: stat.mtimeMs,
    }
  } catch {
    return null
  }
}

function sameIdentity(a, b) {
  if (!a || !b) return false
  return a.path === b.path && a.size === b.size && a.mtime === b.mtime
}

export function describeBootPlan(options = {}) {
  const info = findHostInfo(options)
  const extracted = checkExtracted(info)

  if (extracted.ok) {
    const report = probe(options)
    return {
      action: 'none',
      phase: 'ready',
      summary: '已解包，无需引导',
      detail: extracted,
      patches: report.summary,
      hostKind: info.kind,
    }
  }

  if (!extracted.needsExtract) {
    return {
      action: 'none',
      phase: 'blocked',
      summary: '找不到宿主或归档不可读',
      detail: extracted,
      hostKind: info.kind,
    }
  }

  const preview = previewExtract(info)
  return {
    action: 'extract',
    phase: 'needs-extract',
    summary: preview.ok
      ? `需要解包：${preview.files} 个文件 / ${preview.megabytes} MB`
      : `无法解包：${preview.reason}`,
    detail: extracted,
    preview,
    hostKind: info.kind,
    targetDir: preview.targetDir,
  }
}

export function runBootPipeline(options = {}) {
  const dshHome = findDshHome()
  const state = readBootState(dshHome)
  const info = findHostInfo(options)
  const events = []
  const push = (message, extra = {}) => events.push({ at: new Date().toISOString(), message, ...extra })

  const asar = asarIdentity(info.kind === 'asar' && info.asar ? info.asar : null)

  if (state.lastOutcome === 'done') {
    const extractedNow = checkExtracted(info)
    const sameArsar = asar === null || sameIdentity(asar, state.lastAsar)
    if (extractedNow.ok && sameArsar) {
      const report = probe(options)
      if (report.summary.pending === 0 && report.summary.failed === 0) {
        push('已引导且无待处理补丁，跳过')
        return {
          ok: true,
          skipped: true,
          reason: 'already-bootstrapped-for-this-asar',
          events,
          hostKind: info.kind,
          extraction: extractedNow,
          patches: report.summary,
        }
      }
      push('已解包但仍有待处理补丁，继续打补丁')
    } else if (!extractedNow.ok) {
      push('上次标记完成但目录不在了，重新解包')
    }
  }

  const extractedBefore = checkExtracted(info)
  let extraction = extractedBefore

  if (!extractedBefore.ok) {
    if (!extractedBefore.needsExtract) {
      push('宿主不可定位，放弃解包')
      state.lastOutcome = 'blocked'
      writeBootState(dshHome, state)
      return {
        ok: false,
        reason: 'host-not-found',
        events,
        hostKind: info.kind,
        extraction: extractedBefore,
      }
    }

    push('开始解包 app.asar', { appDir: extractedBefore.appDir })
    const started = Date.now()
    const result = extractHost(info, { confirm: true })
    const elapsed = Date.now() - started
    push(result.ok ? `解包完成（${result.filesWritten || 0} 文件 / ${elapsed} ms）` : `解包失败：${result.reason}`, {
      appDir: result.appDir,
      files: result.filesWritten,
      elapsedMs: elapsed,
    })

    if (!result.ok) {
      state.lastOutcome = 'extract-failed'
      state.lastAsar = asar
      state.attempts.push({ at: new Date().toISOString(), step: 'extract', ok: false, reason: result.reason })
      writeBootState(dshHome, state)
      return { ok: false, reason: 'extract-failed', detail: result, events }
    }

    extraction = checkExtracted()
  }

  const refreshed = findHostInfo(options)
  push('宿主判定刷新', { kind: refreshed.kind, root: refreshed.root })

  if (refreshed.kind !== 'extracted') {
    push('解包后仍无法定位到目录，放弃打补丁')
    state.lastOutcome = 'host-unresolved'
    state.lastAsar = asar
    writeBootState(dshHome, state)
    return { ok: false, reason: 'host-unresolved-after-extract', events, hostKind: refreshed.kind }
  }

  const before = probe(options)
  push('补丁探针', before.summary)

  if (before.summary.pending === 0 && before.summary.failed === 0) {
    push('没有需要应用的补丁')
    state.lastOutcome = 'done'
    state.lastAsar = asar
    state.attempts.push({ at: new Date().toISOString(), step: 'apply', ok: true, reason: 'nothing-to-do' })
    writeBootState(dshHome, state)
    return { ok: true, events, patches: before.summary, extraction, hostKind: refreshed.kind }
  }

  const applied = applyPatches(options)
  push('补丁应用完成', applied.summary)

  const allOk = applied.summary.failed === 0
  state.lastOutcome = allOk ? 'done' : 'apply-partial'
  state.lastAsar = asar
  state.attempts.push({
    at: new Date().toISOString(),
    step: 'apply',
    ok: allOk,
    summary: applied.summary,
  })
  if (state.attempts.length > 40) state.attempts = state.attempts.slice(-40)
  writeBootState(dshHome, state)

  return {
    ok: allOk,
    events,
    patches: applied.summary,
    results: applied.results,
    extraction,
    hostKind: refreshed.kind,
    restartRequired: applied.restartRequired,
  }
}

export function readBootLog() {
  const dshHome = findDshHome()
  const state = readBootState(dshHome)
  return {
    stateFile: bootStatePath(dshHome),
    schema: state.schema,
    lastAsar: state.lastAsar,
    lastOutcome: state.lastOutcome,
    attempts: state.attempts.slice(-10),
  }
}

export function resetBootState() {
  const dshHome = findDshHome()
  writeBootState(dshHome, { schema: SCHEMA, attempts: [], lastAsar: null, lastOutcome: null })
  return { ok: true, stateFile: bootStatePath(dshHome) }
}
