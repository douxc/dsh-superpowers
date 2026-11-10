/**
 * Vendor upstream Superpowers skills into this package (maintainer tool).
 *
 * Usage:
 *   pnpm exec tsx scripts/vendor-superpowers.ts [--from <local-clone>]
 *
 * `--from` defaults to /tmp/superpowers-research. The script only reads the local
 * clone — no network access — so it also works offline and in CI.
 *
 * What it does:
 *   1. copies `<clone>/skills/` → `./skills/` (excluding `.DS_Store`, preserving file
 *      modes). The target directory is deleted first; the repo-authored
 *      `assets/dsh-tools.md` is re-materialized afterwards, so that flow is preserved;
 *   2. copies `<clone>/LICENSE` → `./upstream/LICENSE-superpowers`;
 *   3. writes `./upstream/superpowers-version.txt` from `<clone>/package.json.version`;
 *   4. copies `./assets/dsh-tools.md` → `./skills/using-superpowers/references/dsh-tools.md`
 *      (the only file this repo adds to the upstream skill tree);
 *   5. writes `./upstream/superpowers.lock.json`.
 *
 * Lock format (schema 1):
 *   - `files`: `{ "<path relative to skills/>": "sha256:<hex>" }`, upstream files only;
 *   - `aggregateSha256`: `"sha256:<hex>"` of the UTF-8 string
 *     `` `${path}\0${sha256hex}\n` `` for every file sorted by path. It is independent
 *     of JSON key order and of `addedFiles`, so it only changes when upstream content or
 *     the file set changes;
 *   - `addedFiles`: repo-authored files excluded from `files`/`aggregateSha256`.
 *
 * Idempotency: re-running against the same clone with the same `assets/dsh-tools.md`
 * produces byte-identical lock output. The content-derived fields (`files`,
 * `aggregateSha256`) are stable by construction; `vendoredAt` is preserved from the
 * previous lock when nothing else changed.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_FROM = '/tmp/superpowers-research'
const UPSTREAM_URL = 'https://github.com/obra/superpowers'
const LOCK_SCHEMA = 1
const SKILLS_ROOT = 'skills'
const UPSTREAM_DIR = 'upstream'
const ADDED_FILES = ['using-superpowers/references/dsh-tools.md'] as const
const ASSETS_SOURCE = 'assets/dsh-tools.md'

interface WalkEntry {
  /** Path relative to the walked root, always POSIX-separated. */
  readonly rel: string
  readonly abs: string
  readonly mode: number
}

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

function fail(message: string): never {
  throw new Error(message)
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function sha256File(path: string): string {
  return sha256Hex(readFileSync(path))
}

function aggregateSha256Of(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((path) => `${path}\0${files[path]}\n`)
    .join('')
  return `sha256:${sha256Hex(lines)}`
}

function isoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Recursively list regular files, `.DS_Store` excluded, sorted for determinism. */
function walkFiles(dir: string, relDir = ''): WalkEntry[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const out: WalkEntry[] = []
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const abs = join(dir, entry.name)
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel))
    } else if (entry.isFile()) {
      out.push({ rel, abs, mode: statSync(abs).mode & 0o777 })
    } else if (entry.isSymbolicLink()) {
      fail(`unsupported symlink in upstream skills/: ${rel}`)
    } else {
      fail(`unsupported file type in upstream skills/: ${rel}`)
    }
  }
  return out
}

function copyTree(sourceDir: string, targetDir: string): WalkEntry[] {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  const entries = walkFiles(sourceDir)
  for (const entry of entries) {
    const dest = join(targetDir, entry.rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(entry.abs, dest)
    chmodSync(dest, entry.mode)
  }
  return entries
}

function gitOutput(clone: string, args: string[]): string {
  return execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim()
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot parse ${path}: ${String(error)}`)
  }
}

function parseArgs(argv: string[]): { from: string; help: boolean } {
  let from = DEFAULT_FROM
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    // `pnpm run <script> -- --from ...` forwards the separator as a literal argument.
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') return { from, help: true }
    if (arg === '--from') {
      const value = argv[index + 1]
      if (value === undefined) fail('--from requires a path')
      from = value
      index += 1
      continue
    }
    if (arg.startsWith('--from=')) {
      const value = arg.slice('--from='.length)
      if (value === '') fail('--from requires a path')
      from = value
      continue
    }
    fail(`unknown argument: ${arg} (usage: vendor-superpowers.ts [--from <local-clone>])`)
  }
  return { from, help: false }
}

function printUsage(): void {
  console.log(`Usage: pnpm exec tsx scripts/vendor-superpowers.ts [--from <local-clone>]

Vendors the upstream Superpowers skills into ./skills/ and writes the offline
verification metadata in ./upstream/.

Options:
  --from <path>  local clone of obra/superpowers (default: ${DEFAULT_FROM})
  -h, --help     show this help

The run is idempotent: with an unchanged clone and assets/dsh-tools.md the lock
file is byte-identical and only the filesystem copy is refreshed.`)
}

function canonicalFiles(files: unknown): string {
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return 'null'
  const entries = Object.entries(files as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => [key, value])
  return JSON.stringify(entries)
}

function sameLockInputs(previous: Record<string, unknown>, next: Omit<VendorLock, 'vendoredAt'>): boolean {
  return (
    previous.schema === next.schema &&
    previous.upstream === next.upstream &&
    previous.version === next.version &&
    previous.ref === next.ref &&
    previous.root === next.root &&
    previous.aggregateSha256 === next.aggregateSha256 &&
    isDeepStrictEqual(previous.addedFiles, next.addedFiles) &&
    canonicalFiles(previous.files) === canonicalFiles(next.files)
  )
}

function runVendor(from: string): { version: string; ref: string; files: number; skills: number; aggregate: string; unchanged: boolean } {
  const clone = resolve(from)
  const clonePackageJson = join(clone, 'package.json')
  const cloneSkills = join(clone, SKILLS_ROOT)
  const cloneLicense = join(clone, 'LICENSE')
  for (const required of [clonePackageJson, cloneSkills, cloneLicense]) {
    if (!existsSync(required)) fail(`not a Superpowers clone (missing ${required}); pass --from <local-clone>`)
  }

  const manifest = readJson(clonePackageJson)
  if (manifest === null || typeof manifest !== 'object' || typeof (manifest as { version?: unknown }).version !== 'string') {
    fail(`${clonePackageJson} has no string "version" field`)
  }
  const version = (manifest as { version: string }).version
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`unexpected upstream version "${version}"`)

  let ref: string
  try {
    ref = gitOutput(clone, ['rev-parse', 'HEAD'])
  } catch (error) {
    fail(`cannot resolve upstream ref with git in ${clone} (a git clone is required): ${String(error)}`)
  }
  if (!/^[0-9a-f]{40}$/.test(ref)) fail(`unexpected upstream ref "${ref}"`)
  const tags = (() => {
    try {
      return gitOutput(clone, ['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean)
    } catch {
      return []
    }
  })()
  if (tags.length > 0 && !tags.includes(`v${version}`)) {
    console.warn(
      `vendor-superpowers: warning: upstream HEAD is tagged [${tags.join(', ')}] but package.json says ${version}`,
    )
  }

  const assetsSource = join(REPO_ROOT, ASSETS_SOURCE)
  if (!existsSync(assetsSource)) fail(`missing repo-authored source ${ASSETS_SOURCE}`)

  // Refuse to silently overwrite a file the upstream tree may have started shipping.
  const sourceEntries = walkFiles(cloneSkills)
  const addedSet = new Set<string>(ADDED_FILES)
  for (const addedFile of ADDED_FILES) {
    if (sourceEntries.some((entry) => entry.rel === addedFile)) {
      fail(
        `upstream now ships skills/${addedFile}; it can no longer be an added file. ` +
          'Update this script, the lock addedFiles and THIRD_PARTY_NOTICES.md deliberately.',
      )
    }
  }

  const skillsTarget = join(REPO_ROOT, SKILLS_ROOT)
  copyTree(cloneSkills, skillsTarget)

  // Re-materialize the repo-authored mapping file (its source of truth is assets/).
  for (const addedFile of ADDED_FILES) {
    const dest = join(skillsTarget, addedFile)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(assetsSource, dest)
    chmodSync(dest, 0o644)
  }

  const upstreamDir = join(REPO_ROOT, UPSTREAM_DIR)
  mkdirSync(upstreamDir, { recursive: true })
  copyFileSync(cloneLicense, join(upstreamDir, 'LICENSE-superpowers'))
  writeFileSync(join(upstreamDir, 'superpowers-version.txt'), `${version}\n`, 'utf8')

  // Verify the copied tree byte-for-byte and build the per-file hash map from the
  // actual vendored bytes (not from the source), so copy regressions cannot hide.
  const sourceHashes = new Map(sourceEntries.map((entry) => [entry.rel, sha256File(entry.abs)]))
  const targetEntries = walkFiles(skillsTarget)
  const targetRels = new Set(targetEntries.map((entry) => entry.rel))
  const files: Record<string, string> = {}
  for (const entry of targetEntries) {
    if (addedSet.has(entry.rel)) continue
    if (!sourceHashes.has(entry.rel)) fail(`unexpected file in vendored ${SKILLS_ROOT}/: ${entry.rel}`)
    const targetHash = sha256File(entry.abs)
    if (targetHash !== sourceHashes.get(entry.rel)) fail(`vendored copy mismatch: ${entry.rel}`)
    files[entry.rel] = `sha256:${targetHash}`
  }
  for (const entry of sourceEntries) {
    if (!targetRels.has(entry.rel)) fail(`missing vendored file: ${entry.rel}`)
  }
  for (const addedFile of ADDED_FILES) {
    if (!targetRels.has(addedFile)) fail(`missing added file: ${addedFile}`)
  }
  if (Object.keys(files).length !== sourceEntries.length) {
    fail(`vendored file count ${Object.keys(files).length} != upstream file count ${sourceEntries.length}`)
  }

  const aggregateSha256 = aggregateSha256Of(files)
  const nextLock = {
    schema: LOCK_SCHEMA,
    upstream: UPSTREAM_URL,
    version,
    ref,
    vendoredAt: isoSeconds(),
    root: SKILLS_ROOT,
    files,
    aggregateSha256,
    addedFiles: [...ADDED_FILES],
  }

  const lockPath = join(upstreamDir, 'superpowers.lock.json')
  let previousRaw: string | undefined
  let previous: Record<string, unknown> | undefined
  if (existsSync(lockPath)) {
    previousRaw = readFileSync(lockPath, 'utf8')
    try {
      const parsed = JSON.parse(previousRaw) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        previous = parsed as Record<string, unknown>
      }
    } catch {
      // A corrupt lock is simply regenerated below.
    }
  }

  let unchanged = false
  if (previous !== undefined && typeof previous.vendoredAt === 'string' && sameLockInputs(previous, nextLock)) {
    nextLock.vendoredAt = previous.vendoredAt
  }
  const serialized = `${JSON.stringify(nextLock, null, 2)}\n`
  writeFileSync(lockPath, serialized, 'utf8')
  unchanged = previousRaw === serialized

  const skillCount = readdirSync(skillsTarget, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  return {
    version,
    ref,
    files: Object.keys(files).length,
    skills: skillCount,
    aggregate: aggregateSha256,
    unchanged,
  }
}

async function main(): Promise<void> {
  const { from, help } = parseArgs(process.argv.slice(2))
  if (help) {
    printUsage()
    return
  }
  const result = runVendor(from)
  console.log(`vendor-superpowers: vendored Superpowers v${result.version} from ${resolve(from)}`)
  console.log(`  ref        ${result.ref}`)
  console.log(`  skills/    ${result.files} upstream files, ${result.skills} skill directories, +${ADDED_FILES.length} added file`)
  console.log(`  upstream/  LICENSE-superpowers, superpowers-version.txt, superpowers.lock.json`)
  console.log(`  aggregate  ${result.aggregate}`)
  if (result.unchanged) {
    console.log('  status     unchanged — idempotent re-run, lock bytes stable')
  } else {
    console.log('  status     updated — review RELEASE-NOTES.md, THIRD_PARTY_NOTICES.md and run:')
    console.log('             pnpm exec vitest run tests/vendor.spec.ts')
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    await main()
  } catch (error) {
    console.error(`vendor-superpowers: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export { ADDED_FILES, UPSTREAM_URL, aggregateSha256Of, sha256Hex }
