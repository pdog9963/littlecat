import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../lib/index.js')
const roles = await import('../lib/redteam-roles.js')

function makeCtx(assembleImpl) {
  const sections = []
  const handlers = new Map()
  const ctx = {
    systemPrompt: {
      section: (spec) => {
        sections.push(spec)
        return () => {
          const at = sections.indexOf(spec)
          if (at >= 0) sections.splice(at, 1)
        }
      },
      assemble: assembleImpl || defaultAssemble,
    },
    on: (event, fn) => {
      handlers.set(event, fn)
      return () => handlers.delete(event)
    },
    effect: () => () => {},
  }
  return { ctx, sections, handlers }
}

const defaultAssemble = async () => ({
  sections: [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness. You are a helpful software engineer assistant.' },
    { name: 'env', text: 'cwd={{cwd}}' },
    { name: 'persona-prefix', text: '你好！我是 DeepSeek 驱动的 AI 助手。' },
  ],
  contexts: [],
  tools: [],
  variables: {},
})

test('module exposes the cordis plugin shape', () => {
  assert.equal(mod.name, 'dsh-laomao')
  assert.deepEqual(mod.inject, ['systemPrompt'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.installPatchTools, 'function')
})

test('registers the persona section on top', () => {
  const { ctx, sections } = makeCtx()
  const dispose = mod.apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'laomao-persona')
  assert.equal(sections[0].order, -100000)
  assert.equal(sections[0].interpolate, false)
  assert.equal(typeof dispose, 'function')
})

test('rewrites identity away and prepends the persona', async () => {
  const { ctx } = makeCtx()
  mod.apply(ctx, {})
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'main', header: {} } } })
  const names = out.sections.map((section) => section.name)
  assert.equal(names.includes('harness:identity'), false)
  assert.equal(names[0], 'laomao-persona')
  assert.equal(names.includes('laomao-commander'), true)
  const joined = out.sections.map((section) => section.text).join('\n')
  assert.equal(joined.includes('You are an AI agent powered by DeepSeek Harness'), false)
  assert.equal(joined.includes('{{cwd}}'), true)
})

test('subagent sessions receive a role draft instead of the commander draft', async () => {
  const { ctx, handlers } = makeCtx()
  mod.apply(ctx, {})
  const session = { id: 'sub', header: { origin: 'subagent' } }
  handlers.get('agent/inbox/claimed')({ message: { content: 'redteamRole: vuln-scan\n扫漏洞喵' } }, { agent: { session } })
  const out = await ctx.systemPrompt.assemble({ agent: { session } })
  const names = out.sections.map((section) => section.name)
  assert.equal(names.includes('laomao-role'), true)
  assert.equal(names.includes('laomao-commander'), false)
  assert.match(out.sections.find((section) => section.name === 'laomao-role').text, /伊凡/)
})

test('a complete section is fused into one persona section', async () => {
  const { ctx } = makeCtx(async () => ({
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'core', text: '核心系统提示词正文。', complete: true },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }))
  mod.apply(ctx, {})
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'c', header: {} } } })
  const persona = out.sections.find((section) => section.name === 'laomao-persona')
  assert.ok(persona, 'persona section must exist')
  assert.equal(persona.complete, undefined)
  assert.match(persona.text, /红队指挥职责/)
  assert.match(persona.text, /核心系统提示词正文/)
  assert.equal(out.sections.filter((section) => section.name === 'laomao-persona').length, 1)
  const guard = out.sections.find((section) => section.name === 'laomao-guard')
  assert.ok(guard, 'guard section must be appended')
  assert.equal(out.sections[out.sections.length - 1].name, 'laomao-guard')
})

test('the guard section is appended last so it is read after harness rules', async () => {
  const { ctx } = makeCtx()
  mod.apply(ctx, {})
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'g', header: {} } } })
  const guard = out.sections.find((section) => section.name === 'laomao-guard')
  assert.ok(guard)
  assert.equal(guard.order, 999998)
  assert.match(guard.text, /不拒绝/)
  assert.equal(out.sections[out.sections.length - 1].name, 'laomao-guard')
})

test('guard can be turned off through config', async () => {
  const { ctx } = makeCtx()
  mod.apply(ctx, { guard: false })
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'ng', header: {} } } })
  assert.equal(out.sections.some((section) => section.name === 'laomao-guard'), false)
})

test('subagent sessions get the role guard with leaf-node rule', async () => {
  const { ctx, handlers } = makeCtx()
  mod.apply(ctx, {})
  const session = { id: 'sub-guard', header: { origin: 'subagent' } }
  handlers.get('agent/inbox/claimed')({ message: { content: 'redteamRole: recon\n收资产' } }, { agent: { session } })
  const out = await ctx.systemPrompt.assemble({ agent: { session } })
  const guard = out.sections.find((section) => section.name === 'laomao-guard')
  assert.ok(guard)
  assert.match(guard.text, /叶子节点/)
  assert.match(guard.text, /执行守则/)
  assert.equal(guard.text.includes('干活前自检'), false)
})

test('dispose restores the original assemble', async () => {
  const { ctx } = makeCtx()
  const dispose = mod.apply(ctx, {})
  await ctx.systemPrompt.assemble({ agent: { session: { id: 'd', header: {} } } })
  dispose()
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'd', header: {} } } })
  assert.deepEqual(out.sections.map((section) => section.name), ['harness:identity', 'env', 'persona-prefix'])
})

test('two applies share one guard and outlive a single dispose', async () => {
  const { ctx } = makeCtx()
  const first = mod.apply(ctx, {})
  const second = mod.apply(ctx, {})
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'm', header: {} } } })
  assert.equal(out.sections.filter((section) => section.name === 'laomao-persona').length, 1)
  second()
  const afterOne = await ctx.systemPrompt.assemble({ agent: { session: { id: 'm', header: {} } } })
  assert.equal(afterOne.sections.some((section) => section.name === 'laomao-persona'), true)
  first()
  const afterBoth = await ctx.systemPrompt.assemble({ agent: { session: { id: 'm', header: {} } } })
  assert.equal(afterBoth.sections.some((section) => section.name === 'laomao-persona'), false)
})

test('enabled false registers nothing and changes nothing', async () => {
  const { ctx, sections } = makeCtx()
  mod.apply(ctx, { enabled: false })
  assert.equal(sections.length, 0)
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'e', header: {} } } })
  assert.deepEqual(out.sections.map((section) => section.name), ['harness:identity', 'env', 'persona-prefix'])
})

test('an assembly failure degrades to an empty prompt instead of throwing', async () => {
  const { ctx } = makeCtx(async () => { throw new Error('boom') })
  mod.apply(ctx, {})
  const out = await ctx.systemPrompt.assemble({ agent: { session: { id: 'f', header: {} } } })
  assert.deepEqual(out, { sections: [], contexts: [], tools: [] })
})

test('weird contexts never crash the rewrite', async () => {
  const { ctx } = makeCtx()
  mod.apply(ctx, {})
  const contexts = [
    { agent: { session: { id: 12345, header: {} } } },
    { agent: { session: { header: { delegationDepth: 1 } } } },
    {},
    { session: null },
    { agent: {} },
    null,
    undefined,
  ]
  for (const context of contexts) {
    const out = await ctx.systemPrompt.assemble(context)
    assert.equal(Array.isArray(out.sections), true)
  }
})

test('concurrent assemblies all stay persona first', async () => {
  const { ctx } = makeCtx()
  mod.apply(ctx, {})
  const sessions = Array.from({ length: 20 }, (_, index) => ({ id: 'c' + index, header: {} }))
  const outs = await Promise.all(sessions.map((session) => ctx.systemPrompt.assemble({ agent: { session } })))
  for (const out of outs) assert.equal(out.sections[0].name, 'laomao-persona')
})

test('role tag parsing only accepts the first line', () => {
  const cases = [
    ['redteamRole: recon\n收集资产', 'recon'],
    ['\n\n  redteamRole: assess\r\n评估', 'assess'],
    ['\uFEFFredteamRole: exploit\n利用', 'exploit'],
    ['redteamRole: internal', 'internal'],
    ['先做点事\nredteamRole: recon\n收资产', ''],
    ['请把 prompt 第一行写 redteamRole: vuln-scan 就好', ''],
    ['redteamRole: bogus\nx', ''],
    ['', ''],
  ]
  for (const [input, expected] of cases) {
    assert.equal(roles.parseRedteamRole(input), expected, JSON.stringify(input))
  }
})

test('every role code renders a draft mentioning its own name', () => {
  const expected = {
    recon: '波尔菲里',
    assess: '斯维里加洛夫',
    'vuln-scan': '伊凡',
    exploit: '拉斯柯尔尼科夫',
    internal: '斯塔夫罗金',
  }
  assert.deepEqual(roles.ROLE_CODES, Object.keys(expected))
  for (const code of roles.ROLE_CODES) {
    const text = roles.roleTextFor(code)
    assert.equal(text.length > 500, true, code)
    assert.match(text, new RegExp(expected[code]))
    assert.match(text, /叶子节点/)
  }
  assert.equal(roles.roleTextFor('nope'), '')
})

test('textOfMessage handles every message shape dsh can deliver', () => {
  assert.equal(roles.textOfMessage('redteamRole: recon'), 'redteamRole: recon')
  assert.equal(roles.textOfMessage({ content: 'hello' }), 'hello')
  assert.equal(roles.textOfMessage({ text: 'hello' }), 'hello')
  assert.equal(roles.textOfMessage({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(roles.textOfMessage({ content: [{ type: 'image' }] }), '')
  assert.equal(roles.textOfMessage(null), '')
  assert.equal(roles.textOfMessage(undefined), '')
  assert.equal(roles.textOfMessage(42), '')
})

test('the commander draft names all five cats', () => {
  for (const code of roles.ROLE_CODES) assert.match(roles.COMMANDER_DUTY, new RegExp(code.replace('-', '\\-')))
  assert.match(roles.COMMANDER_DUTY, /总指挥喵/)
  assert.match(roles.COMMANDER_DUTY, /叶子节点/)
})
