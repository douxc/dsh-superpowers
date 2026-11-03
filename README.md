# dsh-superpowers

[English](README.md) | [中文](README.zh.md)

Superpowers skills and per-session bootstrap for **DeepSeek Harness (DSH)**.

This package vendors [Superpowers](https://github.com/obra/superpowers) v7.0.1 and
integrates it natively: the 15 skills are registered with DSH's `skill` tool, and
the `using-superpowers` bootstrap is injected once per root session through the
`agent/pre-step` extension point — including after context compaction, and never
into subagent sessions.

The package is both a DSH plugin and a bundle layer (`dsh.bundle.patch`), so a
single `dsh plugin add` both installs the code and activates the `superpowers`
row.

## Requirements

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0` (declared as `engines.dsh` and peer
  dependencies).
- Node.js 20+.

## Install

```sh
# from npm (once published)
dsh plugin --profile web add dsh-superpowers

# from a release tarball or a local `pnpm pack` (no build permission needed)
dsh plugin --profile web add ./dsh-superpowers-0.1.0.tgz

# from a local checkout, linked for development
dsh plugin --profile web add /path/to/dsh-superpowers

# from GitHub (the first add is blocked until you allow the build)
dsh plugin --profile web add github:douxc/dsh-superpowers
```

A Git install fetches sources, so pnpm must run this package's `prepare` build
(`tsc`). pnpm >= 10 refuses that until you allow it: the command above fails
with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and prints the exact key. Add that
key under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then re-run the
same command:

```yaml
allowBuilds:
  'dsh-superpowers@git+ssh://git@github.com/douxc/dsh-superpowers.git#<commit>': true
```

The key contains `#`, so keep it quoted. Pin a commit
(`github:douxc/dsh-superpowers#<sha>`) so later pushes cannot change the code
that runs at install time, and only allow builds for packages you trust.
Tarball and npm installs ship prebuilt `lib/` and need no build permission.

`dsh plugin add` appends the bundle to the profile's `dsh.profile.bundles`
automatically. Restart the app, then open a **new** session.

Verify the layer without booting:

```sh
dsh --profile web --dump-config | grep -A2 'dsh-superpowers'
```

### Install from a release tarball

Every published GitHub release attaches the built package archive
(`dsh-superpowers-<version>.tgz`) plus a `SHA256SUMS` file. The archive is
produced from the tagged commit by
[`.github/workflows/release-tarball.yml`](.github/workflows/release-tarball.yml),
so it contains the compiled `lib/` and needs no build permission:

```sh
# replace the version with the release you want (see the Releases page)
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/dsh-superpowers-0.1.0.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-0.1.0.tgz
```

You can build the same archive locally from a checkout with
`pnpm install && pnpm pack`.

A tarball install is the offline/frozen alternative to a Git install: the file
is already built, pins exactly one hashed artifact, and never asks for
`allowBuilds` (that permission is only for Git installs that must run
`prepare`).

## What it does

1. **Registers the 15 bundled skills** (`brainstorming`, `writing-plans`,
   `test-driven-development`, `systematic-debugging`, …) as DSH runtime skills.
   DSH shows their name + description in the session skill catalog, and the
   model loads a full body with the native `skill` tool. Skill resources
   (`references/`, `scripts/`, `prompts/`) stay next to each `SKILL.md`.
2. **Injects the Superpowers bootstrap once per root session** as a
   user-role message: the full `using-superpowers` skill body plus the
   DSH-specific tool mapping. Deduplication is tracked by the message source
   (`kind: superpowers-bootstrap`, content digest), so later steps, resumed
   sessions, and forked sessions do not double-inject.
3. **Re-injects after compaction**: when a compaction replaces the message
   range that contained the bootstrap, the next step detects that the bootstrap
   is no longer visible and publishes it again.
4. **Skips subagent sessions**, detected from the durable
   `session.header.delegationDepth` (with the runtime `subagentDepth` folded in).

## Configure

Plugin options live in the profile's `cordis.patch.yml` (or any `--patch`
overlay), keyed by the row id `superpowers`:

```yaml
- id: superpowers
  config:
    disableBootstrap: true   # keep the skills, skip the per-session injection
    maxBootstrapBytes: 32768 # cap for the assembled bootstrap text
    # skillsDir: /custom/skills   # override the bundled skills directory
```

Restart the app after editing the profile layer.

## Disable / uninstall

```sh
dsh plugin --profile web remove dsh-superpowers
```

Disabling the bundle unregisters the skills and the injector; sessions that
already received a bootstrap keep that message in their history.

## Maintenance: updating the vendored skills

The `skills/` tree is vendored byte-for-byte from the pinned upstream tag
(recorded in [upstream/superpowers.lock.json](upstream/superpowers.lock.json),
with a per-file sha256 manifest). To update:

```sh
git clone https://github.com/obra/superpowers /tmp/superpowers
pnpm install
pnpm run vendor:superpowers -- --from /tmp/superpowers
pnpm test          # includes an offline lock/content verification test
```

Review the upstream `RELEASE-NOTES.md` diff before committing, and run a real
DSH session afterwards. The only file added to the upstream tree is
[`skills/using-superpowers/references/dsh-tools.md`](skills/using-superpowers/references/dsh-tools.md)
(the DSH tool mapping); no upstream `SKILL.md` is edited.

## Known Limitations and Deferred Work

- After a `context-overflow` compaction, the single retry request in the same
  step runs before the next `agent/pre-step`; that one request can lack the
  bootstrap. The following step re-injects it.
- Updating this package does not rewrite the bootstrap of an existing session;
  a session keeps the version it already saw until compaction clears it (then
  the current bundled version is re-injected).
- No `.npmrc`/registry mirror is bundled; install from the default npm registry
  or a tarball/Git source.
- Skills are prompt content, not sandboxed code: read
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and review the vendored
  sources before enabling in a sensitive workspace.

## License

MIT. The vendored Superpowers skills are MIT, © Jesse Vincent and Prime
Radiant — see [upstream/LICENSE-superpowers](upstream/LICENSE-superpowers) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
