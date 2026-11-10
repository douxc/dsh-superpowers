# Nightly 构建与上游正式版发布（设计稿）

日期：2026-11-10
状态：已实现（v2；实现记录见 §11）
仓库：`douxc/dsh-superpowers`

## 1. 背景与意图

希望把「跟随上游 superpowers」变成自动化流程，而不是每次手动 vendor、测试、打包、发版：

- **Nightly**：每天拉取 `obra/superpowers` 默认分支最新提交，构建一个可安装的 **预发布** 包，供想尝鲜的人使用。
- **正式版**：上游发布新的稳定 tag 时，自动准备一次正式版更新（vendor 固定 tag + 版本号 + 测试），经人工合并后自动打出正式 Release 资产。

已核实的事实（2026-11-10）：

- 上游默认分支是 **`main`**（不是 `master`）：`refs/heads/main` @ `22f0b46`。
- 上游最新稳定 tag 是 **v7.0.2**（2026-11-03）；`main` HEAD 当前恰好 == `v7.0.2` 的提交。
- 本仓库当前 pin 的是 **7.0.1**（落后一个 release），`upstream/superpowers.lock.json` 可对比。
- 上游 **没有发布 npm 包**（npm 上的 `superpowers` 是无关的旧包），所以内容只能来自 git；
  nightly 与正式版都必须由我们的 CI 构建。
- 现有 `release-tarball.yml` 已能在 Release 发布后构建并挂载 `tgz + SHA256SUMS`。

## 2. 目标 / 非目标

**目标**

1. 每天一次（可手动触发）从上游 `main` 构建 nightly 预发布包，资产名固定、可校验、可安装。
2. 上游出现新稳定 tag 时，自动创建包含 vendor 更新与版本号的 PR；合并后自动创建 tag + 正式 Release 并挂资产。
3. 版本号不覆盖：同一版本只发一次；nightly 与正式版分开。
4. 不破坏现有离线 tarball 安装方式与测试门槛。

**非目标**

- 不自动合并正式版 PR（保留人工审核缓冲；如需要可后续改成 auto-merge）。
- 不发布 npm 包（仍走 GitHub Release 资产 / 本地 tarball）。
- 不做「用户端自动更新」：更新仍由用户显式执行 `dsh plugin --profile web add <新 tgz>` 或升级插件。

## 3. 版本策略

- **插件版本保持独立 semver**（不镜像上游版本），Release 标题与 notes 标注上游版本。
  理由：适配器代码（注入/工具映射/去重逻辑）与上游内容版本解耦，避免语义冲突。
- **正式版**：默认 patch +1（如 `0.0.1` → `0.0.2`）；适配器发生不兼容变更时人工改为 minor。
- **Nightly**：`<下一个正式版>-nightly.YYYYMMDD.<upstream-sha7>`，
  例：`0.0.2-nightly.20261110.22f0b46`。它是 semver prerelease，排序低于正式版；
  同时写进 `package.json` 与 `upstream/superpowers-version.txt`（bootstrap 版本标记可见）。
- Release 标题示例：`v0.0.2 (superpowers v7.0.2)`；nightly：`nightly 2026-11-10 (superpowers main@22f0b46)`。
- Nightly 资产使用**固定文件名**：`dsh-superpowers-nightly.tgz` + `SHA256SUMS`，
  URL 长期稳定：`https://github.com/douxc/dsh-superpowers/releases/download/nightly/dsh-superpowers-nightly.tgz`。

## 4. 交付单元（3 个 workflow + 2 处代码小改 + 文档）

### 4.1 `.github/workflows/nightly.yml`

触发：`schedule: cron '0 0 * * *'`（UTC = 北京时间 08:00）+ `workflow_dispatch`。
权限：`contents: write`。

步骤：

1. checkout `main`。
2. shallow clone 上游 `main` 到临时目录，记录 `sha`（7 位）与上游 `package.json.version`。
3. 读取上一次 nightly 的 `sha`（`gh release view nightly --json body`，notes 里埋
   `<!-- upstream-sha: ... -->`）；**若相同则跳过**，避免每天产出同样的包。
4. 写入 nightly 版本号：`package.json.version` 与 `upstream/superpowers-version.txt`。
5. `pnpm run vendor:superpowers -- --from <tmp> --version-label <nightly-version>`（见 4.4）。
6. `pnpm install --frozen-lockfile`（依赖未变，锁文件不受版本号影响）+ `pnpm test`。
7. `pnpm pack` → 重命名为 `dsh-superpowers-nightly.tgz`，生成 `SHA256SUMS`。
8. 确保 `nightly` 预发布存在：首次 `gh release create nightly --prerelease --target <main HEAD>`；
   之后 `gh release upload nightly --clobber ...` + `gh release edit nightly --notes <notes>`。
9. force-move `nightly` tag 到当前 main HEAD（保持 Release 页面的提交指向最新 nightly）。
10. 任一步失败则不更新资产（保留上一个可用 nightly），job 失败即 GitHub 通知。

Nightly notes 内容：日期、上游 `main@<sha7>`、上游版本、构建方式、校验和、
「未审核的上游 main 快照，不建议生产使用」声明。

### 4.2 `.github/workflows/upstream-release.yml`

触发：`schedule: cron '0 1 * * *'`（UTC = 北京时间 09:00）+ `workflow_dispatch`
（带 `dry-run` 布尔输入）。
权限：`contents: write`、`pull-requests: write`。

步骤：

1. `git ls-remote --tags --refs https://github.com/obra/superpowers 'refs/tags/v*'`，
   过滤掉 prerelease（含 `-` 的 tag），按 `sort -V` 取最新稳定 tag。
2. 与 `upstream/superpowers.lock.json` 的 `version` 比较；不新 → 退出。
3. shallow clone 该 tag，记录完整 commit sha。
4. vendor（`--from <tmp>`，更新 lock/version/LICENSE/skills）。
5. bump 插件版本（patch +1），更新 README 中的上游版本说明（如有）。
6. `pnpm install --frozen-lockfile` + `pnpm test`。
7. 创建分支 `upstream/superpowers-v<X.Y.Z>` 并 push（`GITHUB_TOKEN`）。
8. `gh pr create`：标题 `chore: update superpowers to vX.Y.Z`；body 包含：
   - 上游 tag 与 commit、上游 RELEASE-NOTES 对应段落（截断）；
   - `git diff --stat` 与 skills/ 文件变更摘要；
   - 测试结果；
   - 人工检查点（是否只是内容更新、有无新增技能/新增 frontmatter 字段、是否影响工具映射）。
9. 幂等：目标版本已在 lock 中，或同名分支/PR 已存在 → 跳过。
10. `dry-run`：只做 1–6 并输出 diff，不 push/不建 PR。

人工合并 PR 后，版本号随 PR 进入 `main`，触发 4.3。

### 4.3 `.github/workflows/release-on-version-bump.yml`

触发：`push: branches: [main]`（可选 paths: `package.json`、`upstream/**`）。
权限：`contents: write`。

1. 读 `package.json.version`，检查远端是否已有 tag `v<version>`。
2. 不存在 → 创建 annotated tag 并推送；`gh release create v<version> --title ... --notes ...`
   （版本号含 `-` 的走 `--prerelease`）。
3. `release: published` 触发既有 `release-tarball.yml`，把 `dsh-superpowers-<version>.tgz`
   与 `SHA256SUMS` 挂到该 Release（现有逻辑不动）。
4. 幂等：tag 已存在则跳过；不会与 nightly 冲突（nightly 不 push main）。

### 4.4 代码小改

| 文件 | 改动 |
|---|---|
| `scripts/vendor-superpowers.ts` | 新增 `--version-label <label>`：写入 `upstream/superpowers-version.txt` 时使用该标签（nightly 用）；默认仍取上游 `package.json.version`。保持 `--from` 接口不变（CI 先 clone 再 vendor）。 |
| `tests/vendor.spec.ts` | 去掉硬编码的 15 个技能列表：期望目录从 `lock.files` 中 `skills/<dir>/SKILL.md` 推导；保留最小契约（`using-superpowers/SKILL.md` 存在、每个技能目录有 `SKILL.md`、`addedFiles` 白名单、逐文件 sha256 与聚合 sha 匹配、`dsh-tools.md` 关键映射存在）。理由：上游增删技能时 nightly/正式 PR 不应因「恰好 15 个」这种断言而失败。 |
| `README.md` / `README.zh.md` | 新增「Nightly builds」（安装命令、校验、风险声明）与「Release process」（版本策略、三次 workflow 的职责一句话）；更新当前内置上游版本号。 |
| `docs/release-process.md` | 可选：把上面流程展开成维护者手册。 |

## 5. 需要一次性人工设置（仓库 Settings）

- **Settings → Actions → General → Workflow permissions**：选 *Read and write permissions*。
- 勾选 **Allow GitHub Actions to create and approve pull requests**（4.2 需要开 PR）。
- （可选）分支保护：允许 `GITHUB_TOKEN` 推送 tag / 不阻止 bot 分支。

## 6. 验收方式

1. **Nightly 手动干跑**：Actions → nightly → Run workflow。
   断言：资产名为固定名、`sha256sum -c` 通过、解包 `package/package.json` 版本为 nightly 串、
   临时 profile 安装后 bootstrap 版本标记含 `nightly`。
2. **Formal 手动干跑**：Actions → upstream-release → Run workflow + dry-run。
   断言：识别出 `v7.0.2`、生成 diff 摘要、不 push。
   正式跑一次：生成 PR；人工合并 → 自动 `v0.0.2` tag + Release + tgz 资产。
3. **幂等**：同日重复执行 nightly 在 sha 未变时跳过；formal 在 lock 已新时跳过。
4. **失败路径**：让上游 clone 失败或测试失败时，nightly 不覆盖旧资产、job 红。

## 7. 风险与取舍

| 风险 | 处理 |
|---|---|
| 上游 main 含未发布/未审核行为 | nightly 是预发布、README 标注「不建议生产」；正式版仍走 PR 人工审核 |
| 上游结构变更导致 nightly 测试失败 |  nightly 失败即红灯、不发布坏资产；正式 PR 里同样失败，需适配器更新后再发 |
| 正式 PR 的测试通过但行为回归 | PR body 附上游 release notes 与 diff；人工 review 是最后一道门 |
| nightly tarball 是 `file:` 依赖 | 用户更新 nightly 需重新下载并 `dsh plugin add`；README 写清，不要保留旧文件路径 |
| GitHub Actions 设置未开 | 属于一次性人工设置（见 §5），未开则 4.2 开 PR 失败，nightly 与 4.3 不受影响 |
| 上游 tag 命名不符合 `v*` | 检测逻辑忽略非 `v*` tag；若上游改变命名习惯，PR/workflow 需调整 |

## 8. 已定的默认值（可推翻）

- 时间：nightly 北京时间 08:00；formal 检查 09:00。
- 正式版：bot PR + 人工合并后自动发版（不做全自动直发）。
- 版本号：插件独立 semver（不镜像上游）；正式 patch+1。
- nightly 交付：单一 moving `nightly` 预发布 + 固定资产名（不保留历史 nightly 版本）。

## 9. 预期首批产物

- 第一次 formal：上游 **v7.0.2** → 插件 **v0.0.2**（随后 `release-tarball` 挂 tgz+SHA256SUMS）。
- 第一次 nightly：`main@22f0b46`（当前 == v7.0.2），版本 `0.0.2-nightly.<date>.22f0b46`。

## 10. Grill 结果与设计修订（v2）

对 v1 做了逐条对抗性验证：查 GitHub 官方文档、在临时仓库实测 vendor 7.0.2 与
nightly 打包/升级行为、核对现有测试与脚本。以下按严重度列出问题与修订。

### 10.1 Blocking（v1 会直接失败）

1. **GITHUB_TOKEN 创建的事件不会触发 workflow。** 官方文档：用 `GITHUB_TOKEN`
   执行的任务所触发的事件不会创建新的 workflow run；例外是
   `workflow_dispatch` 与 `repository_dispatch` **总是**会创建 run。
   → v1 §4.3 的「合并后 tag+release → release:published → release-tarball 挂资产」链路
   **不会触发**。
   **修订**：release-on-bump 用 `GITHUB_TOKEN` 建 tag + release 后，显式调用
   `gh workflow run release-tarball.yml --ref main -f tag=vX`（走 `workflow_dispatch`
   例外）；该 workflow 需要 `permissions: { contents: write, actions: write }`。
   REST 文档要求触发 workflow dispatch 的 token 具备 Actions 仓库权限（write）。
2. **Bot PR 的 CI 状态**：由 `GITHUB_TOKEN` 创建的 PR，其 `pull_request` workflow
   在新版 GitHub 上以 **approval-required** 状态创建（文档注明版本条件），需要有写权限的人
   在 PR 上点一次 **Approve workflows to run**；旧版本/不支持该机制的仓库则 PR 无 CI checks。
   **修订**：PR body 与 README 写明这一步；默认不引入 PAT secret。若要求 PR 必须自动出
   checks，再改用 fine-grained PAT / GitHub App token（列为可选项，不默认）。
3. **实测：直接 vendor 上游 7.0.2 会挂测试。** 现有 `tests/vendor.spec.ts` 硬编码
   `toHaveLength(84)` / `toHaveLength(85)`；v7.0.2 删除了若干上游文件后是 80/81，
   实测 `61/62` 通过、1 failed。
   **修订**：期望文件数/技能目录从 `upstream/superpowers.lock.json` 推导（实测改完后
   62/62 全绿）；同时新增「文档与 lock 一致」断言（见 10.2 #5），否则文档会静默过期。

### 10.2 High

4. **`--version-label` 与现有测试冲突。** 测试断言
   `upstream/superpowers-version.txt` == `lock.version`；nightly 若覆盖 version 文件会
   打破自己的测试，且 bootstrap 版本标记会不再是内容版本。
   **修订**：nightly **不修改** version 文件（bootstrap 标记保持上游内容版本，准确）；
   nightly 身份只体现在 `package.json.version`、Release 标题/notes。移除 `--version-label` 设计。
5. **文档漂移。** `THIRD_PARTY_NOTICES.md`（版本 7.0.1、84 files、commit/tag）与
   README（`vendors ... v7.0.1`、`dsh-superpowers-0.0.1.tgz` 示例）是硬编码的；
   `vendor-superpowers.ts` 只打印提醒不更新。
   **修订**：新增 `scripts/sync-vendor-references.ts`：按新 lock 同步 notices 的
   version/ref/tag/文件数、README 的上游版本与 tgz 示例文件名；nightly 在 worktree
   运行它后再测试（不提交）；formal PR 把它纳入提交；新增测试断言 notices/README 与
   lock 一致，漂移即红。
6. **Nightly 升级 UX（实测）**：同路径替换 tgz 后
   `dsh plugin --profile web add ./dsh-superpowers-nightly.tgz` **可正常升级**（exit 0，
   安装版本变成 nightly 版本）；但 `pnpm install --frozen-lockfile` 会因 integrity
   不匹配失败（这是 lockfile 的保护，符合预期）。
   **修订**：README nightly 段落写清：「重新下载固定名 tgz 后，再执行一次
   `dsh plugin add <同一路径>`；不要用 frozen install；如误用可 `--update-checksums`」。
7. **dispatch 权限的 fallback**：若仓库策略不允许 `actions: write`，则
   `gh workflow run` 失败的兜底是 release-on-bump 内联构建并上传资产（复用
   release-tarball 的步骤，代码略重复）。默认按 dispatch 实现；README 记录 fallback。

### 10.3 Medium

8. **release-on-bump 恢复路径**：tag 已存在但 Release 资产缺失（上次 dispatch 失败）时，
   该 workflow 不会重试。**修订**：README/流程写清手动恢复命令
   `gh workflow run release-tarball.yml --ref main -f tag=vX`（现有 workflow 已支持）。
9. **首个 formal 就是 v7.0.2**：必须先落地测试重构 + 文档同步，formal PR 才会绿。
10. **定时任务可能被 GitHub 自动禁用**：仓库长期无提交时（公开仓库 60 天规则；私有仓库以
    实际为准），`schedule` 可能停止；缓解是 formal PR 会周期性产生提交，若发现停摆可手动
    dispatch 恢复（README 注明）。
11. **移动 `nightly` tag**：使用 `git push --force` 移动 tag；若仓库配置了 tag ruleset 会失败。
    失败时的替代方案是改成 dated tags（`nightly-YYYYMMDD`），默认先不做。
12. **未审核内容进入 nightly**：nightly 明确标记为 preview/不可信；README 风险段 + notes 声明，
    不承诺生产可用（保留正式版人工 PR 审核门）。
13. **Actions 分钟数**：nightly ~4–6 min/天 + formal 检查 ~2–3 min/天 ≈ 200–270 min/月，
    私有仓库免费额度 2000 min/月，可接受。
14. **PR 分支/幂等**：`upstream/superpowers-vX.Y.Z` 已存在则跳过（stale PR 人工关闭）；
    formal 只取最新稳定 tag，跨多版本时一次跳到最新并在 PR body 说明区间。
15. **并发**：三个 workflow 都加 `concurrency`；release-on-bump 用版本 tag 做幂等键，
    避免同版本重复 dispatch。
16. **Nightly skip 细节**：首次 `gh release view nightly` 必须容忍不存在；full sha 存在
    Release body 的 HTML 注释里；无 release 视为无基线。
17. **上游结构变化的信号**：新增 nightly 结构测试——用本仓库的 frontmatter 解析器校验每个
    `skills/<dir>/SKILL.md` 的 `name` 与目录名一致且 kebab-case；不通过则 nightly 失败，
    提示适配器需要更新（而不是静默装载不上）。
18. **Vendor 脚本现状**：`addedFiles` 冲突保护已经存在（上游若开始提供同名
    `dsh-tools.md` 会直接报错退出），无需新增；shallow clone 下「HEAD 未打 tag」的
    warning 无副作用。

### 10.4 Low / 备注

- 文档与实现统一把上游分支写成 **`main`**（v1 中受任务措辞影响的 “master” 已更正）。
- release-on-bump 顺序：先 `git tag` + push tag，再 `gh release create --verify-tag`，
  再 dispatch asset workflow；全部用 `GITHUB_TOKEN`。
- 正式 Release 的资产仍由（已被验证的）`release-tarball.yml` 上传，不重复实现校验逻辑。
- `pnpm install --frozen-lockfile` 在 nightly 仅改 `package.json.version` 后实测通过（exit 0）。

### 10.5 修订后的实现清单（v2）

1. `tests/vendor.spec.ts`：lock 推导文件数/技能目录；新增 notices/README 一致性断言；
   新增 frontmatter 结构校验（复用 `src/skills.ts` 的解析函数）。
2. 新增 `scripts/sync-vendor-references.ts`（文档同步）。
3. `scripts/vendor-superpowers.ts`：不改 version 语义（不引入 `--version-label`）。
4. 新增 `.github/workflows/nightly.yml`（含 skip、固定资产名、notes marker、并发、失败不覆盖）。
5. 新增 `.github/workflows/upstream-release.yml`（检测 → vendor → sync docs → 测试 → PR；
   带 dry-run）。
6. 新增 `.github/workflows/release-on-version-bump.yml`（tag → release → dispatch
   release-tarball；`contents`+`actions` write；幂等）。
7. README（中英）+ 设计文档更新：nightly 安装/升级方式、approval-required 说明、
   手动恢复命令、风险与分钟数。
8. 验证：本地模拟 nightly 构建（已验）、dry-run formal、首个 formal v7.0.2 → v0.0.2。

### 10.6 仍可选的决策（不阻塞实现，按默认执行）

- **A** 正式 PR 的 CI：默认「零 secret：人工点一次 Approve workflows to run」；
  备选「加 fine-grained PAT/App token 让 checks 自动跑」。
- **B** dispatch 失败时：默认「README 记录 fallback（内联构建）」，不默认实现；
  若你的仓库不允许 `actions: write`，实现时直接做内联版。
- **C** nightly 历史：默认只保留最新（固定资产名 + 移动 tag），不留每日快照。

## 11. 实现记录

已按 §10 的 v2 方案落地（实现计划：`docs/superpowers/plans/2026-11-10-nightly-and-upstream-releases.md`）：

| 类别 | 文件 |
| --- | --- |
| 版本计算 | `scripts/next-versions.ts`（formal / nightly / latest-tag / newer 子命令） |
| 文档同步 | `scripts/sync-vendor-references.ts`（`--check` 可做 drift 门禁） |
| Workflows | `.github/workflows/nightly.yml`、`upstream-release.yml`、`release-on-version-bump.yml` |
| 测试 | `tests/versions.spec.ts`、`tests/docs-consistency.spec.ts`、`tests/workflows.spec.ts`；`tests/vendor.spec.ts` 改为 lock 驱动 |
| 文档 | README 中英新增 Nightly / 发布流程章节；本设计稿与计划归档 |

本地端到端模拟（临时 clone，未提交）：

- formal：vendor 上游 **v7.0.2** → 插件 0.0.1→0.0.2 → 文档同步 → **85 tests 全绿** → 产出
  `dsh-superpowers-0.0.2.tgz`；
- nightly：`0.0.3-nightly.<date>.22f0b46` → 文档同步 → 85 tests 全绿 → 产出固定名
  `dsh-superpowers-nightly.tgz` + `SHA256SUMS`，tarball 内含 `lib/index.js` 且版本号正确。

上线后的第一次人工验证（需要仓库 Write 权限的 Actions）：

1. Actions → **nightly** → Run workflow：检查 `nightly` Release 出现固定名资产与
   `<!-- upstream-sha: … -->` marker；同日再跑一次应 skip。
2. Actions → **upstream-release** → Run workflow，`dry_run = true`：应识别 v7.0.2 并完成
   vendor/测试，只打印 diff，不 push。
3. 再跑一次 `dry_run = false`：生成 `upstream/superpowers-v7.0.2` 分支与 PR；PR 上按提示
   **Approve workflows to run**；合并后 `release-on-version-bump.yml` 创建 `v0.0.2` 并
   dispatch 资产构建，Release 出现 `dsh-superpowers-0.0.2.tgz` + `SHA256SUMS`。

已知限制：`push`/`release` 事件由 `GITHUB_TOKEN` 创建时不会触发新 workflow（`workflow_dispatch`
例外），因此发版链路依赖显式 dispatch；如 dispatch 权限被仓库策略禁用，按设计稿 §10.2 #7 的
fallback 在 release-on-version-bump 内联构建上传。
