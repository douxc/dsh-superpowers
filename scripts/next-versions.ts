/**
 * Release version helper shared by the nightly and upstream-release workflows.
 *
 * The plugin version is an independent semver (it does not mirror the upstream
 * Superpowers version):
 *
 * - formal releases bump the patch segment (a human may bump minor instead);
 * - nightly builds are `<next-formal>-nightly.<YYYYMMDD>.<upstream-sha7>`, a
 *   semver prerelease that sorts below the formal release it precedes.
 *
 * CLI (used from workflows):
 *   tsx scripts/next-versions.ts formal --current 0.0.1
 *   tsx scripts/next-versions.ts nightly --current 0.0.1 --date 20261110 --sha 22f0b46
 *   tsx scripts/next-versions.ts newer --candidate v7.0.2 --current 7.0.1
 *   tsx scripts/next-versions.ts latest-tag v6.4.2 v7.0.10 v7.1.0-beta.1
 *
 * @module dsh-superpowers/next-versions
 */

import { pathToFileURL } from 'node:url'

/** A parsed `MAJOR.MINOR.PATCH` triple. */
interface Release {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** Parse a semver-ish release, tolerating a leading `v` and a prerelease suffix. */
function parseRelease(value: string): Release {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  if (match === null) throw new Error(`not a release version: "${value}"`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/** Compare two releases by numeric segment. */
function compareReleases(a: Release, b: Release): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** Render one release as `MAJOR.MINOR.PATCH`. */
function formatRelease(release: Release): string {
  return `${release.major}.${release.minor}.${release.patch}`
}

/**
 * The next formal version: the current patch segment plus one.
 * A prerelease suffix is discarded before bumping.
 * @param current - current plugin version, e.g. `0.0.1` or `0.0.2-nightly...`.
 * @returns the next formal version, e.g. `0.0.2`.
 */
export function nextFormalVersion(current: string): string {
  const release = parseRelease(current)
  return formatRelease({ ...release, patch: release.patch + 1 })
}

/**
 * The nightly version for one upstream snapshot.
 * @param current - current plugin version.
 * @param yyyymmdd - build date, `YYYYMMDD`.
 * @param sha7 - seven-character upstream commit id.
 * @returns `<next formal>-nightly.<yyyymmdd>.<sha7>`.
 */
export function nextNightlyVersion(current: string, yyyymmdd: string, sha7: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) throw new Error(`invalid build date: "${yyyymmdd}"`)
  if (!/^[0-9a-f]{7,40}$/.test(sha7)) throw new Error(`invalid commit id: "${sha7}"`)
  return `${nextFormalVersion(current)}-nightly.${yyyymmdd}.${sha7.slice(0, 7)}`
}

/**
 * Pick the highest stable upstream tag from a list of tags.
 * Prerelease tags (anything with a `-`) and non-`vX.Y.Z` names are ignored.
 * @param tags - tag names as they appear in `refs/tags/`.
 * @returns the highest stable tag, or `undefined` when none exists.
 */
export function latestStableTag(tags: readonly string[]): string | undefined {
  const stable = tags
    .map(tag => tag.trim())
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
    .map(tag => ({ tag, release: parseRelease(tag) }))
    .sort((a, b) => compareReleases(b.release, a.release))
  return stable[0]?.tag
}

/**
 * Whether `candidate` is a strictly newer release than `current`.
 * @param candidate - e.g. `v7.0.2`.
 * @param current - e.g. `7.0.1`.
 * @returns `true` when candidate > current.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareReleases(parseRelease(candidate), parseRelease(current)) > 0
}

/** Read one `--name value` / `--name=value` option from CLI arguments. */
function option(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === `--${name}`) {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`--${name} requires a value`)
      return value
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

const USAGE = `Usage:
  tsx scripts/next-versions.ts formal --current <version>
  tsx scripts/next-versions.ts nightly --current <version> --date <YYYYMMDD> --sha <commit>
  tsx scripts/next-versions.ts newer --candidate <version> --current <version>
  tsx scripts/next-versions.ts latest-tag <tag>...`

/** CLI entry point; prints one value and exits nonzero on invalid input. */
function main(args: readonly string[]): void {
  const [command, ...rest] = args
  switch (command) {
    case 'formal': {
      const current = option(rest, 'current')
      if (current === undefined) throw new Error('formal requires --current')
      console.log(nextFormalVersion(current))
      return
    }
    case 'nightly': {
      const current = option(rest, 'current')
      const date = option(rest, 'date')
      const sha = option(rest, 'sha')
      if (current === undefined || date === undefined || sha === undefined) {
        throw new Error('nightly requires --current, --date and --sha')
      }
      console.log(nextNightlyVersion(current, date, sha))
      return
    }
    case 'newer': {
      const candidate = option(rest, 'candidate')
      const current = option(rest, 'current')
      if (candidate === undefined || current === undefined) {
        throw new Error('newer requires --candidate and --current')
      }
      console.log(isNewerVersion(candidate, current) ? 'true' : 'false')
      return
    }
    case 'latest-tag': {
      const latest = latestStableTag(rest.filter(arg => !arg.startsWith('-')))
      if (latest === undefined) throw new Error('no stable upstream tag found')
      console.log(latest)
      return
    }
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE)
      return
    default:
      throw new Error(`unknown command "${command}"\n${USAGE}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`next-versions: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
