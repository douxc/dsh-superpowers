/**
 * Bootstrap text assembly, digesting, caching, and truncation.
 *
 * Every root session receives one user-role "bootstrap" message whose text is:
 * the upstream `using-superpowers` skill body (frontmatter removed), the
 * DSH-specific tool mapping, and a short preamble/version marker. The text is
 * assembled once per plugin load (`loadBootstrap` caches by source directory,
 * version, and byte bound) and digested so the injector can deduplicate across
 * steps and sessions.
 *
 * @module dsh-superpowers/bootstrap
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillDocument } from './skills.js'

/** Default upper bound for the injected bootstrap text, in bytes. */
export const DEFAULT_MAX_BOOTSTRAP_BYTES = 32 * 1024

/** Marker identifying the upstream Superpowers bootstrap in model-facing text. */
export const BOOTSTRAP_TEXT_MARKER = 'You have superpowers.'

/** Opening tag used by upstream's Shape B bootstrap block. */
export const BOOTSTRAP_OPEN_TAG = '<EXTREMELY_IMPORTANT>'

/** Closing tag used by upstream's Shape B bootstrap block. */
export const BOOTSTRAP_CLOSE_TAG = '</EXTREMELY_IMPORTANT>'

/** Version of this DSH adapter layer, recorded in the bootstrap version marker. */
export const ADAPTER_REVISION = 'rev1'

/** Skill directory whose body forms the bootstrap. */
export const BOOTSTRAP_SKILL_NAME = 'using-superpowers'

/** Reference file (relative to the skill directory) holding the DSH tool mapping. */
export const DSH_TOOLS_REFERENCE = join('references', 'dsh-tools.md')

/** Version placeholder used when no vendoring metadata can be read. */
export const UNKNOWN_UPSTREAM_VERSION = 'unknown'

/** Version marker file written by the vendoring script. */
const UPSTREAM_VERSION_FILE = 'superpowers-version.txt'

/** Vendoring lock file that also carries the upstream version. */
const UPSTREAM_LOCK_FILE = 'superpowers.lock.json'

/** Raw inputs for {@link assembleBootstrap}. */
export interface BootstrapSource {
  /** `using-superpowers/SKILL.md` body with frontmatter already removed. */
  readonly skillBody: string
  /** Contents of `using-superpowers/references/dsh-tools.md`. */
  readonly toolMapping: string
}

/** One assembled bootstrap text plus its deduplication identity. */
export interface BootstrapResult {
  /** The complete model-facing text injected as one user message. */
  readonly text: string
  /** Hex-encoded SHA-256 of {@link text}, stored in the message source for deduplication. */
  readonly digest: string
  /** Upstream Superpowers version recorded in the version marker. */
  readonly version: string
  /** Byte length of {@link text}. */
  readonly bytes: number
  /** Whether the text was cut down to respect the configured byte bound. */
  readonly truncated: boolean
}

/** Options for {@link assembleBootstrap}. */
export interface AssembleBootstrapOptions {
  /** Upstream Superpowers version (for example `7.0.1`). */
  readonly version: string
  /** Upper bound for the produced text, in bytes. Defaults to 32 KiB. */
  readonly maxBytes?: number | undefined
}

/** Options for {@link loadBootstrap}. */
export interface LoadBootstrapOptions {
  /** Directory that contains `using-superpowers/SKILL.md`. */
  readonly skillsDir: string
  /** Upstream Superpowers version. */
  readonly version: string
  /** Upper bound for the produced text, in bytes. Defaults to 32 KiB. */
  readonly maxBytes?: number | undefined
}

const bootstrapCache = new Map<string, BootstrapResult>()

/**
 * Compute the hex SHA-256 digest of a UTF-8 string.
 * @param text - text to digest.
 * @returns hex-encoded digest.
 */
export function sha256Digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Read the two source documents that make up the bootstrap from a skills tree.
 * @param skillsDir - directory containing the `using-superpowers/` skill folder.
 * @returns the skill body (frontmatter removed) and the DSH tool mapping.
 * @throws when either bundled document is missing or unreadable.
 */
export function readBootstrapSource(skillsDir: string): BootstrapSource {
  const skillDir = join(skillsDir, BOOTSTRAP_SKILL_NAME)
  const skillPath = join(skillDir, 'SKILL.md')
  let skillRaw: string
  try {
    skillRaw = readFileSync(skillPath, 'utf8')
  } catch (error) {
    throw new Error(`superpowers: cannot read bootstrap skill "${skillPath}": ${String(error)}`, { cause: error })
  }
  const toolMappingPath = join(skillDir, DSH_TOOLS_REFERENCE)
  let toolMapping: string
  try {
    toolMapping = readFileSync(toolMappingPath, 'utf8')
  } catch (error) {
    throw new Error(`superpowers: cannot read DSH tool mapping "${toolMappingPath}": ${String(error)}`, { cause: error })
  }
  return { skillBody: parseSkillDocument(skillRaw).body, toolMapping }
}

/**
 * Assemble the complete bootstrap text from its two source documents.
 *
 * The output is the upstream Shape B block: an opening tag, the "you have
 * superpowers" preamble with a version marker, the skill body, the DSH tool
 * mapping, and the closing tag. When the text exceeds the byte bound it is cut
 * on a UTF-8 code-point boundary and an explicit truncation marker is appended,
 * so the injected text never silently loses its tail.
 *
 * @param source - the skill body and tool mapping.
 * @param options - upstream version and optional byte bound.
 * @returns the text, its digest, and truncation facts.
 */
export function assembleBootstrap(source: BootstrapSource, options: AssembleBootstrapOptions): BootstrapResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BOOTSTRAP_BYTES
  const versionMarker = `superpowers v${options.version} / dsh-adapter ${ADAPTER_REVISION}`
  const text = [
    BOOTSTRAP_OPEN_TAG,
    BOOTSTRAP_TEXT_MARKER,
    '',
    versionMarker,
    '',
    "**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. For all other skills, use the 'skill' tool (DeepSeek Harness native skill loader):**",
    '',
    source.skillBody.trim(),
    '',
    '**You are running on DeepSeek Harness (DSH). Translate every action this skill mentions into the DSH tool mapping below. The mapping is authoritative; never invent tool names.**',
    '',
    source.toolMapping.trim(),
    BOOTSTRAP_CLOSE_TAG,
    '',
  ].join('\n')
  const bounded = boundBootstrapText(text, maxBytes)
  return {
    text: bounded.text,
    digest: sha256Digest(bounded.text),
    version: options.version,
    bytes: Buffer.byteLength(bounded.text, 'utf8'),
    truncated: bounded.truncated,
  }
}

/**
 * Read the vendored upstream version from the package's `upstream/` metadata.
 *
 * The vendoring script writes `superpowers-version.txt` and a lock file; either
 * is sufficient. Missing metadata degrades to {@link UNKNOWN_UPSTREAM_VERSION}
 * instead of failing plugin load, because skills can still be registered.
 *
 * @param upstreamDir - the packaged `upstream/` directory.
 * @returns the upstream version, or `unknown` when no metadata is readable.
 */
export function readUpstreamVersion(upstreamDir: string): string {
  try {
    const text = readFileSync(join(upstreamDir, UPSTREAM_VERSION_FILE), 'utf8').trim()
    if (text !== '') return text
  } catch {
    // Fall through to the lock file.
  }
  try {
    const lock = JSON.parse(readFileSync(join(upstreamDir, UPSTREAM_LOCK_FILE), 'utf8')) as { version?: unknown }
    if (typeof lock.version === 'string' && lock.version !== '') return lock.version
  } catch {
    // Fall through to the unknown-version fallback.
  }
  return UNKNOWN_UPSTREAM_VERSION
}

/**
 * Read, assemble, and cache the bootstrap for one plugin configuration.
 *
 * Repeated calls with the same `(skillsDir, version, maxBytes)` key return the
 * exact cached result: the source documents are read once per process, matching
 * upstream's requirement to assemble the session-start context once.
 *
 * @param options - source directory, upstream version, and optional byte bound.
 * @returns the cached-or-fresh assembled bootstrap.
 * @throws when either bundled source document is missing.
 */
export function loadBootstrap(options: LoadBootstrapOptions): BootstrapResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BOOTSTRAP_BYTES
  const cacheKey = `${options.skillsDir}\u0000${options.version}\u0000${maxBytes}`
  const cached = bootstrapCache.get(cacheKey)
  if (cached !== undefined) return cached
  const result = assembleBootstrap(readBootstrapSource(options.skillsDir), { version: options.version, maxBytes })
  bootstrapCache.set(cacheKey, result)
  return result
}

/**
 * Drop the module-level bootstrap cache. Intended for tests and development
 * reloads; production code assembles once per plugin load.
 */
export function clearBootstrapCache(): void {
  bootstrapCache.clear()
}

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

function boundBootstrapText(text: string, maxBytes: number): BoundedText {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const marker = `\n\n[superpowers bootstrap truncated to ${maxBytes} bytes]`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes >= maxBytes) return { text: truncateUtf8(text, maxBytes), truncated: true }
  return { text: `${truncateUtf8(text, maxBytes - markerBytes)}${marker}`, truncated: true }
}

/** Cut a UTF-8 string to at most `maxBytes` bytes without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  let used = 0
  let out = ''
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    used += bytes
    out += character
  }
  return out
}
