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
