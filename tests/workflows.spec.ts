import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Structural checks for the release automation workflows.
 *
 * GitHub only validates the full semantics at run time, so these tests pin the
 * parts the release design depends on: triggers, token permissions, command
 * order (tests before publishing), the fixed nightly asset names, and the
 * explicit workflow dispatch that works around GITHUB_TOKEN event suppression.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WORKFLOW_DIR = join(ROOT, '.github/workflows')

interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

interface Workflow {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as Workflow
}

function firstJobSteps(workflow: Workflow): WorkflowStep[] {
  const jobs = workflow.jobs ?? {}
  const job = Object.values(jobs)[0]
  return job?.steps ?? []
}

function shell(workflow: Workflow): string {
  return firstJobSteps(workflow)
    .map((step) => step.run ?? '')
    .join('\n')
}

describe('nightly workflow', () => {
  const workflow = loadWorkflow('nightly.yml')

  it('runs daily and can be dispatched manually', () => {
    const schedule = workflow.on?.schedule as { cron?: string }[] | undefined
    expect(schedule?.[0]?.cron).toBe('0 0 * * *')
    expect(workflow.on).toHaveProperty('workflow_dispatch')
  })

  it('can write releases and serializes runs', () => {
    expect(workflow.permissions?.contents).toBe('write')
    expect(workflow.concurrency?.group).toBe('nightly')
  })

  it('skips the build when upstream main has not moved', () => {
    const steps = firstJobSteps(workflow)
    expect(steps.some((step) => step.if?.includes("steps.decide.outputs.skip != 'true'"))).toBe(true)
    expect(shell(workflow)).toContain('upstream-sha')
  })

  it('runs the build chain in order and only publishes after tests', () => {
    const runs = shell(workflow)
    const order = [
      'pnpm install --frozen-lockfile',
      'next-versions.ts nightly',
      'vendor:superpowers',
      'sync:vendor-docs',
      'pnpm test',
      'pnpm pack',
      'gh release upload nightly',
    ]
    for (let index = 1; index < order.length; index += 1) {
      expect(runs.indexOf(order[index - 1]!), order[0]).toBeGreaterThanOrEqual(0)
      expect(runs.indexOf(order[index]!), order[index]).toBeGreaterThan(
        runs.indexOf(order[index - 1]!),
      )
    }
  })

  it('publishes the fixed nightly asset names and moves the nightly tag', () => {
    const runs = shell(workflow)
    expect(runs).toContain('dsh-superpowers-nightly.tgz')
    expect(runs).toContain('SHA256SUMS')
    expect(runs).toContain('gh release upload nightly')
    expect(runs).toContain('--clobber')
    expect(runs).toContain('gh release create nightly --prerelease')
    expect(runs).toContain('git tag -f nightly')
    expect(runs).toContain('refs/tags/nightly')
  })
})

describe('upstream-release workflow', () => {
  const workflow = loadWorkflow('upstream-release.yml')

  it('checks daily with a dry-run switch', () => {
    const schedule = workflow.on?.schedule as { cron?: string }[] | undefined
    expect(schedule?.[0]?.cron).toBe('0 1 * * *')
    const dispatch = workflow.on?.workflow_dispatch as
      | { inputs?: Record<string, { type?: string }> }
      | undefined
    expect(dispatch?.inputs?.dry_run?.type).toBe('boolean')
  })

  it('can open pull requests', () => {
    expect(workflow.permissions?.contents).toBe('write')
    expect(workflow.permissions?.['pull-requests']).toBe('write')
    expect(workflow.concurrency?.group).toBe('upstream-release')
  })

  it('vendors the new tag and opens a reviewable PR', () => {
    const runs = shell(workflow)
    for (const command of [
      'ls-remote --tags',
      'next-versions.ts latest-tag',
      'next-versions.ts newer',
      'vendor:superpowers',
      'sync:vendor-docs',
      'pnpm test',
      'gh pr create',
      'upstream/superpowers-',
      'RELEASE-NOTES.md',
    ]) {
      expect(runs, `workflow must contain ${command}`).toContain(command)
    }
  })

  it('does not push when dry_run is requested', () => {
    const steps = firstJobSteps(workflow)
    expect(steps.some((step) => step.if?.includes("dry_run != 'true'"))).toBe(true)
  })
})

describe('release-on-version-bump workflow', () => {
  const workflow = loadWorkflow('release-on-version-bump.yml')

  it('runs for pushes to main', () => {
    const push = workflow.on?.push as { branches?: string[] } | undefined
    expect(push?.branches).toContain('main')
  })

  it('can create tags, releases and dispatch workflows', () => {
    expect(workflow.permissions?.contents).toBe('write')
    expect(workflow.permissions?.actions).toBe('write')
    expect(workflow.concurrency?.group).toBe('release-on-version-bump')
  })

  it('is idempotent per version and publishes through an explicit dispatch', () => {
    const runs = shell(workflow)
    for (const command of [
      'ls-remote --tags',
      'git tag -a',
      'git push origin',
      'gh release create',
      '--verify-tag',
      'gh workflow run release-tarball.yml',
      '-f tag=',
    ]) {
      expect(runs, `workflow must contain ${command}`).toContain(command)
    }
    const steps = firstJobSteps(workflow)
    expect(steps.some((step) => step.if?.includes("steps.tag.outputs.exists == 'false'"))).toBe(true)
  })
})

describe('release-tarball workflow', () => {
  const workflow = loadWorkflow('release-tarball.yml')

  it('can be dispatched for an existing release tag', () => {
    const dispatch = workflow.on?.workflow_dispatch as
      | { inputs?: Record<string, unknown> }
      | undefined
    expect(dispatch?.inputs).toHaveProperty('tag')
  })

  it('attaches the versioned tarball and checksums to that release', () => {
    const runs = shell(workflow)
    expect(runs).toContain('gh release upload')
    expect(runs).toContain('--clobber')
    expect(runs).toContain('SHA256SUMS')
  })
})
