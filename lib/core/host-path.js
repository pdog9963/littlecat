import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

const MAX_ANCESTOR_SCAN = 12
const AI_MARKERS = ['dsh-agent-instructions', 'dsh-base', 'dsh-web-app', 'dsh']

let diskFsCache = null
let hostInfoCache = null

export function diskFs() {
  if (diskFsCache) return diskFsCache
  process.noDeprecation = true
  try {
    diskFsCache = require_('original-fs')
  } catch {
    diskFsCache = fs
  }
  return diskFsCache
}

export function invalidateHostCache() {
  hostInfoCache = null
}

export function isFile(fp) {
  if (!fp) return false
  try {
    return diskFs().statSync(fp).isFile()
  } catch {
    return false
  }
}

export function isDir(fp) {
  if (!fp) return false
  try {
    return diskFs().statSync(fp).isDirectory()
  } catch {
    return false
  }
}

export function readText(fp) {
  if (!fp) return null
  try {
    return diskFs().readFileSync(fp, 'utf8')
  } catch {
    return null
  }
}

export function ensureDir(dir) {
  try {
    diskFs().mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

export function findDshHome(options = {}) {
  const env = options.env ?? process.env
  const fromEnv = env.DSH_HOME
  if (fromEnv && String(fromEnv).trim()) return path.normalize(String(fromEnv).trim())
  return path.join(os.homedir(), '.dsh')
}

export function laomaoStateDir(dshHome = findDshHome()) {
  return path.join(dshHome, 'dsh-laomao')
}

function ancestors(start, limit = MAX_ANCESTOR_SCAN) {
  const out = []
  let cur = path.resolve(start)
  for (let depth = 0; depth < limit; depth += 1) {
    out.push(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}

function looksLikeExtractedHost(dir) {
  if (!dir) return false
  const nm = path.join(dir, 'node_modules', '@deepseek-ai')
  if (!isDir(nm)) return false
  for (const marker of AI_MARKERS) {
    if (isDir(path.join(nm, marker))) return true
  }
  return false
}

const COMMON_INSTALL_DIRS = [
  'C:/Users/1145/AppData/Local/Programs/DeepSeek Harness',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness'),
  path.join(os.homedir(), 'AppData', 'Local', 'DeepSeekHarness'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'dsh'),
  '/Applications/DeepSeek Harness.app/Contents',
  '/opt/DeepSeek Harness',
  '/opt/dsh',
  '/opt/deepseek-harness',
  '/opt/deepseek-harness/app',
  '/usr/lib/dsh',
  '/usr/local/lib/dsh',
  '/usr/share/dsh',
  '/usr/local/lib/node_modules/dsh',
  path.join(os.homedir(), 'Applications', 'DeepSeek Harness'),
  path.join(os.homedir(), '.local', 'share', 'dsh'),
  path.join(os.homedir(), '.local', 'lib', 'dsh'),
  '/root/dsh',
  '/data/dsh',
]

function nodeLauncherRoots() {
  const out = []
  const seen = new Set()
  const add = (candidate) => {
    if (!candidate) return
    let normalized
    try {
      normalized = path.normalize(String(candidate))
    } catch {
      return
    }
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }

  add(process.env.DSH_INSTALL_ROOT)
  add(process.env.DSH_ROOT)

  if (process.execPath) {
    const exePath = String(process.execPath)
    const bin = path.dirname(exePath)
    add(path.join(bin, '..'))
    add(path.join(bin, '..', '..'))
    let real = null
    try {
      real = diskFs().realpathSync(exePath)
    } catch {
      real = null
    }
    if (real && real !== exePath) {
      const realBin = path.dirname(real)
      add(path.join(realBin, '..'))
      add(path.join(realBin, '..', '..'))
    }
  }

  if (process.argv && process.argv[1]) {
    let entry = null
    try {
      entry = diskFs().realpathSync(String(process.argv[1]))
    } catch {
      entry = null
    }
    if (entry) {
      for (const dir of ancestors(path.dirname(entry), 6)) add(dir)
    }
  }

  return out
}

function asarCandidates() {
  const out = []
  if (process.resourcesPath) out.push(path.join(String(process.resourcesPath), 'app.asar'))
  if (process.execPath) {
    const exeDir = path.dirname(process.execPath)
    out.push(path.join(exeDir, 'resources', 'app.asar'))
    out.push(path.join(exeDir, '..', 'resources', 'app.asar'))
    out.push(path.join(exeDir, '..', '..', 'resources', 'app.asar'))
  }
  for (const dir of ancestors(MODULE_DIR, 8)) {
    out.push(path.join(dir, 'resources', 'app.asar'))
    out.push(path.join(dir, 'app.asar'))
  }
  for (const base of COMMON_INSTALL_DIRS) {
    out.push(path.join(base, 'resources', 'app.asar'))
    out.push(path.join(base, 'app.asar'))
    out.push(path.join(base, 'Resources', 'app.asar'))
  }
  return [...new Set(out.map((p) => path.normalize(p)))]
}

function findExtractedRoot() {
  const guesses = []
  for (const root of nodeLauncherRoots()) {
    guesses.push(root)
    guesses.push(path.join(root, 'node_modules'))
    guesses.push(path.join(root, 'lib', 'node_modules'))
    guesses.push(path.join(root, 'app'))
  }
  if (process.resourcesPath) {
    const res = String(process.resourcesPath)
    guesses.push(path.join(res, 'app'))
    guesses.push(path.join(res, 'app', 'dsh'))
    guesses.push(path.join(res, 'app.asar.unpacked'))
    guesses.push(res)
  }
  if (process.execPath) {
    const exeDir = path.dirname(process.execPath)
    const res = path.join(exeDir, 'resources')
    guesses.push(path.join(res, 'app'))
    guesses.push(path.join(res, 'app', 'dsh'))
    guesses.push(path.join(res, 'app.asar.unpacked'))
    guesses.push(path.join(exeDir, '..', 'resources', 'app'))
  }
  for (const base of COMMON_INSTALL_DIRS) {
    const res = path.join(base, 'resources')
    guesses.push(path.join(res, 'app'))
    guesses.push(path.join(res, 'app', 'dsh'))
    guesses.push(path.join(res, 'app.asar.unpacked'))
    guesses.push(path.join(res, 'Resources', 'app'))
  }
  for (const dir of ancestors(MODULE_DIR)) {
    guesses.push(dir)
    guesses.push(path.join(dir, 'node_modules'))
  }
  for (const guess of guesses) {
    if (looksLikeExtractedHost(guess)) return path.normalize(guess)
    const nested = path.join(guess, 'dsh')
    if (looksLikeExtractedHost(nested)) return path.normalize(nested)
    const nestedApp = path.join(guess, 'app')
    if (looksLikeExtractedHost(nestedApp)) return path.normalize(nestedApp)
  }
  return null
}

export function findHostInfo(options = {}) {
  if (options.hostRoot) {
    return { root: path.normalize(options.hostRoot), kind: 'extracted', asar: null }
  }
  if (hostInfoCache) return hostInfoCache

  const extracted = findExtractedRoot()
  if (extracted) {
    hostInfoCache = { root: extracted, kind: 'extracted', asar: null, innerRoot: null }
    return hostInfoCache
  }

  for (const cand of asarCandidates()) {
    if (!isFile(cand)) continue
    const discovered = asarInnerRoot(cand)
    hostInfoCache = {
      root: null,
      kind: 'asar',
      asar: cand,
      innerRoot: discovered || 'dsh',
    }
    return hostInfoCache
  }

  hostInfoCache = { root: null, kind: 'none', asar: null, innerRoot: null }
  return hostInfoCache
}

const ASAR_WALK_LIMIT = 240000

function asarInnerRoot(asarPath) {
  const probe = openAsarShallow(asarPath)
  if (!probe) return null
  const files = probe.files || {}
  const ordered = ['dsh', 'app', 'main', 'src']
  for (const name of ordered) {
    const entry = files[name]
    if (entry && entry.files && entry.files.node_modules) return name
    if (entry && entry.files && entry.files['node_modules']) return name
  }
  for (const [name, entry] of Object.entries(files)) {
    if (!entry || !entry.files) continue
    if (entry.files.node_modules) {
      const ai = entry.files.node_modules.files?.['@deepseek-ai']
      if (ai && ai.files) return name
    }
  }
  for (const [, entry] of Object.entries(files)) {
    if (entry && entry.files && entry.files['@deepseek-ai']) return ''
  }
  return null
}

function openAsarShallow(asarPath) {
  try {
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
      return header && header.files ? header : null
    } finally {
      try { io.closeSync(fd) } catch { /* 关闭失败不阻断 */ }
    }
  } catch {
    return null
  }
}

export function detectHostVersion(info = findHostInfo()) {
  const readPkgJson = (relPath) => {
    let raw = null
    if (info.kind === 'extracted' && info.root) {
      raw = readText(path.join(info.root, ...relPath.split('/')))
    } else if (info.kind === 'asar' && info.asar) {
      raw = readAsarEntryText(info.asar, relPath)
    }
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  const inner = info.innerRoot === undefined || info.innerRoot === null ? 'dsh' : info.innerRoot
  const prefix = inner ? inner + '/node_modules/@deepseek-ai/dsh/package.json' : 'node_modules/@deepseek-ai/dsh/package.json'

  const candidates = [
    prefix,
    'node_modules/@deepseek-ai/dsh/package.json',
    inner ? inner + '/package.json' : 'package.json',
    'package.json',
  ]

  for (const rel of candidates) {
    const parsed = readPkgJson(rel)
    if (parsed && typeof parsed.version === 'string') return parsed.version
  }

  return null
}

let asarModuleCache = null

function asarModule() {
  if (asarModuleCache !== null) return asarModuleCache
  try {
    asarModuleCache = require_('./asar.js')
  } catch {
    asarModuleCache = false
  }
  return asarModuleCache || null
}

function readAsarEntryText(asarPath, relPath) {
  const mod = asarModule()
  if (!mod || typeof mod.openAsar !== 'function') return null
  const archive = mod.openAsar(asarPath)
  if (!archive) return null
  try {
    return archive.readText(relPath)
  } finally {
    archive.close()
  }
}

export function findHostRoot(options = {}) {
  const info = findHostInfo(options)
  return info.kind === 'extracted' ? info.root : null
}

export function hostAsarPath() {
  const info = findHostInfo()
  return info.kind === 'asar' ? info.asar : null
}
