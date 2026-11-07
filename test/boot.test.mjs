import test from 'node:test'
import assert from 'node:assert/strict'

const boot = await import('../lib/core/boot.js')
const extract = await import('../lib/core/extract.js')

test('describeBootPlan always returns a usable plan', () => {
  const plan = boot.describeBootPlan()
  assert.ok(['none', 'extract'].includes(plan.action), plan.action)
  assert.ok(['ready', 'needs-extract', 'blocked'].includes(plan.phase), plan.phase)
  assert.equal(typeof plan.summary, 'string')
  assert.ok(plan.summary.length > 0)
})

test('a ready plan reports patch summary and needs no extraction', () => {
  const plan = boot.describeBootPlan()
  if (plan.phase !== 'ready') return
  assert.equal(plan.action, 'none')
  assert.ok(plan.patches)
  assert.equal(typeof plan.patches.total, 'number')
})

test('an extract plan carries a preview with target and size', () => {
  const plan = boot.describeBootPlan()
  if (plan.action !== 'extract') return
  assert.ok(plan.preview)
  assert.equal(typeof plan.preview.files, 'number')
  assert.ok(plan.targetDir)
})

test('describeBootPlan stays consistent with checkExtracted', () => {
  const plan = boot.describeBootPlan()
  const check = extract.checkExtracted()
  if (check.ok) assert.equal(plan.phase, 'ready')
  if (check.needsExtract) assert.equal(plan.action, 'extract')
})

test('readBootLog returns a stable shape', () => {
  const log = boot.readBootLog()
  assert.match(log.stateFile, /boot\.json$/)
  assert.ok(Array.isArray(log.attempts))
  assert.equal(typeof log.schema, 'number')
})

test('runBootPipeline is idempotent once bootstrapped for the same asar', () => {
  const check = extract.checkExtracted()
  if (!check.ok) return
  boot.resetBootState()
  const first = boot.runBootPipeline()
  assert.equal(first.ok, true)
  const second = boot.runBootPipeline()
  assert.equal(second.ok, true)
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'already-bootstrapped-for-this-asar')
})

test('resetBootState clears the recorded attempt history', () => {
  const before = boot.readBootLog()
  boot.resetBootState()
  const after = boot.readBootLog()
  assert.equal(after.attempts.length, 0)
  assert.equal(after.lastOutcome, null)
  assert.equal(after.lastAsar, null)
  assert.equal(typeof before.attempts, 'object')
})
