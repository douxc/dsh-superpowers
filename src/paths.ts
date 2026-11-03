/**
 * Package-relative asset paths.
 *
 * Asset locations are resolved against `import.meta.url` so they work in the
 * two layouts this package runs in: the TypeScript sources under `src/` during
 * tests and the built JavaScript under `lib/` after `pnpm build`. Both
 * directories sit one level below the package root, so `../skills/` and
 * `../upstream/` always name the packaged asset directories
 * (`packages/experimental/skill-badge` uses the same pattern).
 *
 * @module dsh-superpowers/paths
 */

import { fileURLToPath } from 'node:url'

/**
 * Absolute path of the packaged `skills/` directory.
 * @returns the directory that holds the vendored `skills/<name>/SKILL.md` tree.
 */
export function bundledSkillsDir(): string {
  return fileURLToPath(new URL('../skills/', import.meta.url))
}

/**
 * Absolute path of the packaged `upstream/` metadata directory.
 * @returns the directory that holds the vendoring lock and the upstream version marker.
 */
export function bundledUpstreamDir(): string {
  return fileURLToPath(new URL('../upstream/', import.meta.url))
}
