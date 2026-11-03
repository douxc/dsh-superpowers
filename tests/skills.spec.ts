import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import {
  parseSkillDocument,
  registerBundledSkills,
  SKILL_METADATA_UPSTREAM,
  type SkillRegistrationHost,
} from '../src/skills.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a temp skills root where each key is a skill directory and each value its SKILL.md (or a directory-only entry). */
function makeSkillsRoot(skills: Record<string, string | undefined>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superpowers-skills-'))
  tempDirs.push(root)
  for (const [name, document] of Object.entries(skills)) {
    mkdirSync(join(root, name), { recursive: true })
    if (document !== undefined) writeFileSync(join(root, name, 'SKILL.md'), document)
  }
  return root
}

interface HostFixture {
  readonly host: SkillRegistrationHost
  readonly registrations: SkillRegistration[]
  readonly warnings: string[]
}

/** Build a fake registration host that records registrations and warnings. */
function fakeHost(options: { failOn?: string } = {}): HostFixture {
  const registrations: SkillRegistration[] = []
  const warnings: string[] = []
  return {
    registrations,
    warnings,
    host: {
      skills: {
        register: (skill: SkillRegistration) => {
          if (skill.name === options.failOn) throw new Error('duplicate skill name')
          registrations.push(skill)
          return () => {}
        },
      },
      logger: { warn: (message: string) => { warnings.push(message) } },
    },
  }
}

const ALPHA_DOCUMENT = [
  '---',
  'name: alpha-skill',
  'description: "Alpha: quoted description"',
  'allowed-tools: bash',
  '---',
  '',
  '# Alpha skill',
  '',
  'Do the alpha thing.',
  '',
].join('\n')

const BETA_DOCUMENT = [
  '---',
  'name: beta-skill',
  `description: Use when "beta" happens - a plain scalar value`,
  '---',
  '',
  '# Beta skill',
].join('\n')

describe('registerBundledSkills', () => {
  it('registers every valid vendored skill with parsed metadata and its directory resource base', () => {
    const root = makeSkillsRoot({
      'beta-skill': BETA_DOCUMENT,
      'alpha-skill': ALPHA_DOCUMENT,
      '.hidden': ALPHA_DOCUMENT,
    })
    const fixture = fakeHost()

    const registered = registerBundledSkills(fixture.host, { root, version: '7.0.1' })

    expect(fixture.warnings).toEqual([])
    expect(registered.map(skill => skill.name)).toEqual(['alpha-skill', 'beta-skill'])
    expect(fixture.registrations).toHaveLength(2)

    const alpha = fixture.registrations[0]!
    expect(alpha.name).toBe('alpha-skill')
    expect(alpha.description).toBe('Alpha: quoted description')
    expect(alpha.content).toBe('# Alpha skill\n\nDo the alpha thing.\n')
    expect(alpha.content).not.toContain('---')
    expect(alpha.content).not.toContain('allowed-tools')
    expect(alpha.resourceBase).toEqual({ kind: 'directory', path: join(root, 'alpha-skill') })
    expect(alpha.metadata).toEqual({ upstream: SKILL_METADATA_UPSTREAM, version: '7.0.1' })
    expect(alpha.source).toBe('runtime')

    const beta = fixture.registrations[1]!
    expect(beta.name).toBe('beta-skill')
    expect(beta.description).toBe('Use when "beta" happens - a plain scalar value')
    expect(beta.content).toBe('# Beta skill')
  })

  it('skips malformed directories with a warning and never throws', () => {
    const root = makeSkillsRoot({
      'alpha-skill': ALPHA_DOCUMENT,
      'Bad_Name': '---\nname: Bad_Name\ndescription: non-kebab name\n---\nbody\n',
      'mismatch-skill': '---\nname: other-skill\ndescription: name does not match directory\n---\nbody\n',
      'no-document': undefined,
      'no-description': '---\nname: no-description\n---\nbody\n',
      'no-frontmatter': '# just a heading\n',
      'unterminated': '---\nname: unterminated\ndescription: never closes\n',
    })
    const fixture = fakeHost()

    const registered = registerBundledSkills(fixture.host, { root, version: '7.0.1' })

    expect(registered.map(skill => skill.name)).toEqual(['alpha-skill'])
    expect(fixture.registrations.map(skill => skill.name)).toEqual(['alpha-skill'])
    expect(fixture.warnings.length).toBeGreaterThanOrEqual(6)
    expect(fixture.warnings.some(message => message.includes('no-document'))).toBe(true)
    expect(fixture.warnings.some(message => message.includes('Bad_Name'))).toBe(true)
    expect(fixture.warnings.some(message => message.includes('unterminated'))).toBe(true)
  })

  it('warns and returns nothing when the skills root cannot be read', () => {
    const root = join(tmpdir(), 'dsh-superpowers-does-not-exist', String(Date.now()))
    const fixture = fakeHost()

    expect(() => registerBundledSkills(fixture.host, { root, version: '7.0.1' })).not.toThrow()
    expect(registerBundledSkills(fixture.host, { root, version: '7.0.1' })).toEqual([])
    expect(fixture.warnings).toHaveLength(2)
    expect(fixture.warnings[0]).toContain('cannot read skills directory')
  })

  it('contains a registration failure to the affected skill', () => {
    const root = makeSkillsRoot({ 'alpha-skill': ALPHA_DOCUMENT, 'beta-skill': BETA_DOCUMENT })
    const fixture = fakeHost({ failOn: 'alpha-skill' })

    const registered = registerBundledSkills(fixture.host, { root, version: '7.0.1' })

    expect(registered.map(skill => skill.name)).toEqual(['beta-skill'])
    expect(fixture.warnings).toHaveLength(1)
    expect(fixture.warnings[0]).toContain('cannot register skill "alpha-skill"')
  })
})

describe('parseSkillDocument', () => {
  it('parses plain and quoted single-line scalar forms', () => {
    expect(parseSkillDocument(ALPHA_DOCUMENT).frontmatter).toEqual({
      name: 'alpha-skill',
      description: 'Alpha: quoted description',
    })
    expect(parseSkillDocument(BETA_DOCUMENT).frontmatter.description)
      .toBe('Use when "beta" happens - a plain scalar value')
    expect(parseSkillDocument("---\nname: a\ndescription: 'it''s single quoted'\n---\n").frontmatter.description)
      .toBe("it's single quoted")
    expect(parseSkillDocument('---\nname: a\ndescription: "line\\nwith \\"quotes\\" and \\\\slash"\n---\n').frontmatter.description)
      .toBe('line\nwith "quotes" and \\slash')
  })

  it('removes the frontmatter block and the blank line after it from the body', () => {
    expect(parseSkillDocument(ALPHA_DOCUMENT).body).toBe('# Alpha skill\n\nDo the alpha thing.\n')
    expect(parseSkillDocument('---\nname: a\ndescription: d\n---\n# body\n').body).toBe('# body\n')
  })

  it('handles CRLF and a UTF-8 BOM', () => {
    const document = '\uFEFF---\r\nname: crlf-skill\r\ndescription: windows line endings\r\n---\r\n\r\n# Body\r\n'
    expect(parseSkillDocument(document).frontmatter).toEqual({
      name: 'crlf-skill',
      description: 'windows line endings',
    })
    expect(parseSkillDocument(document).body).toBe('# Body\n')
  })

  it('returns an empty frontmatter and the unchanged text when there is no frontmatter', () => {
    const document = parseSkillDocument('# Heading\n\nBody\n')
    expect(document.frontmatter).toEqual({})
    expect(document.body).toBe('# Heading\n\nBody\n')
  })

  it('ignores frontmatter keys other than name and description', () => {
    const document = parseSkillDocument('---\nname: a\ndescription: d\nallowed-tools: bash\nwhen_to_use: x\n---\n')
    expect(document.frontmatter).toEqual({ name: 'a', description: 'd' })
  })

  it('throws on an unterminated frontmatter block', () => {
    expect(() => parseSkillDocument('---\nname: a\ndescription: d\n')).toThrow('unterminated YAML frontmatter')
  })
})
