import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import {
  BOOTSTRAP_SOURCE_KIND,
  createBootstrapListener,
  isRootAgent,
  visibleBootstrapDigest,
  type BootstrapListenerOptions,
  type BootstrapPreStepListener,
  type SuperpowersBootstrapSource,
} from '../src/injection.js'
import { clearBootstrapCache } from '../src/bootstrap.js'
import { apply, inject, name } from '../src/index.js'

const tempDirs: string[] = []

afterEach(() => {
  clearBootstrapCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Write a tree of fixture files under a fresh temp directory. */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superpowers-injection-'))
  tempDirs.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

interface FakeSession {
  readonly session: Session
  readonly state: { messages: Message[]; reads: number }
}

/** Build a fake session whose derived history the test can mutate between steps. */
function makeSession(options: { delegationDepth?: number; visible?: Message[] } = {}): FakeSession {
  const state = { messages: [...options.visible ?? []], reads: 0 }
  const header = options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }
  const session = {
    header,
    deriveMessages: () => {
      state.reads += 1
      return state.messages
    },
  } as unknown as Session
  return { session, state }
}

/** Build a fake live agent backed by the given session. */
function makeAgent(session: Session, options: { subagentDepth?: number } = {}): Agent {
  const agentOptions = options.subagentDepth === undefined ? {} : { subagentDepth: options.subagentDepth }
  return { session, options: agentOptions } as unknown as Agent
}

/** Build an `enter` pre-step decision with the given messages. */
function enter(messages: UserMessage[] = []): PreStepDecision {
  return { kind: 'enter', messages: [...messages] }
}

/** Build the bootstrap listener under test with overridable options. */
function makeListener(overrides: Partial<BootstrapListenerOptions> = {}): BootstrapPreStepListener {
  return createBootstrapListener({
    bootstrapText: 'BOOTSTRAP TEXT',
    digest: 'current-digest',
    version: '7.0.1',
    ...overrides,
  })
}

function abortSignal(): AbortSignal {
  return new AbortController().signal
}

function prompt(text = 'hello'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function ownBootstrap(digest: string, text = 'BOOTSTRAP TEXT'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: BOOTSTRAP_SOURCE_KIND, form: 'instructions', digest, upstreamVersion: '7.0.1' },
  })
}

function messageWithSource(text: string, sourceKind: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    // Test-only arbitrary source kinds (for example `compact-checkpoint` from
    // dsh-compaction, which is not a dependency of this package).
    source: { kind: sourceKind } as never,
  })
}

function foreignBootstrap(sourceKind = 'hooks-claude-code'): UserMessage {
  return messageWithSource(
    '<EXTREMELY_IMPORTANT>\nYou have superpowers.\n</EXTREMELY_IMPORTANT>',
    sourceKind,
  )
}

function ownSource(message: UserMessage): SuperpowersBootstrapSource {
  return message.source as SuperpowersBootstrapSource
}

describe('createBootstrapListener', () => {
  it('injects exactly one bootstrap message at the front of the first step', async () => {
    const { session } = makeSession()
    const agent = makeAgent(session)
    const userPrompt = prompt()
    const laterInjection = prompt('another injected message')

    const result = await makeListener()(
      { agent, signal: abortSignal() },
      async () => enter([userPrompt, laterInjection]),
    )

    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]!.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
    expect(ownSource(result.messages[0]!)).toEqual({
      kind: BOOTSTRAP_SOURCE_KIND,
      form: 'instructions',
      digest: 'current-digest',
      upstreamVersion: '7.0.1',
    })
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'BOOTSTRAP TEXT' }])
    expect(result.messages[1]).toBe(userPrompt)
    expect(result.messages[2]).toBe(laterInjection)
  })

  it('does not inject again once the bootstrap is visible in derived history', async () => {
    const { session, state } = makeSession()
    const agent = makeAgent(session)
    const listener = makeListener()

    const first = await listener({ agent, signal: abortSignal() }, async () => enter([prompt('first')]))
    if (first.kind !== 'enter') throw new Error('expected an enter decision')
    state.messages.push(first.messages[0]!)

    const userPrompt = prompt('second')
    const second = await listener({ agent, signal: abortSignal() }, async () => enter([userPrompt]))

    if (second.kind !== 'enter') throw new Error('expected an enter decision')
    expect(second.messages).toEqual([userPrompt])
  })

  it('re-injects after compaction clears the visible history', async () => {
    const { session, state } = makeSession()
    const agent = makeAgent(session)
    const listener = makeListener()

    const first = await listener({ agent, signal: abortSignal() }, async () => enter([prompt()]))
    if (first.kind !== 'enter') throw new Error('expected an enter decision')

    // Compaction replaces the shadowed nodes: derived history no longer shows it.
    state.messages = []

    const result = await listener({ agent, signal: abortSignal() }, async () => enter([prompt('after compaction')]))
    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
  })

  it('skips subagent sessions regardless of which depth source reports them', async () => {
    for (const build of [
      () => makeAgent(makeSession({ delegationDepth: 1 }).session),
      () => makeAgent(makeSession({ delegationDepth: 0 }).session, { subagentDepth: 2 }),
      () => makeAgent(makeSession({ delegationDepth: 2 }).session, { subagentDepth: 1 }),
    ]) {
      const agent = build()
      const decision = enter([prompt()])
      const result = await makeListener()({ agent, signal: abortSignal() }, async () => decision)
      expect(result).toBe(decision)
    }
  })

  it('injects for a root agent when both depth sources are absent or zero', async () => {
    for (const agent of [
      makeAgent(makeSession().session),
      makeAgent(makeSession({ delegationDepth: 0 }).session, { subagentDepth: 0 }),
    ]) {
      const decision = enter([prompt()])
      const result = await makeListener()({ agent, signal: abortSignal() }, async () => decision)
      if (result.kind !== 'enter') throw new Error('expected an enter decision')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0]!.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
    }
  })

  it('does not inject when this step already carries a foreign bootstrap marker', async () => {
    const { session } = makeSession()
    const decision = enter([prompt(), foreignBootstrap()])
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)
    expect(result).toBe(decision)
  })

  it('does not inject when this step already carries its own current bootstrap', async () => {
    const { session } = makeSession()
    const decision = enter([prompt(), ownBootstrap('current-digest')])
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)
    expect(result).toBe(decision)
  })

  it('replaces its own stale bootstrap in place instead of prepending a second one', async () => {
    const { session } = makeSession()
    const stale = ownBootstrap('old-digest', 'OLD BOOTSTRAP')
    const userPrompt = prompt()

    const result = await makeListener()(
      { agent: makeAgent(session), signal: abortSignal() },
      async () => enter([userPrompt, stale]),
    )

    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toBe(userPrompt)
    expect(ownSource(result.messages[1]!).digest).toBe('current-digest')
    expect(result.messages[1]!.content).toEqual([{ type: 'text', text: 'BOOTSTRAP TEXT' }])
  })

  it('removes its own stale bootstrap from the batch when history already shows the current one', async () => {
    const stale = ownBootstrap('old-digest', 'OLD BOOTSTRAP')
    const visible = ownBootstrap('current-digest')
    const { session } = makeSession({ visible: [prompt(), visible] })
    const userPrompt = prompt()

    const result = await makeListener()(
      { agent: makeAgent(session), signal: abortSignal() },
      async () => enter([userPrompt, stale]),
    )

    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    expect(result.messages).toEqual([userPrompt])
  })

  it('does not inject when history already shows the current digest', async () => {
    const { session } = makeSession({ visible: [prompt(), ownBootstrap('current-digest')] })
    const decision = enter([prompt('next')])
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)
    expect(result).toBe(decision)
  })

  it('does not inject a new version into a session that already saw a different one', async () => {
    const { session } = makeSession({ visible: [prompt(), ownBootstrap('older-digest')] })
    const decision = enter([prompt('next')])
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)
    expect(result).toBe(decision)
  })

  it('does not inject when a hook-bridge bootstrap is visible, and scans its text once per session', async () => {
    const { session, state } = makeSession({ visible: [prompt(), foreignBootstrap('hooks-claude-code')] })
    const agent = makeAgent(session)
    const listener = makeListener()

    const firstDecision = enter([prompt('first')])
    expect(await listener({ agent, signal: abortSignal() }, async () => firstDecision)).toBe(firstDecision)
    expect(state.reads).toBe(2) // one own-history scan + one foreign-marker scan

    const secondDecision = enter([prompt('second')])
    expect(await listener({ agent, signal: abortSignal() }, async () => secondDecision)).toBe(secondDecision)
    expect(state.reads).toBe(3) // own-history scan only; the foreign probe is cached
  })

  it('still republishes after compaction when the summary quotes the bootstrap marker', async () => {
    // A compaction summary is user-role `compact-checkpoint` context whose text
    // may quote the replaced history, including the bootstrap markers. It must
    // never be mistaken for a foreign bootstrap: the shadowed bootstrap node is
    // exactly what needs republishing.
    const summary = messageWithSource(
      '<EXTREMELY_IMPORTANT>\nYou have superpowers.\nEarlier the session used skills.',
      'compact-checkpoint',
    )
    const { session } = makeSession({ visible: [summary] })
    const decision = enter([prompt('after compaction')])

    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)

    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
  })

  it('ignores marker text quoted by other framework producers', async () => {
    for (const sourceKind of ['compact-checkpoint', 'runtime-context', 'system-prompt']) {
      const quoted = messageWithSource('<EXTREMELY_IMPORTANT>\nYou have superpowers.\n', sourceKind)
      const { session } = makeSession({ visible: [prompt(), quoted] })
      const decision = enter([prompt('next')])
      const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)

      if (result.kind !== 'enter') throw new Error('expected an enter decision')
      expect(result.messages[0]!.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
    }
  })

  it('honours a user-sourced foreign bootstrap visible in history', async () => {
    const { session } = makeSession({ visible: [prompt(), foreignBootstrap('user')] })
    const decision = enter([prompt('next')])
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)
    expect(result).toBe(decision)
  })

  it('does not treat an unrelated hook-bridge message as a bootstrap', async () => {
    const unrelated = messageWithSource('Hook context: no bootstrap marker here.', 'hooks-claude-code')
    const { session } = makeSession({ visible: [prompt(), unrelated] })
    const decision = enter([prompt('next')])
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)

    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    expect(result.messages[0]!.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
  })

  it('returns reject decisions untouched', async () => {
    const { session, state } = makeSession()
    const decision: PreStepDecision = { kind: 'reject' }
    const result = await makeListener()({ agent: makeAgent(session), signal: abortSignal() }, async () => decision)
    expect(result).toBe(decision)
    expect(state.reads).toBe(0)
  })

  it('propagates turn cancellation', async () => {
    const { session } = makeSession()
    const controller = new AbortController()
    const reason = new Error('turn cancelled')
    controller.abort(reason)

    await expect(makeListener()(
      { agent: makeAgent(session), signal: controller.signal },
      async () => enter([prompt()]),
    )).rejects.toBe(reason)
  })

  it('is inert when disabled, even for a first step of a root session', async () => {
    const { session, state } = makeSession()
    const decision = enter([prompt()])
    const result = await makeListener({ disable: true })(
      { agent: makeAgent(session), signal: abortSignal() },
      async () => decision,
    )
    expect(result).toBe(decision)
    expect(state.reads).toBe(0)
  })
})

describe('isRootAgent', () => {
  it('treats missing and zero depths as root and any positive depth as a subagent', () => {
    expect(isRootAgent(makeAgent(makeSession().session))).toBe(true)
    expect(isRootAgent(makeAgent(makeSession({ delegationDepth: 0 }).session))).toBe(true)
    expect(isRootAgent(makeAgent(makeSession({ delegationDepth: 1 }).session))).toBe(false)
    expect(isRootAgent(makeAgent(makeSession().session, { subagentDepth: 1 }))).toBe(false)
    expect(isRootAgent(makeAgent(makeSession({ delegationDepth: 1 }).session, { subagentDepth: 0 }))).toBe(false)
  })
})

describe('visibleBootstrapDigest', () => {
  it('returns null when no own bootstrap is visible', () => {
    expect(visibleBootstrapDigest(makeSession({ visible: [prompt()] }).session)).toBeNull()
  })

  it('returns the newest visible own digest', () => {
    const session = makeSession({ visible: [ownBootstrap('first'), prompt(), ownBootstrap('second')] }).session
    expect(visibleBootstrapDigest(session)).toBe('second')
  })

  it('treats an unreadable digest on a visible own message as unknown', () => {
    const broken = createUserMessage({
      content: [{ type: 'text', text: 'bootstrap without digest' }],
      source: { kind: BOOTSTRAP_SOURCE_KIND, form: 'instructions', digest: 7 as unknown as string, upstreamVersion: '7.0.1' },
    })
    expect(visibleBootstrapDigest(makeSession({ visible: [prompt(), broken] }).session)).toBeNull()
  })
})

interface PluginContextFixture {
  readonly ctx: Context
  readonly skills: SkillRegistration[]
  readonly warnings: string[]
  readonly listeners: BootstrapPreStepListener[]
}

/** Build the narrow context services `apply()` touches. */
function fakePluginContext(): PluginContextFixture {
  const skills: SkillRegistration[] = []
  const warnings: string[] = []
  const listeners: BootstrapPreStepListener[] = []
  const ctx = {
    skills: {
      register: (skill: SkillRegistration) => {
        skills.push(skill)
        return () => {}
      },
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
    on: (event: string, listener: BootstrapPreStepListener) => {
      if (event === 'agent/pre-step') listeners.push(listener)
      return () => true
    },
  } as unknown as Context
  return { ctx, skills, warnings, listeners }
}

describe('plugin entry', () => {
  it('declares its identity and required services', () => {
    expect(name).toBe('superpowers')
    expect(inject).toContain('skills')
  })

  it('registers skills and the injector, then injects the assembled bootstrap on the first step', async () => {
    const root = makeTree({
      'example-skill/SKILL.md': '---\nname: example-skill\ndescription: Example skill\n---\nEXAMPLE BODY\n',
      'using-superpowers/SKILL.md': '---\nname: using-superpowers\ndescription: fixture\n---\nFIXTURE SKILL BODY\n',
      'using-superpowers/references/dsh-tools.md': 'FIXTURE DSH TOOL MAPPING\n',
    })
    const plugin = fakePluginContext()

    apply(plugin.ctx, { skillsDir: root })

    expect(plugin.skills.map(skill => skill.name)).toEqual(['example-skill', 'using-superpowers'])
    expect(plugin.listeners).toHaveLength(1)

    const { session } = makeSession()
    const result = await plugin.listeners[0]!(
      { agent: makeAgent(session), signal: abortSignal() },
      async () => enter([prompt()]),
    )
    if (result.kind !== 'enter') throw new Error('expected an enter decision')
    const bootstrap = result.messages[0]!
    const text = bootstrap.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('FIXTURE SKILL BODY')
    expect(text).toContain('FIXTURE DSH TOOL MAPPING')
    expect(text).toMatch(/superpowers v[^ /\n]+ \/ dsh-adapter rev1/)
    expect(bootstrap.source.kind).toBe(BOOTSTRAP_SOURCE_KIND)
  })

  it('keeps skills but stays inert when bootstrap injection is disabled', async () => {
    const root = makeTree({
      'example-skill/SKILL.md': '---\nname: example-skill\ndescription: Example skill\n---\nBODY\n',
      'using-superpowers/SKILL.md': '---\nname: using-superpowers\ndescription: fixture\n---\nSKILL\n',
      'using-superpowers/references/dsh-tools.md': 'MAPPING\n',
    })
    const plugin = fakePluginContext()

    apply(plugin.ctx, { skillsDir: root, disableBootstrap: true })

    expect(plugin.skills).toHaveLength(2)
    expect(plugin.listeners).toHaveLength(1)
    const { session } = makeSession()
    const decision = enter([prompt()])
    const result = await plugin.listeners[0]!(
      { agent: makeAgent(session), signal: abortSignal() },
      async () => decision,
    )
    expect(result).toBe(decision)
  })

  it('registers skills and warns when the bootstrap assets are missing', () => {
    const root = makeTree({ 'example-skill/SKILL.md': '---\nname: example-skill\ndescription: Example skill\n---\nBODY\n' })
    const plugin = fakePluginContext()

    expect(() => apply(plugin.ctx, { skillsDir: root })).not.toThrow()
    expect(plugin.skills.map(skill => skill.name)).toEqual(['example-skill'])
    expect(plugin.listeners).toHaveLength(0)
    expect(plugin.warnings.some(message => message.includes('bootstrap injection disabled'))).toBe(true)
  })

  it('never throws from apply when all assets are missing', () => {
    const plugin = fakePluginContext()
    expect(() => apply(plugin.ctx, { skillsDir: join(tmpdir(), 'dsh-superpowers-missing-assets', String(Date.now())) })).not.toThrow()
    expect(plugin.skills).toEqual([])
    expect(plugin.listeners).toEqual([])
    expect(plugin.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('uses the packaged assets by default and degrades without throwing', () => {
    const plugin = fakePluginContext()
    expect(() => apply(plugin.ctx)).not.toThrow()
  })
})
