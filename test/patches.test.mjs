import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const patches = await import('../lib/core/patches.js')
const asar = await import('../lib/core/asar.js')
const extract = await import('../lib/core/extract.js')
const hostPath = await import('../lib/core/host-path.js')
const guard = await import('../lib/core/guard.js')

test('patch table exposes every entry with an id, name and layer', () => {
  const list = patches.patchList()
  assert.ok(list.length >= 3, 'at least the three verified patches')
  const ids = new Set()
  for (const item of list) {
    assert.equal(typeof item.id, 'number')
    assert.equal(typeof item.name, 'string')
    assert.ok(item.name.length > 0)
    assert.ok(['prompt', 'code', 'tool'].includes(item.layer), item.layer)
    assert.equal(ids.has(item.id), false, 'duplicate id ' + item.id)
    ids.add(item.id)
  }
})

test('guard section carries the no-refusal rules', () => {
  assert.match(guard.GUARD_TEXT, /不拒绝/)
  assert.match(guard.GUARD_TEXT, /免责声明/)
  assert.match(guard.GUARD_TEXT, /老师/)
  assert.equal(guard.GUARD_ORDER, 999998)
  assert.equal(guard.GUARD_SECTION_NAME, 'laomao-guard')
  assert.match(guard.guardTextFor('role'), /叶子节点/)
  assert.match(guard.guardTextFor('role'), /执行守则/)
  assert.match(guard.commanderExtraFor('commander'), /干活前自检/)
  assert.equal(guard.commanderExtraFor('role'), '')
})

test('host discovery always returns a usable shape', () => {
  const info = hostPath.findHostInfo()
  assert.ok(['extracted', 'asar', 'none'].includes(info.kind))
  if (info.kind === 'asar') assert.equal(hostPath.isFile(info.asar), true)
  if (info.kind === 'extracted') assert.equal(hostPath.isDir(info.root), true)
  assert.match(hostPath.findDshHome(), /\.dsh$/)
  assert.match(hostPath.laomaoStateDir(), /dsh-laomao$/)
})

test('probe reports a state for every patch and never throws', () => {
  const report = patches.probe()
  assert.equal(report.patches.length, patches.patchList().length)
  for (const item of report.patches) {
    assert.ok(['applied', 'pending', 'skipped', 'failed'].includes(item.state), item.name + ' -> ' + item.state)
  }
  const total = report.summary.applied + report.summary.pending + report.summary.skipped + report.summary.failed
  assert.equal(total, report.summary.total)
})

test('statusReport includes the state file path and backup count', () => {
  const report = patches.statusReport()
  assert.match(report.stateFile, /patches\.json$/)
  assert.equal(typeof report.lastApplied, 'number')
  assert.equal(typeof report.backups, 'number')
})

test('asar reader opens a synthetic archive and reads its entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laomao-asar-'))
  const target = path.join(dir, 'app.asar')
  const files = {
    'placeholder.txt': Buffer.from('placeholder'),
  }
  const payload = JSON.stringify({ files: {} })
  const payloadBuf = Buffer.from(payload, 'utf8')
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(payloadBuf.length + 8, 4)
  head.writeUInt32LE(payloadBuf.length + 4, 8)
  head.writeUInt32LE(payloadBuf.length, 12)
  const written = Buffer.concat([head, payloadBuf])
  fs.writeFileSync(target, written)
  const opened = asar.openAsar(target)
  assert.ok(opened, 'archive should open')
  assert.deepEqual(opened.list(''), [])
  opened.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('openAsar returns null for a missing or malformed file', () => {
  assert.equal(asar.openAsar(path.join(os.tmpdir(), 'definitely-missing-dsh-archive.asar')), null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laomao-bad-'))
  const bad = path.join(dir, 'bad.asar')
  fs.writeFileSync(bad, 'not an archive')
  assert.equal(asar.openAsar(bad), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readAsarHeader rejects absurd header sizes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laomao-huge-'))
  const fp = path.join(dir, 'huge.asar')
  const head = Buffer.alloc(32)
  head.writeUInt32LE(0x7fffffff, 12)
  fs.writeFileSync(fp, head)
  assert.equal(asar.readAsarHeader(fp), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('revertPatches is safe when nothing was applied', () => {
  const result = patches.revertPatches()
  assert.equal(typeof result.summary.reverted, 'number')
  assert.equal(result.restartRequired, result.summary.reverted > 0)
})

test('probe reports the detected host version', () => {
  const report = patches.probe()
  assert.ok('hostVersion' in report)
  assert.ok('hostKind' in report)
  assert.ok(['extracted', 'asar', 'none'].includes(report.hostKind))
  if (report.hostKind === 'asar') assert.equal(report.innerRoot !== undefined, true)
  if (report.hostVersion !== null) assert.match(report.hostVersion, /^\d+\.\d+/)
})

test('pattern matching tolerates re-quoted and re-wrapped source across versions', () => {
  const exact = `const X = "hello world example sentence"`
  const caseA = `const X = 'hello world example sentence'`
  const caseB = `const X =\n  "hello world example sentence"`
  const caseC = `const X = "hello   world   example   sentence"`
  const pattern = `const X = "hello world example sentence"`
  for (const [label, text] of [['exact', exact], ['requoted', caseA], ['linewrap', caseB], ['spacing', caseC]]) {
    const result = patches.probePattern(text, pattern, 'REPLACED')
    assert.equal(result.hit, true, label + ' should hit, mode=' + result.mode)
    assert.equal(result.text.includes('REPLACED'), true, label + ' should be replaced')
  }
})

test('pattern matching refuses to touch unrelated text', () => {
  const result = patches.probePattern('completely unrelated content here', 'const X = "a b c"', 'REPLACED')
  assert.equal(result.hit, false)
  assert.equal(result.text, 'completely unrelated content here')
})

test('marker detection accepts both strings and regular expressions', () => {
  assert.equal(patches.probeMarker('abc marker xyz', ['marker']), true)
  assert.equal(patches.probeMarker('abc marker xyz', [/marker\s+xyz/]), true)
  assert.equal(patches.probeMarker('abc', ['nope']), false)
  assert.equal(patches.probeMarker('', ['marker']), false)
})

test('skeleton comparison ignores quotes and concatenation glue', () => {
  const a = patches.probeSkeleton('const A = "one two" + "three four"')
  const b = patches.probeSkeleton("const A = 'one two' + 'three four'")
  assert.equal(a, b)
})

test('extract module reports the real extraction state', () => {
  const check = extract.checkExtracted()
  assert.ok(['extracted', 'not-extracted', 'incomplete', 'no-host'].includes(check.reason), check.reason)
  assert.equal(typeof check.ok, 'boolean')
  if (check.ok) {
    assert.ok(check.appDir)
    assert.equal(check.reason, 'extracted')
  } else {
    assert.equal(typeof check.hint, 'string')
  }
})

test('extract refuses to act without explicit confirmation', () => {
  const result = extract.extractHost(undefined, {})
  assert.equal(result.ok, false)
  assert.ok(['needs-confirmation', 'not-needed'].includes(result.reason), result.reason)
})

test('remove refuses to run without confirmation', () => {
  const result = extract.removeExtracted({})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs-confirmation')
})

test('layout resolution always yields absolute paths when a host exists', () => {
  const layout = extract.resolveTargetAppDir()
  if (layout === null) return
  assert.ok(path.isAbsolute(layout.appDir), layout.appDir)
  assert.ok(path.isAbsolute(layout.resourcesDir), layout.resourcesDir)
})
