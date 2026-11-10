# Third-Party Notices

`dsh-superpowers` is licensed under [MIT](LICENSE). It redistributes the third-party
content listed below. Each project remains under its own license; nothing in this file
changes those terms.

## Superpowers

Superpowers v7.0.2 is MIT-licensed and is redistributed as part of this package.

| Item | Value |
| --- | --- |
| Project | Superpowers |
| Upstream | <https://github.com/obra/superpowers> |
| Version | 7.0.2 (pinned) |
| License | MIT |
| Copyright | (c) 2025 Jesse Vincent |
| License text | [`upstream/LICENSE-superpowers`](upstream/LICENSE-superpowers) |
| Vendored tree | [`skills/`](skills/) — 15 skill directories, 80 files |
| Pin metadata | [`upstream/superpowers.lock.json`](upstream/superpowers.lock.json), [`upstream/superpowers-version.txt`](upstream/superpowers-version.txt) |

The files under `skills/` are copied **byte-for-byte** from the pinned upstream commit
recorded as `ref` in `upstream/superpowers.lock.json` (commit
`22f0b463e7a5e579904dd6211a520321035526f7`, tag `v7.0.2`). No upstream file is modified
locally. The lock records a SHA-256 hash per file plus an aggregate hash, and
`tests/vendor.spec.ts` recomputes both on every test run, so hand edits and stale vendor
runs fail the test lane. Only `skills/` and the upstream `LICENSE` are redistributed; the
upstream hooks, runtime plugins and harness-specific adapters are **not** vendored.

### Local addition (`addedFiles`)

One file is authored by this project and is **not** upstream Superpowers content:

- [`skills/using-superpowers/references/dsh-tools.md`](skills/using-superpowers/references/dsh-tools.md)
  — DeepSeek Harness tool mapping. Its source of truth is
  [`assets/dsh-tools.md`](assets/dsh-tools.md); the vendored copy is re-materialized by
  `scripts/vendor-superpowers.ts` and listed in the lock's `addedFiles` array, which keeps
  it out of the upstream per-file hash set. It is licensed together with this package under
  MIT.

### Updating

`pnpm exec tsx scripts/vendor-superpowers.ts --from <local-clone>` refreshes `skills/` and
the lock from a local clone of the pinned upstream repository (default clone path:
`/tmp/superpowers-research`). After updating, review the upstream release notes, refresh
the version in the table above, and run `pnpm exec vitest run tests/vendor.spec.ts`.
