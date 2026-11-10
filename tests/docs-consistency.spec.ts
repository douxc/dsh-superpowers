import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Documentation must follow the vendored payload. The vendor workflows run
 * `scripts/sync-vendor-references.ts` before testing, and a formal-release PR
 * commits the result; this spec is what catches a missed sync.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

interface VendorLock {
  version: string
  ref: string
  files: Record<string, string>
}

const lock = JSON.parse(read('upstream/superpowers.lock.json')) as VendorLock
const pkg = JSON.parse(read('package.json')) as { version: string }

const skillCount = new Set(
  Object.keys(lock.files)
    .filter((rel) => /^[^/]+\/SKILL\.md$/.test(rel))
    .map((rel) => rel.split('/')[0]!),
).size
const fileCount = Object.keys(lock.files).length
const tarball = `dsh-superpowers-${pkg.version}.tgz`

describe('vendor documentation stays in sync with the lock', () => {
  it('THIRD_PARTY_NOTICES records the locked version, ref and payload size', () => {
    const notices = read('THIRD_PARTY_NOTICES.md')
    expect(notices).toContain(`Superpowers v${lock.version} is MIT-licensed`)
    expect(notices).toContain(`| Version | ${lock.version} (pinned) |`)
    expect(notices).toContain(`— ${skillCount} skill directories, ${fileCount} files`)
    expect(notices).toContain(lock.ref)
    expect(notices).toContain(`tag \`v${lock.version}\``)
  })

  it.each(['README.md', 'README.zh.md'])(
    '%s references the current package tarball',
    (file) => {
      const text = read(file)
      const matches = text.match(/dsh-superpowers-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz/g) ?? []
      expect(matches.length, `${file} must show an installable tarball name`).toBeGreaterThan(0)
      expect(new Set(matches)).toEqual(new Set([tarball]))
    },
  )

  it('ships an agent runbook with install, verification and limits', () => {
    const doc = read('for_agent.md')
    for (const needle of [
      'dsh plugin --profile web add',
      '--dump-config',
      'allowBuilds',
      'releases/latest',
      'restart',
    ]) {
      expect(doc, `for_agent.md must mention ${needle}`).toContain(needle)
    }
  })
})
