# dsh-superpowers

[English](README.md) | 中文

面向 **DeepSeek Harness（DSH）** 的 Superpowers 技能与每会话引导。
本包内置 [Superpowers](https://github.com/obra/superpowers) 的技能，
并通过 DSH 原生的 `skill` 工具提供。

## 安装

从最新 Release 下载安装包与校验和，校验后安装到 DSH profile：

```sh
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/dsh-superpowers-0.0.1.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-0.0.1.tgz
```

重启 DeepSeek Harness，新会话即生效。

## 许可

MIT。见 [LICENSE](LICENSE)。内置的 Superpowers 技能为 MIT，© Jesse Vincent
与 Prime Radiant——见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
