import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { installPatchTools } from '../lib/index.js'

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINT_KEYS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

function assertSupportedJsonSchema(schema) {
  const violations = []
  const walk = (node, trail) => {
    if (node === null || node === undefined) return
    if (typeof node !== 'object') {
      violations.push(`${trail} is not a schema object`)
      return
    }
    if (Array.isArray(node)) {
      violations.push(`${trail} is an array, expected a schema object`)
      return
    }
    if (node.type !== undefined) {
      if (Array.isArray(node.type)) {
        violations.push(`${trail}.type must be a single type string (type arrays are not supported)`)
        return
      }
      if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
        violations.push(`${trail}.type must be one of ${SCHEMA_TYPES.join('/')}`)
        return
      }
    }
    for (const key of Object.keys(node)) {
      if (!CONSTRAINT_KEYS.includes(key) && !ANNOTATION_KEYS.includes(key)) {
        violations.push(`${trail}.${key} is not a supported keyword`)
      }
    }
    if (node.properties !== undefined) {
      if (typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        violations.push(`${trail}.properties must be an object`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          walk(child, `${trail}.properties.${key}`)
        }
      }
    }
    if (node.items !== undefined) walk(node.items, `${trail}.items`)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, index) => walk(child, `${trail}.oneOf[${index}]`))
  }
  walk(schema, 'schema')
  if (violations.length > 0) throw new Error('unsupported JSON schema: ' + violations.join('; '))
}

function collectToolSpecs() {
  const collected = []
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (spec) => collected.push(spec) } : null),
  }
  installPatchTools(ctx, {})
  return collected
}

function findHostToolSource() {
  const candidates = [
    'C:/Users/1145/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    '/opt/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    path.join(process.env.DSH_INSTALL_ROOT || '', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ]
  for (const fp of candidates) {
    if (fp && fs.existsSync(fp)) return fp
  }
  return null
}

test('host schema contract is mirrored from the real dsh implementation', () => {
  const source = findHostToolSource()
  if (!source) {
    console.log('  宿主源码不可用，仅使用内建镜像校验器')
    return
  }
  const src = fs.readFileSync(source, 'utf8')
  const typesAt = src.indexOf('const SCHEMA_TYPES = [')
  assert.ok(typesAt >= 0, 'host must declare SCHEMA_TYPES')
  const typesEnd = src.indexOf('];', typesAt)
  const hostTypes = src
    .slice(typesAt, typesEnd)
    .split('\n')
    .map((line) => line.trim().replace(/^"|",?$/g, '').replace(/^'|',?$/g, ''))
    .filter((line) => line && !line.startsWith('const') && !line.startsWith(']'))
  console.log('  宿主允许的类型:', hostTypes.join(' / '))
  assert.deepEqual(hostTypes, SCHEMA_TYPES, '内建镜像必须与宿主 SCHEMA_TYPES 完全一致')
})

test('every tool spec passes JSON-schema validation', () => {
  const specs = collectToolSpecs()
  assert.equal(specs.length, 4, 'expected four laomao tools')
  for (const spec of specs) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(spec.parameters), `${spec.name}.parameters`)
    assert.ok(spec.output && typeof spec.output === 'object', `${spec.name}.output`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(spec.output.schema), `${spec.name}.output.schema`)
  }
})

test('output schemas never declare an unsupported "json" type', () => {
  for (const spec of collectToolSpecs()) {
    const dump = JSON.stringify(spec.output.schema)
    assert.equal(dump.includes('"json"'), false, `${spec.name} output schema must not use type "json"`)
  }
})

test('every tool declares output.render as a function', () => {
  for (const spec of collectToolSpecs()) {
    assert.equal(typeof spec.output.render, 'function', `${spec.name}.output.render`)
  }
})

test('tool names are unique and snake_case with the laomao prefix', () => {
  const names = collectToolSpecs().map((spec) => spec.name)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const name of names) assert.match(name, /^laomao_[a-z_]+$/)
})

test('render() returns a text block array for a representative value', () => {
  for (const spec of collectToolSpecs()) {
    const blocks = spec.output.render({}, { summary: 'x', details: ['a', 'b'] })
    assert.ok(Array.isArray(blocks), `${spec.name} render must return an array`)
    assert.ok(blocks.length > 0, `${spec.name} render must not be empty`)
    assert.equal(blocks[0].type, 'text', `${spec.name} render first block must be text`)
    assert.equal(typeof blocks[0].text, 'string', `${spec.name} render text must be a string`)
  }
})

test('render() tolerates an empty or partial value without throwing', () => {
  const values = [{}, { summary: 'only summary' }, { details: ['only details'] }, null, undefined]
  for (const value of values) {
    for (const spec of collectToolSpecs()) {
      assert.doesNotThrow(() => spec.output.render({}, value), `${spec.name} render`)
    }
  }
})

test('the validator rejects type "json", proving the check has teeth', () => {
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'object', properties: { data: { type: 'json' } } }),
    /json|one of|unsupported/i,
  )
})

test('the validator rejects type arrays and unknown keywords', () => {
  assert.throws(
    () => assertSupportedJsonSchema({ type: ['object', 'string'] }),
    /type arrays are not supported/i,
  )
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'object', patternProperties: {} }),
    /not a supported keyword/i,
  )
})

test('a valid object schema passes cleanly', () => {
  assert.doesNotThrow(() =>
    assertSupportedJsonSchema({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        details: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'details'],
      additionalProperties: false,
    }),
  )
})
