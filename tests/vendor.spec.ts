/**
 * Offline verification of the vendored Superpowers payload.
 *
 * Guards against three kinds of drift:
 *   1. hand edits to `skills/` (per-file sha256 differs from the committed lock);
 *   2. a vendor run that was not committed (or a lock that was not regenerated);
 *   3. files sneaking into the upstream tree — only the whitelisted `addedFiles`
 *      (repo-authored `assets/dsh-tools.md` → `using-superpowers/references/dsh-tools.md`)
 *      may exist outside the lock.
 *
 * No network and no local upstream clone required: everything is recomputed from the
 * committed files, so this runs in CI.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSkillDocument } from '../src/skills.ts'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SKILLS_DIR = join(ROOT, 'skills')
const UPSTREAM_DIR = join(ROOT, 'upstream')
const LOCK_PATH = join(UPSTREAM_DIR, 'superpowers.lock.json')
const VERSION_PATH = join(UPSTREAM_DIR, 'superpowers-version.txt')
const LICENSE_PATH = join(UPSTREAM_DIR, 'LICENSE-superpowers')
const ADDED_TOOLS_PATH = join(SKILLS_DIR, 'using-superpowers', 'references', 'dsh-tools.md')
const ADDED_TOOLS_SOURCE = join(ROOT, 'assets', 'dsh-tools.md')

/** The only paths this repo is allowed to add on top of the upstream tree. */
const ADDED_FILES = ['using-superpowers/references/dsh-tools.md']

interface VendorLock {
  schema: number
  upstream: string
  version: string
  ref: string
  vendoredAt: string
  root: string
  files: Record<string, string>
  aggregateSha256: string
  addedFiles: string[]
}

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as VendorLock

/** Skill directories recorded in the lock, derived from the upstream file list. */
const LOCKED_SKILLS = [
  ...new Set(
    Object.keys(lock.files)
      .filter((rel) => /^[^/]+\/SKILL\.md$/.test(rel))
      .map((rel) => rel.split('/')[0]!),
  ),
].sort()

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Lock aggregate algorithm (must stay in sync with scripts/vendor-superpowers.ts):
 * sha256 over `` `${path}\0${hash}\n` `` for every file, sorted by path.
 * Deliberately reimplemented here instead of imported so the lock is verified
 * independently of the generator.
 */
function aggregateSha256Of(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((path) => `${path}\0${files[path]}\n`)
    .join('')
  return `sha256:${sha256Hex(lines)}`
}

/** Recursively list regular files as POSIX-relative paths, sorted. `.DS_Store` is
 * ignored here for the same reason the vendoring script excludes it. */
function walkFiles(dir: string, relDir = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
    else throw new Error(`unexpected non-file entry in skills/: ${rel}`)
  }
  return out
}

describe('vendored Superpowers tree', () => {
  it('contains every skill directory recorded in the lock, each loadable by the plugin', () => {
    const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(LOCKED_SKILLS.length).toBeGreaterThan(0)
    expect(skillDirs).toEqual(LOCKED_SKILLS)

    for (const skill of LOCKED_SKILLS) {
      expect(skill, `${skill} must be a kebab-case skill directory`).toMatch(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      )
      const skillFile = join(SKILLS_DIR, skill, 'SKILL.md')
      const content = readFileSync(skillFile, 'utf8')
      expect(content.length, `${skill}/SKILL.md must not be empty`).toBeGreaterThan(0)
      expect(content, `${skill}/SKILL.md must have YAML frontmatter`).toMatch(/^---\n/)
      // The plugin parses these files at startup; a parse failure here means the
      // vendored tree would silently degrade at runtime.
      const parsed = parseSkillDocument(content)
      expect(parsed.frontmatter.name, `${skill} frontmatter name must match the directory`).toBe(
        skill,
      )
      expect(parsed.frontmatter.description?.length ?? 0).toBeGreaterThan(0)
      expect(parsed.body.trim().length, `${skill} must have a body`).toBeGreaterThan(0)
    }
  })

  it('matches upstream/superpowers.lock.json per-file sha256 and aggregate', () => {
    expect(lock.schema).toBe(1)
    expect(lock.upstream).toMatch(/^https:\/\/github\.com\/obra\/superpowers$/)
    expect(lock.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.ref).toMatch(/^[0-9a-f]{40}$/)
    expect(lock.vendoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Number.isNaN(Date.parse(lock.vendoredAt))).toBe(false)
    expect(lock.root).toBe('skills')
    expect(lock.files).toBeTypeOf('object')

    const addedSet = new Set(lock.addedFiles)
    expect(lock.addedFiles).toEqual(ADDED_FILES)

    const actualFiles = walkFiles(SKILLS_DIR)
    const actualUpstream = actualFiles.filter((rel) => !addedSet.has(rel))
    expect(actualUpstream).toEqual(Object.keys(lock.files).sort())
    expect(actualUpstream).toHaveLength(Object.keys(lock.files).length)
    expect(actualFiles).toHaveLength(Object.keys(lock.files).length + ADDED_FILES.length)

    for (const rel of actualUpstream) {
      const expected = lock.files[rel]
      expect(expected, `${rel} must be registered in the lock`).toMatch(/^sha256:[0-9a-f]{64}$/)
      const actual = `sha256:${sha256Hex(readFileSync(join(SKILLS_DIR, rel)))}`
      expect(actual, `${rel} was modified by hand or the lock is stale`).toBe(expected)
    }

    expect(aggregateSha256Of(lock.files)).toBe(lock.aggregateSha256)
    expect(lock.aggregateSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('allows only whitelisted added files and keeps them in sync with assets/', () => {
    for (const rel of lock.addedFiles) {
      const vendored = readFileSync(join(SKILLS_DIR, rel))
      const source = readFileSync(ADDED_TOOLS_SOURCE)
      expect(vendored.equals(source), `${rel} must be byte-identical to assets/dsh-tools.md`).toBe(true)
      expect(lock.files[rel], `${rel} is repo-authored and must not be hashed as upstream`).toBeUndefined()
    }

    // Anything else in skills/ that is neither upstream nor whitelisted is a vendor violation.
    const known = new Set([...Object.keys(lock.files), ...lock.addedFiles])
    for (const rel of walkFiles(SKILLS_DIR)) {
      expect(known.has(rel), `unexpected file in skills/: ${rel}`).toBe(true)
    }
  })

  it('documents the required DSH tool mappings in dsh-tools.md', () => {
    const mapping = readFileSync(ADDED_TOOLS_PATH, 'utf8')
    for (const tool of ['skill', 'subagent', 'todo_write', 'ask_user_question']) {
      expect(mapping, `dsh-tools.md must map the "${tool}" tool`).toContain(`\`${tool}\``)
    }
    expect(mapping).toMatch(/DeepSeek Harness/)
    expect(mapping).toMatch(/addedFiles/)
  })

  it('keeps the upstream version marker and MIT license', () => {
    expect(readFileSync(VERSION_PATH, 'utf8').trim()).toBe(lock.version)
    const license = readFileSync(LICENSE_PATH, 'utf8')
    expect(license).toMatch(/^MIT License/)
    expect(license).toContain('Jesse Vincent')
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  })
})

describe('packaging metadata', () => {
  it('ships a compact SVG icon', () => {
    const icon = readFileSync(join(ROOT, 'icon.svg'))
    expect(icon.byteLength).toBeGreaterThan(0)
    expect(icon.byteLength).toBeLessThanOrEqual(8 * 1024)
    expect(icon.toString('utf8')).toMatch(/^<svg[\s>]/)
    expect(icon.toString('utf8')).toContain('viewBox="0 0 36 36"')
  })

  it('ships bilingual locale metadata for the plugin market', () => {
    for (const language of ['en', 'zh']) {
      const path = join(ROOT, 'locale', `${language}.json`)
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        meta?: { title?: unknown; description?: unknown }
      }
      expect(parsed.meta, `${language}.json needs a meta object`).toBeTypeOf('object')
      expect(typeof parsed.meta?.title, `${language}.json meta.title`).toBe('string')
      expect(typeof parsed.meta?.description, `${language}.json meta.description`).toBe('string')
      expect((parsed.meta?.title as string).length).toBeGreaterThan(0)
      expect((parsed.meta?.description as string).length).toBeGreaterThan(0)
    }
  })

  it('discloses upstream provenance in THIRD_PARTY_NOTICES.md', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(notices).toContain(`Superpowers v${lock.version}`)
    expect(notices).toContain(`| Version | ${lock.version} (pinned) |`)
    expect(notices).toContain(
      `— ${LOCKED_SKILLS.length} skill directories, ${Object.keys(lock.files).length} files`,
    )
    expect(notices).toMatch(/MIT/)
    expect(notices).toContain('https://github.com/obra/superpowers')
    expect(notices).toContain('upstream/LICENSE-superpowers')
    expect(notices).toContain('using-superpowers/references/dsh-tools.md')
  })

  it('keeps the Chinese README paired with the English one', () => {
    const zhReadme = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
    expect(zhReadme).toContain('[English](README.md) | 中文')
    for (const heading of ['安装', '工作方式', '已知限制与待办', '许可']) {
      expect(zhReadme).toContain(`## ${heading}`)
    }
  })
})
