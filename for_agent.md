# Install with an agent

Runbook for an AI coding agent asked to install or update `dsh-superpowers` in
DeepSeek Harness (DSH). Follow the human's instructions first; ask before
running installer steps they did not request.

## Facts

- Repository: <https://github.com/douxc/dsh-superpowers> (public).
- Profile: `web` unless the human names another; pass `--profile <name>`.
- DSH home: `$DSH_HOME` (default `~/.dsh`). The running app composes its plugins
  at process start, so an install needs a restart to take effect.
- CLI: `dsh …`. From a source checkout, use `pnpm dsh …` instead.
- Offline installs are prebuilt and hash-verified; prefer them. Online installs
  fetch the source and run the package's build script, which needs explicit
  build permission.

## Offline install (recommended)

1. Resolve the latest release and download its two assets:

```sh
tag=$(curl -fsSL https://api.github.com/repos/douxc/dsh-superpowers/releases/latest \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).tag_name")
version=${tag#v}
curl -fLO "https://github.com/douxc/dsh-superpowers/releases/download/$tag/dsh-superpowers-$version.tgz"
curl -fLO "https://github.com/douxc/dsh-superpowers/releases/download/$tag/SHA256SUMS"
```

2. Verify the archive: `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`).
3. Install it into the profile:
   `dsh plugin --profile web add "./dsh-superpowers-$version.tgz"`
4. Verify the bundle layer is composed:

```sh
dsh --profile web --dump-config | grep -A2 'dsh-superpowers'
```

Expected: a `# == dsh-superpowers` layer line and `- id: superpowers`.
5. Ask the human to restart DSH. Do not kill or restart the running app yourself.

## Online install (GitHub source)

1. `dsh plugin --profile web add github:douxc/dsh-superpowers`
2. If pnpm fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, copy the exact
   `allowBuilds` line it prints into
   `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` (quote the key; it contains
   `#`), then re-run step 1.
3. Verify as in offline step 4; ask the human to restart.

## Update

- Offline: repeat the download and run `dsh plugin add` with the new filename.
- Online: re-run `dsh plugin --profile web add github:douxc/dsh-superpowers`.
  pnpm prints a new `allowBuilds` line for the new commit — replace the old one.

## Checks and failure modes

| Symptom | Cause / fix |
|---|---|
| `dsh: command not found` | run from the DSH source checkout: `pnpm dsh …` |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | the install runs a build script; add the printed line and retry |
| `--dump-config` shows no `dsh-superpowers` | wrong profile name, or `add` did not complete |
| install succeeds but nothing changes | restart DSH; composition is built at process start |
| checksum mismatch | re-download the asset from the release page; do not install |

## Limits

- The agent can prove the plugin is installed and composed, not that the running
  process is using it; do not claim success before the human restarts.
- Never hand-copy `skills/` files, never edit files outside the profile's
  `pnpm-workspace.yaml` / `dsh.profile.bundles`, and never restart the app
  without the human's request.
