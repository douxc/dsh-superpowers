/**
 * Bundled skill discovery and registration.
 *
 * The plugin ships the upstream Superpowers skills verbatim under
 * `skills/<name>/SKILL.md` and registers each one as a runtime skill
 * (`ctx.skills.register()`, rank 250) instead of configuring another
 * filesystem provider: the path is derived from `import.meta.url`, content and
 * version are owned by the plugin, and registration is independently
 * fault-tolerant so one malformed vendored file can never fail plugin load.
 *
 * @module dsh-superpowers/skills
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isSkillName, type SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Provenance recorded in every registered skill's metadata. */
export const SKILL_METADATA_UPSTREAM = 'superpowers'

/** File name of the skill document inside one skill directory. */
export const SKILL_DOCUMENT_NAME = 'SKILL.md'

/** The subset of one skill's YAML frontmatter this plugin understands. */
export interface SkillFrontmatter {
  /** Skill identifier; must equal the containing directory name and be kebab-case. */
  readonly name?: string
  /** One-line routing description shown by the skill catalog. */
  readonly description?: string
}

/** One skill document split into its parsed frontmatter and its Markdown body. */
export interface ParsedSkillDocument {
  /** The fields this plugin reads from the YAML frontmatter. */
  readonly frontmatter: SkillFrontmatter
  /** The Markdown body with the frontmatter block removed. */
  readonly body: string
}

/**
 * Host services used by skill registration.
 *
 * Narrowed from {@link import('@deepseek-ai/cordis').Context} so the scanner can
 * be unit-tested with plain fakes; a real context satisfies it structurally.
 */
export interface SkillRegistrationHost {
  /** The skill registry (`ctx.skills`). */
  readonly skills: {
    register(skill: SkillRegistration): () => void
  }
  /** The logger (`ctx.logger`); only warnings are emitted. */
  readonly logger: {
    warn(message: string): void
  }
}

/** Options for {@link registerBundledSkills}. */
export interface RegisterBundledSkillsOptions {
  /** Directory that contains the `skills/<name>/` folders. */
  readonly root: string
  /** Upstream Superpowers version recorded in skill metadata. */
  readonly version: string
}

/** One skill successfully registered from disk. */
export interface RegisteredSkill {
  /** Validated kebab-case skill name. */
  readonly name: string
  /** Validated non-empty description. */
  readonly description: string
  /** Markdown body without the YAML frontmatter block. */
  readonly content: string
  /** Absolute skill directory backing relative `references/`/`scripts/` resources. */
  readonly directory: string
}

interface FrontmatterScan {
  readonly frontmatter: SkillFrontmatter
  readonly body: string
}

/**
 * Split a `SKILL.md` document into parsed frontmatter and Markdown body.
 *
 * Only `name` and `description` are extracted; every other frontmatter field
 * (for example upstream's platform-specific keys) is ignored. Both plain and
 * single-line quoted scalars are accepted, matching the vendored upstream
 * documents. A document without a leading `---` block has an empty
 * frontmatter and its whole text as the body; an unterminated block is
 * malformed and throws.
 *
 * @param raw - the complete file contents, UTF-8 decoded.
 * @returns the parsed fields plus the body with the frontmatter removed.
 * @throws when the document opens a frontmatter block that never closes.
 */
export function parseSkillDocument(raw: string): ParsedSkillDocument {
  const text = stripBom(raw).replaceAll('\r\n', '\n')
  const scan = scanFrontmatter(text)
  return {
    frontmatter: scan.frontmatter,
    body: stripLeadingBlankLine(scan.body),
  }
}

/**
 * Scan all `SKILL.md` documents under `root` and register each valid skill.
 *
 * A directory is skipped (with a warning) when its `SKILL.md` is missing or
 * unreadable, its frontmatter lacks a usable name or description, its name is
 * not kebab-case, or its name differs from the directory name. Registration
 * errors (for example a duplicate skill name) are also caught per directory.
 * The function never throws: plugin load must not be blocked by bad assets.
 *
 * @param host - the narrowed context services (`ctx.skills`, `ctx.logger`).
 * @param options - asset root and the upstream version to record in metadata.
 * @returns the skills that were registered, sorted by name.
 */
export function registerBundledSkills(
  host: SkillRegistrationHost,
  options: RegisterBundledSkillsOptions,
): RegisteredSkill[] {
  let entries
  try {
    entries = readdirSync(options.root, { withFileTypes: true })
  } catch (error) {
    host.logger.warn(`superpowers: cannot read skills directory "${options.root}": ${String(error)}`)
    return []
  }

  const registered: RegisteredSkill[] = []
  const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of ordered) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const directory = join(options.root, entry.name)
    let raw: string
    try {
      raw = readFileSync(join(directory, SKILL_DOCUMENT_NAME), 'utf8')
    } catch (error) {
      host.logger.warn(`superpowers: skipping skill "${entry.name}": cannot read ${SKILL_DOCUMENT_NAME}: ${String(error)}`)
      continue
    }

    let document: ParsedSkillDocument
    try {
      document = parseSkillDocument(raw)
    } catch (error) {
      host.logger.warn(`superpowers: skipping malformed skill "${entry.name}": ${String(error)}`)
      continue
    }

    const { name, description } = document.frontmatter
    if (typeof name !== 'string' || name !== entry.name || !isSkillName(name)) {
      host.logger.warn(`superpowers: skipping malformed skill "${entry.name}": frontmatter name ${JSON.stringify(name)} does not match a kebab-case directory name`)
      continue
    }
    if (typeof description !== 'string' || description.trim() === '') {
      host.logger.warn(`superpowers: skipping malformed skill "${entry.name}": missing description`)
      continue
    }

    try {
      host.skills.register({
        name,
        description,
        content: document.body,
        resourceBase: { kind: 'directory', path: directory },
        // `SkillRegistration` requires the origin bucket; the registry still
        // files this under its runtime rank (250) regardless of the value.
        source: 'runtime',
        metadata: { upstream: SKILL_METADATA_UPSTREAM, version: options.version },
      })
    } catch (error) {
      host.logger.warn(`superpowers: cannot register skill "${name}": ${String(error)}`)
      continue
    }
    registered.push({ name, description, content: document.body, directory })
  }
  return registered
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
}

function scanFrontmatter(text: string): FrontmatterScan {
  const frontmatter: { name?: string; description?: string } = {}
  const lines = text.split('\n')
  if (lines[0] !== '---') return { frontmatter, body: text }

  let closingIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trimEnd() === '---') {
      closingIndex = index
      break
    }
  }
  if (closingIndex === -1) throw new Error('unterminated YAML frontmatter')

  for (const line of lines.slice(1, closingIndex)) {
    const match = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    if (key === undefined || rawValue === undefined) continue
    if (key === 'name') frontmatter.name = parseScalar(rawValue)
    else if (key === 'description') frontmatter.description = parseScalar(rawValue)
  }
  return { frontmatter, body: lines.slice(closingIndex + 1).join('\n') }
}

/** Decode the supported YAML scalar forms into a plain string. */
function parseScalar(rawValue: string): string {
  const value = rawValue.trim()
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return value
    return value.slice(1, -1)
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return value
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function stripLeadingBlankLine(body: string): string {
  return body.startsWith('\n') ? body.slice(1) : body
}
