# dsh-superpowers

[English](README.md) | [中文](README.zh.md)

Superpowers skills and per-session bootstrap for **DeepSeek Harness (DSH)**.
This package bundles [Superpowers](https://github.com/obra/superpowers) and
makes its skills available through DSH's native `skill` tool.

## Install

Download the package and its checksum from the latest release, verify it, and
install it into your DSH profile:

```sh
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/dsh-superpowers-0.0.1.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-0.0.1.tgz
```

Restart DeepSeek Harness; the plugin is active in new sessions.

## License

MIT. See [LICENSE](LICENSE). The bundled Superpowers skills are MIT,
© Jesse Vincent and Prime Radiant — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
