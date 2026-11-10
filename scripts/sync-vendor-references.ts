/**
 * Keep the human-readable vendor documentation in sync with the vendored payload.
 *
 * The vendor lock (`upstream/superpowers.lock.json`) is the source of truth for
 * the upstream version/commit and the vendored file set; `package.json.version`
 * is the source of truth for the plugin tarball name. This script rewrites the
 * version/reference lines in:
 *
 * - `THIRD_PARTY_NOTICES.md` (upstream version, pinned ref/tag, payload size)
 * - `README.md` / `README.zh.md` (tarball example names)
 *
 * Usage:
 *   pnpm run sync:vendor-docs             # rewrite drifted references
 *   pnpm run sync:vendor-docs -- --check  # exit 1 listing drifted files
 *
 * @module dsh-superpowers/sync-vendor-references
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The fields of the vendor lock this script reads. */
export interface VendorLockView {
  /** Upstream Superpowers version, e.g. `7.0.2`. */
  readonly version: string
  /** Full upstream commit id (40 hex characters). */
  readonly ref: string
  /** Upstream files keyed by path relative to `skills/`. */
  readonly files: Readonly<Record<string, string>>
}

/** One documentation file's before/after state. */
export interface DocUpdate {
  /** Repository-relative path. */
  readonly path: string
  /** Current contents. */
  readonly before: string
  /** Contents with the lock/package references applied. */
  readonly after: string
}

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const DOC_PATHS = ['THIRD_PARTY_NOTICES.md', 'README.md', 'README.zh.md'] as const

const VERSIONED_TARBALL = /dsh-superpowers-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz/g

/** Replace a required pattern exactly once, failing loudly when the shape changed. */
function replaceOnce(source: string, pattern: RegExp, replacement: string, path: string, what: string): string {
  if (!pattern.test(source)) throw new Error(`${path}: cannot find ${what} (pattern ${pattern})`)
  return source.replace(pattern, replacement)
}

/** Replace every versioned tarball example name with the current package version. */
function replaceTarballNames(source: string, packageVersion: string, path: string): string {
  if (source.match(VERSIONED_TARBALL) === null) {
    throw new Error(`${path}: cannot find a versioned dsh-superpowers-<version>.tgz example`)
  }
  return source.replace(VERSIONED_TARBALL, `dsh-superpowers-${packageVersion}.tgz`)
}

/** Count distinct skill directories recorded in the lock. */
export function skillCountOf(lock: VendorLockView): number {
  return new Set(
    Object.keys(lock.files)
      .filter(rel => /^[^/]+\/SKILL\.md$/.test(rel))
      .map(rel => rel.split('/')[0]!),
  ).size
}

/**
 * Compute the updated documentation contents without touching disk.
 * @param lock - parsed vendor lock.
 * @param packageVersion - current `package.json.version` (may include a prerelease).
 * @param docs - current contents keyed by repository-relative path.
 * @returns one update entry per documentation file.
 */
export function renderUpdatedDocs(
  lock: VendorLockView,
  packageVersion: string,
  docs: Readonly<Record<string, string>>,
): DocUpdate[] {
  const files = Object.keys(lock.files).length
  const skills = skillCountOf(lock)
  return DOC_PATHS.map(path => {
    const before = docs[path]
    if (before === undefined) throw new Error(`missing documentation file: ${path}`)
    let after: string
    if (path === 'THIRD_PARTY_NOTICES.md') {
      after = replaceOnce(
        before,
        /Superpowers v\d+\.\d+\.\d+ is MIT-licensed/,
        `Superpowers v${lock.version} is MIT-licensed`,
        path,
        'the upstream version sentence',
      )
      after = replaceOnce(
        after,
        /\| Version \| \d+\.\d+\.\d+ \(pinned\) \|/,
        `| Version | ${lock.version} (pinned) |`,
        path,
        'the pinned version row',
      )
      after = replaceOnce(
        after,
        /— \d+ skill directories, \d+ files/,
        `— ${skills} skill directories, ${files} files`,
        path,
        'the vendored payload size',
      )
      after = replaceOnce(
        after,
        /`[0-9a-f]{40}`, tag `v\d+\.\d+\.\d+`\)/,
        `\`${lock.ref}\`, tag \`v${lock.version}\`)`,
        path,
        'the pinned commit and tag',
      )
    } else {
      after = replaceTarballNames(before, packageVersion, path)
    }
    return { path, before, after }
  })
}

/** Read the lock, package version and documentation from disk. */
function readInputs(): { lock: VendorLockView; packageVersion: string; docs: Record<string, string> } {
  const lock = JSON.parse(readFileSync(join(ROOT, 'upstream/superpowers.lock.json'), 'utf8')) as VendorLockView
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const docs: Record<string, string> = {}
  for (const path of DOC_PATHS) docs[path] = readFileSync(join(ROOT, path), 'utf8')
  return { lock, packageVersion: pkg.version, docs }
}

const USAGE = `Usage:
  pnpm run sync:vendor-docs             rewrite drifted references
  pnpm run sync:vendor-docs -- --check  fail (exit 1) when references are stale`

/** CLI entry point. */
function main(args: readonly string[]): void {
  const check = args.includes('--check')
  // `pnpm run <script> -- --check` may forward the separator as a literal argument.
  const unknown = args.filter(arg => arg !== '--check' && arg !== '--')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}\n${USAGE}`)
  const { lock, packageVersion, docs } = readInputs()
  const updates = renderUpdatedDocs(lock, packageVersion, docs)
  const changed = updates.filter(update => update.before !== update.after)
  if (check) {
    if (changed.length > 0) {
      console.error(
        `sync-vendor-references: stale documentation (${changed.map(update => update.path).join(', ')}) — run "pnpm run sync:vendor-docs"`,
      )
      process.exitCode = 1
      return
    }
    console.log('sync-vendor-references: documentation is in sync with the lock and package version')
    return
  }
  for (const update of changed) writeFileSync(join(ROOT, update.path), update.after, 'utf8')
  console.log(
    changed.length === 0
      ? 'sync-vendor-references: nothing to update'
      : `sync-vendor-references: updated ${changed.map(update => update.path).join(', ')}`,
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`sync-vendor-references: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
