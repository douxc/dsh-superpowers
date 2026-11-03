/**
 * dsh-superpowers — Superpowers skills and per-session bootstrap for DeepSeek Harness.
 *
 * The package is both a DSH plugin (this module) and a bundle layer
 * (`cordis.patch.yml`), so installing it as a bundle inserts the `superpowers`
 * row that loads this module.
 *
 * `apply()` does two independent things, each with its own failure mode:
 *
 * 1. Scans the packaged `skills/` tree and registers every vendored skill as a
 *    runtime skill (rank 250). A malformed skill only logs a warning.
 * 2. Assembles the bootstrap text from the packaged `using-superpowers` skill
 *    and its DSH tool mapping, then registers the `agent/pre-step` injector.
 *    Missing or unreadable assets disable only this half of the plugin.
 *
 * Neither half may throw from `apply()`: a plugin load failure would break the
 * whole session, while degraded-but-loadable is always preferable.
 *
 * @module dsh-superpowers
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_MAX_BOOTSTRAP_BYTES,
  loadBootstrap,
  readUpstreamVersion,
} from './bootstrap.js'
import { createBootstrapListener } from './injection.js'
import { bundledSkillsDir, bundledUpstreamDir } from './paths.js'
import { registerBundledSkills } from './skills.js'

/** Plugin name used by the bundle row (`id: superpowers`). */
export const name = 'superpowers'

/** Services this plugin requires; the skill registry must be mounted first. */
export const inject: readonly string[] = ['skills']

/** Plugin configuration. */
export interface Config {
  /** Disable bootstrap injection while keeping the skills registered. */
  disableBootstrap?: boolean
  /** Override the bundled skills directory (development and tests). */
  skillsDir?: string
  /** Upper bound for the injected bootstrap text, in bytes. */
  maxBootstrapBytes?: number
}

export const Config: z<Config> = z.object({
  disableBootstrap: z.boolean().default(false),
  skillsDir: z.string(),
  maxBootstrapBytes: z.number().default(DEFAULT_MAX_BOOTSTRAP_BYTES),
})

/**
 * Register the bundled skills and the session bootstrap injector.
 * @param ctx - the plugin fiber context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const skillsDir = config.skillsDir ?? bundledSkillsDir()
  const version = readUpstreamVersion(bundledUpstreamDir())

  registerBundledSkills(ctx, { root: skillsDir, version })

  let bootstrap
  try {
    bootstrap = loadBootstrap({
      skillsDir,
      version,
      ...(config.maxBootstrapBytes === undefined ? {} : { maxBytes: config.maxBootstrapBytes }),
    })
  } catch (error) {
    ctx.logger.warn(`superpowers: bootstrap injection disabled: ${String(error)}`)
    return
  }

  ctx.on('agent/pre-step', createBootstrapListener({
    bootstrapText: bootstrap.text,
    digest: bootstrap.digest,
    version: bootstrap.version,
    disable: config.disableBootstrap === true,
  }))
}
