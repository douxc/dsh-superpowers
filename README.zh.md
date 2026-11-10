# dsh-superpowers

[English](README.md) | 中文

面向 **DeepSeek Harness（DSH）** 的 Superpowers 技能与每会话引导。
本包内置 [Superpowers](https://github.com/obra/superpowers) 的技能，
并通过 DSH 原生的 `skill` 工具提供。

## 安装

### 在线（GitHub）

直接从仓库安装：

```sh
dsh plugin --profile web add github:douxc/dsh-superpowers
```

首次安装会被拦下：pnpm 需要执行本包的构建脚本，必须先得到你的允许。它会打印
需要添加的 `allowBuilds` 行——把它贴进 profile 的 `pnpm-workspace.yaml`，再执行
同一条命令。

更新时重新执行同一条命令即可；pnpm 会为新 commit 打印新的行，请一并替换。

### 离线（release tarball）

从 Release 下载安装包与校验和，校验后安装：

```sh
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/dsh-superpowers-0.0.1.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-0.0.1.tgz
```

更新时下载新版本的这两个文件，并用新文件名执行 `dsh plugin add`。

重启 DeepSeek Harness，新会话即生效。

## 许可

MIT。见 [LICENSE](LICENSE)。内置的 Superpowers 技能为 MIT，© Jesse Vincent
与 Prime Radiant——见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
