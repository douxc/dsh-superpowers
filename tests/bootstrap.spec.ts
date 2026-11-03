import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ADAPTER_REVISION,
  assembleBootstrap,
  BOOTSTRAP_CLOSE_TAG,
  BOOTSTRAP_OPEN_TAG,
  BOOTSTRAP_TEXT_MARKER,
  clearBootstrapCache,
  DEFAULT_MAX_BOOTSTRAP_BYTES,
  DSH_TOOLS_REFERENCE,
  loadBootstrap,
  readBootstrapSource,
  readUpstreamVersion,
  sha256Digest,
  UNKNOWN_UPSTREAM_VERSION,
} from '../src/bootstrap.js'
import { bundledSkillsDir, bundledUpstreamDir } from '../src/paths.js'

const tempDirs: string[] = []

afterEach(() => {
  clearBootstrapCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Write a tree of fixture files under a fresh temp directory. */
function makeTree(files: Record<string, string | undefined>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superpowers-bootstrap-'))
  tempDirs.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    if (content !== undefined) writeFileSync(absolute, content)
  }
  return root
}

const SKILL_MARKDOWN = [
  '---',
  'name: using-superpowers',
  'description: fixture description that must not reach the bootstrap',
  '---',
  '',
  '<SUBAGENT-STOP>',
  'Ignore this skill when dispatched as a subagent.',
  '</SUBAGENT-STOP>',
  '',
  '## The Rule',
  '',
  'Invoke relevant skills before responding.',
  '',
].join('\n')

const DSH_TOOLS_MARKDOWN = [
  '## DSH tool mapping',
  '',
  '| Superpowers action | DSH tool |',
  '|---|---|',
  '| Invoke / load a skill | `skill` |',
  '| Create / update todos | `todo_write` |',
  '',
].join('\n')

/** Create a skills tree that contains the two bootstrap source documents. */
function makeBootstrapSkillsDir(overrides: { skillMarkdown?: string; toolMapping?: string } = {}): string {
  return makeTree({
    [join('using-superpowers', 'SKILL.md')]: overrides.skillMarkdown ?? SKILL_MARKDOWN,
    [join('using-superpowers', DSH_TOOLS_REFERENCE)]: overrides.toolMapping ?? DSH_TOOLS_MARKDOWN,
  })
}

describe('assembleBootstrap', () => {
  it('assembles the upstream Shape B block from the skill body and the DSH mapping', () => {
    const skillsDir = makeBootstrapSkillsDir()
    const result = loadBootstrap({ skillsDir, version: '7.0.1' })

    expect(result.text.startsWith(`${BOOTSTRAP_OPEN_TAG}\n${BOOTSTRAP_TEXT_MARKER}`)).toBe(true)
    expect(result.text).toContain(`superpowers v7.0.1 / dsh-adapter ${ADAPTER_REVISION}`)
    expect(result.text).toContain('<SUBAGENT-STOP>')
    expect(result.text).toContain('Invoke relevant skills before responding.')
    expect(result.text).toContain('| Invoke / load a skill | `skill` |')
    expect(result.text).toContain('| Create / update todos | `todo_write` |')
    expect(result.text.endsWith(`${BOOTSTRAP_CLOSE_TAG}\n`)).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it('removes the SKILL.md frontmatter from the injected text', () => {
    const result = loadBootstrap({ skillsDir: makeBootstrapSkillsDir(), version: '7.0.1' })
    expect(result.text).not.toContain('name: using-superpowers')
    expect(result.text).not.toContain('fixture description that must not reach the bootstrap')
  })

  it('records a stable digest of the exact injected text', () => {
    const source = readBootstrapSource(makeBootstrapSkillsDir())
    const first = assembleBootstrap(source, { version: '7.0.1' })
    const second = assembleBootstrap(source, { version: '7.0.1' })

    expect(first.text).toBe(second.text)
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.digest).toBe(sha256Digest(first.text))
    expect(first.bytes).toBe(Buffer.byteLength(first.text, 'utf8'))
    expect(first.version).toBe('7.0.1')
  })

  it('changes the digest when the upstream version changes', () => {
    const source = readBootstrapSource(makeBootstrapSkillsDir())
    const older = assembleBootstrap(source, { version: '7.0.0' })
    const newer = assembleBootstrap(source, { version: '7.0.1' })
    expect(older.digest).not.toBe(newer.digest)
    expect(newer.text).toContain('superpowers v7.0.1 /')
  })
})

describe('loadBootstrap cache', () => {
  it('reads and assembles the bundled sources once per configuration', () => {
    const skillsDir = makeBootstrapSkillsDir()
    const first = loadBootstrap({ skillsDir, version: '7.0.1' })
    expect(first.text).toContain('Invoke relevant skills before responding.')

    // Replace the on-disk sources: a second load must serve the cache.
    writeFileSync(join(skillsDir, 'using-superpowers', 'SKILL.md'), '---\nname: using-superpowers\ndescription: changed\n---\nCHANGED BODY\n')
    const cached = loadBootstrap({ skillsDir, version: '7.0.1' })
    expect(cached).toBe(first)
    expect(cached.text).toContain('Invoke relevant skills before responding.')
    expect(cached.text).not.toContain('CHANGED BODY')

    clearBootstrapCache()
    const refreshed = loadBootstrap({ skillsDir, version: '7.0.1' })
    expect(refreshed).not.toBe(first)
    expect(refreshed.text).toContain('CHANGED BODY')
  })

  it('keys the cache by byte bound as well as source and version', () => {
    const skillsDir = makeBootstrapSkillsDir()
    const unbounded = loadBootstrap({ skillsDir, version: '7.0.1' })
    const bounded = loadBootstrap({ skillsDir, version: '7.0.1', maxBytes: 300 })
    const boundedAgain = loadBootstrap({ skillsDir, version: '7.0.1', maxBytes: 300 })

    expect(boundedAgain).toBe(bounded)
    expect(bounded).not.toBe(unbounded)
    expect(bounded.truncated).toBe(true)
    expect(unbounded.truncated).toBe(false)
  })
})

describe('truncation', () => {
  it('cuts the text to the byte bound on a code-point boundary and marks the cut', () => {
    const skillsDir = makeBootstrapSkillsDir({ skillMarkdown: `---\nname: using-superpowers\ndescription: d\n---\n${'汉'.repeat(500)}\n` })
    const result = loadBootstrap({ skillsDir, version: '7.0.1', maxBytes: 400 })

    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(400)
    expect(result.text).toContain('truncated')
    // No split multi-byte code points: decoding the UTF-8 bytes round-trips.
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text)
    expect(result.digest).toBe(sha256Digest(result.text))
  })

  it('applies the default byte bound when none is configured', () => {
    const skillsDir = makeBootstrapSkillsDir({ skillMarkdown: `---\nname: using-superpowers\ndescription: d\n---\n${'x'.repeat(DEFAULT_MAX_BOOTSTRAP_BYTES + 1024)}\n` })
    const result = loadBootstrap({ skillsDir, version: '7.0.1' })

    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(DEFAULT_MAX_BOOTSTRAP_BYTES)
    expect(result.text).toContain('truncated')
  })
})

describe('readBootstrapSource', () => {
  it('throws a descriptive error when the bootstrap skill is missing', () => {
    const skillsDir = makeTree({})
    expect(() => readBootstrapSource(skillsDir)).toThrow(/cannot read bootstrap skill/)
  })

  it('throws a descriptive error when the DSH tool mapping is missing', () => {
    const skillsDir = makeTree({ [join('using-superpowers', 'SKILL.md')]: SKILL_MARKDOWN })
    expect(() => readBootstrapSource(skillsDir)).toThrow(/cannot read DSH tool mapping/)
  })
})

describe('readUpstreamVersion', () => {
  it('reads the version marker file written by the vendoring script', () => {
    const upstreamDir = makeTree({ 'superpowers-version.txt': '7.0.1\n' })
    expect(readUpstreamVersion(upstreamDir)).toBe('7.0.1')
  })

  it('falls back to the vendoring lock file', () => {
    const upstreamDir = makeTree({ 'superpowers.lock.json': JSON.stringify({ schema: 1, version: '7.0.1' }) })
    expect(readUpstreamVersion(upstreamDir)).toBe('7.0.1')
  })

  it('degrades to unknown when no metadata is readable', () => {
    expect(readUpstreamVersion(makeTree({}))).toBe(UNKNOWN_UPSTREAM_VERSION)
    expect(readUpstreamVersion(makeTree({ 'superpowers-version.txt': '  \n' }))).toBe(UNKNOWN_UPSTREAM_VERSION)
    expect(readUpstreamVersion(makeTree({ 'superpowers.lock.json': '{not json' }))).toBe(UNKNOWN_UPSTREAM_VERSION)
  })
})

describe('package asset paths', () => {
  it('resolves the packaged skills and upstream directories relative to the module', () => {
    expect(bundledSkillsDir().startsWith(sep)).toBe(true)
    expect(bundledSkillsDir().endsWith(`${sep}skills${sep}`)).toBe(true)
    expect(bundledUpstreamDir().endsWith(`${sep}upstream${sep}`)).toBe(true)
    // `src/` and the built `lib/` both sit one level below the package root.
    expect(dirname(bundledSkillsDir())).toBe(dirname(bundledUpstreamDir()))
  })
})
