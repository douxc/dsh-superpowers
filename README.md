# dsh-superpowers

[English](README.md) | [中文](README.zh.md)

Superpowers skills and per-session bootstrap for **DeepSeek Harness (DSH)**.
This package bundles [Superpowers](https://github.com/obra/superpowers) and
makes its skills available through DSH's native `skill` tool.

## Install

### Online (GitHub)

Install directly from the repository:

```sh
dsh plugin --profile web add github:douxc/dsh-superpowers
```

The first install is blocked: pnpm must run the package's build script and needs
your permission. It prints the exact `allowBuilds` line — paste it into the
profile's `pnpm-workspace.yaml`, then run the same command again.

Update by running the same command again; pnpm prints a new line for the new
commit, so refresh that line too.

### Offline (release tarball)

Download the package and its checksum from a release, verify them, then install:

```sh
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/dsh-superpowers-0.0.1.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-0.0.1.tgz
```

Update by downloading the newer release's files and running `dsh plugin add`
with the new filename.

### Use with an agent

An AI agent can run the install and verification itself; the runbook with
commands, checks and failure modes is in [for_agent.md](for_agent.md).

Restart DeepSeek Harness; the plugin is active in new sessions.

## License

MIT. See [LICENSE](LICENSE). The bundled Superpowers skills are MIT,
© Jesse Vincent and Prime Radiant — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
