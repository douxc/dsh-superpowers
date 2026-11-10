# dsh-superpowers

[English](README.md) | 中文

面向 **DeepSeek Harness（DSH）** 的 Superpowers 技能与每会话引导。

本包内置（vendored）[Superpowers](https://github.com/obra/superpowers) v7.0.2，并做了原生集成：
15 个技能注册进 DSH 的 `skill` 工具；`using-superpowers` 引导文本通过 `agent/pre-step` 扩展点
在每个根会话注入一次——上下文压缩（compaction）后会自动重新注入，子代理会话不会注入。

本包同时是 DSH 插件与 bundle 层（`dsh.bundle.patch`），所以一次 `dsh plugin add` 就会
安装代码并激活 `superpowers` 行。

## 环境要求

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`（通过 `engines.dsh` 与 peer 依赖声明）。
- Node.js 20+。

## 安装

```sh
# 从 release tarball 或本地 `pnpm pack` 安装（无需允许构建脚本）
dsh plugin --profile web add ./dsh-superpowers-0.0.2.tgz

# 从本地 checkout 链接安装（开发用）
dsh plugin --profile web add /path/to/dsh-superpowers

# 从 GitHub 安装（首次 add 会被拦下，需要先允许构建）
dsh plugin --profile web add github:douxc/dsh-superpowers
```

Git 安装拿到的是源码，pnpm 需要执行本包的 `prepare` 构建（`tsc`）。pnpm >= 10
默认禁止 git 依赖执行构建脚本：上面的命令会以
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败并打印精确的 key。把该 key 加到
profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 下，再重跑同一条命令：

```yaml
allowBuilds:
  'dsh-superpowers@git+ssh://git@github.com/douxc/dsh-superpowers.git#<commit>': true
```

key 里含 `#`，必须加引号。建议固定 commit
（`github:douxc/dsh-superpowers#<sha>`），避免后续 push 改变安装时执行的代码；
只对可信包允许构建。tarball 安装自带构建好的 `lib/`，不需要此许可。

`dsh plugin add` 会自动把 bundle 追加进 profile 的 `dsh.profile.bundles`。
重启应用后新开会话生效。

不启动应用也可以确认层已加载：

```sh
dsh --profile web --dump-config | grep -A2 'dsh-superpowers'
```

### 从 release tarball 安装

每个发布的 GitHub Release 都会附带构建好的包归档
（`dsh-superpowers-<version>.tgz`）和 `SHA256SUMS`。归档由
[`.github/workflows/release-tarball.yml`](.github/workflows/release-tarball.yml)
从对应 tag 的提交构建，已包含编译好的 `lib/`，**不需要任何构建权限**：

```sh
# 版本号换成你需要的 release（见 Releases 页面）
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/dsh-superpowers-0.0.2.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-0.0.2.tgz
```

也可以在 checkout 里用 `pnpm install && pnpm pack` 生成同样的归档。

tarball 安装是 Git 安装的离线/冻结替代：文件已构建、内容可用单个哈希固定、
永远不会要求 `allowBuilds`（该权限只用于需要执行 `prepare` 的 Git 安装）。

## Nightly 构建

`nightly` 预发布每天北京时间 08:00 从上游 `obra/superpowers` 的 `main` 分支
最新提交重建。它是未经审核的快照，不建议用于生产。

```sh
curl -fLO https://github.com/douxc/dsh-superpowers/releases/download/nightly/dsh-superpowers-nightly.tgz
curl -fLO https://github.com/douxc/dsh-superpowers/releases/download/nightly/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-superpowers-nightly.tgz
```

升级到更新的 nightly：重新下载这两个文件，再执行同一条 `dsh plugin add`。
替换文件后不要在 profile 里直接跑 `pnpm install --frozen-lockfile`——lock
记录的是你安装的那个 tarball 的 integrity，换文件后该检查按设计会失败；
重新执行 `dsh plugin add` 会刷新记录。

## 发布流程

- **Nightly**（[`nightly.yml`](.github/workflows/nightly.yml)）：每天检查上游
  `main`；有新提交时 vendor 该快照、跑全量测试，并用固定资产名更新移动的
  `nightly` 预发布；上游无变化则跳过。
- **正式版**（[`upstream-release.yml`](.github/workflows/upstream-release.yml)）：
  上游出现新的稳定 tag 时，自动开一个 PR（含 vendor 内容、插件 patch 版本号、
  上游 release notes、测试结果）。Review 并合并。由 `GITHUB_TOKEN` 创建的 PR
  可能显示 **Approve workflows to run** 横幅，点一下即可让 CI 跑起来。
- **发布**（[`release-on-version-bump.yml`](.github/workflows/release-on-version-bump.yml)）：
  合并进入 `main` 后，创建 `v<version>` tag 与 GitHub Release，然后显式 dispatch
  资产构建——GitHub 不会为 `GITHUB_TOKEN` 创建的事件启动新 workflow，而
  `workflow_dispatch` 是官方例外。最终由
  [`release-tarball.yml`](.github/workflows/release-tarball.yml) 把带版本号的
  tarball 与 `SHA256SUMS` 挂到该 Release。
- **恢复**：若 Release 已存在但资产缺失，重新触发资产构建：
  `gh workflow run release-tarball.yml --ref main -f tag=v<version>`。

插件版本独立 semver：正式版 patch +1；nightly 使用
`<下一个正式版>-nightly.<日期>.<上游 sha>`。

## 工作方式

1. **注册 15 个内置技能**（`brainstorming`、`writing-plans`、
   `test-driven-development`、`systematic-debugging` 等）为 DSH 运行时技能。
   DSH 在会话技能目录里展示名称 + 描述，模型用原生 `skill` 工具加载完整正文；
   技能的 `references/`、`scripts/`、`prompts/` 资源保留在各自 `SKILL.md` 旁。
2. **每个根会话注入一次 Superpowers 引导**（user-role 消息）：完整的
   `using-superpowers` 正文 + DSH 工具映射。去重依据消息 source
   （`kind: superpowers-bootstrap` + 内容 digest），因此后续步骤、恢复会话、
   fork 会话都不会重复注入。
3. **压缩后自动恢复**：压缩替换掉包含引导的消息区间后，下一步会发现引导不可见并重新注入。
4. **跳过子代理会话**：依据持久的 `session.header.delegationDepth`
   （并叠加运行时 `subagentDepth`）判定。

## 配置

插件选项写在 profile 的 `cordis.patch.yml`（或任意 `--patch` 覆盖层）中，
按行 id `superpowers` 定位：

```yaml
- id: superpowers
  config:
    disableBootstrap: true   # 保留技能，关闭每会话注入
    maxBootstrapBytes: 32768 # 引导文本上限
    # skillsDir: /custom/skills   # 覆盖内置技能目录
```

修改后需要重启应用。

## 禁用 / 卸载

```sh
dsh plugin --profile web remove dsh-superpowers
```

关闭 bundle 会注销技能与注入器；已经收到引导的会话会保留历史中的那条消息。

## 维护：更新内置技能

`skills/` 是从固定上游 tag 逐字节 vendor 的（记录在
[upstream/superpowers.lock.json](upstream/superpowers.lock.json)，含逐文件 sha256）。
更新流程：

```sh
git clone https://github.com/obra/superpowers /tmp/superpowers
pnpm install
pnpm run vendor:superpowers -- --from /tmp/superpowers
pnpm test          # 含离线 lock/内容校验测试
```

提交前请 review 上游 `RELEASE-NOTES.md` 的差异，并在真实 DSH 会话里跑一次验收。
对上游目录唯一新增的文件是 [`skills/using-superpowers/references/dsh-tools.md`](skills/using-superpowers/references/dsh-tools.md)
（DSH 工具映射）；不会修改任何上游 `SKILL.md`。

## 已知限制与待办

- `context-overflow` 压缩后的同一步 retry 请求早于下一次 `agent/pre-step`，
  该次请求可能缺少引导；下一步会补发。
- 升级本包不会改写已存在会话中的引导；旧会话保留已看到的版本，直到压缩清空后
  才被动升级到当前版本。
- 技能是提示词内容而非沙箱代码：在敏感工作区启用前请阅读
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 并 review 内置源码。

## 许可

MIT。内置的 Superpowers 技能为 MIT，© Jesse Vincent 与 Prime Radiant——
见 [upstream/LICENSE-superpowers](upstream/LICENSE-superpowers) 与
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
