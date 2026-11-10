# Nightly 构建与上游正式版发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天从上游 `obra/superpowers` 的 `main` 构建 nightly 预发布包；上游出现新稳定 tag 时自动开 PR，合并后自动创建正式 tag/Release 并挂载可安装 tarball。

**Architecture:** 三个 GitHub Actions workflow 分别负责 nightly 构建、正式版检测与 PR、合并后发版；共用两个小脚本（版本计算、vendor 文档同步）与一套 lock 驱动的 vendor 测试。nightly 只写 Release 资产与移动 tag，不提交到 `main`；正式版经 bot PR 人工合并后进入 `main`，由 push 触发发版。

**Tech Stack:** GitHub Actions (ubuntu-latest, Node 22, pnpm 11.28.5), TypeScript scripts via `tsx`, vitest, GitHub CLI (`gh`).

**Spec:** `docs/superpowers/specs/2026-11-10-nightly-and-upstream-releases-design.md`（v2，§10 为修订后的权威流程）

## Global Constraints

- 上游仓库 `https://github.com/obra/superpowers`，默认分支 **`main`**；稳定 tag 形如 `vX.Y.Z`（过滤含 `-` 的 tag）。
- 插件版本独立 semver：正式版 patch +1；nightly 为 `<下一正式版>-nightly.YYYYMMDD.<sha7>`。
- nightly 资产固定名：`dsh-superpowers-nightly.tgz` + `SHA256SUMS`；Release tag `nightly`（prerelease，移动）。
- 正式 Release tag：`v<package.json version>`；资产由既有 `release-tarball.yml` 生成。
- `GITHUB_TOKEN` 触发的事件不产生新 run，**只有** `workflow_dispatch`/`repository_dispatch` 例外；所有跨 workflow 触发必须显式 dispatch。
- 需要的 token 权限：nightly `contents: write`；upstream-release `contents: write` + `pull-requests: write`；release-on-version-bump `contents: write` + `actions: write`。
- 不新增运行时依赖；测试用 devDependency `yaml` 解析 workflow。
- 不修改上游技能正文；不引入 `--version-label`（nightly 不改 `upstream/superpowers-version.txt`）。
- 每次 workflow 修改后：`pnpm test`、`pnpm typecheck`、`pnpm sync:vendor-docs -- --check` 必须通过。

## Review Focus

- 上游 `main` 删除了文件（7.0.2 就删了）：任何硬编码文件数/技能数的测试必须失效。
- 上游新增/删除技能时：vendor 测试必须从 lock 推导，且新技能 frontmatter 必须可被本插件解析。
- 同路径替换 nightly tarball 后用户重装：`dsh plugin add` 应成功，frozen pnpm install 会因 integrity 失败——README 必须写清。
- `GITHUB_TOKEN` 创建的 release/PR 不触发 workflow / 处于 approval-required：发版链路必须显式 dispatch，PR body 必须提示点 Approve。
- 文档（README/THIRD_PARTY_NOTICES）中的版本、文件数、tgz 文件名必须与 lock/package.json 一致；drift 必须被测试捕获。

---

### Task 1: 版本计算 helper

**Files:**
- Create: `scripts/next-versions.ts`
- Test: `tests/versions.spec.ts`

**Interfaces:**
- Produces (ESM exports):
  - `nextFormalVersion(current: string): string` — patch +1，忽略当前 prerelease 段。
  - `nextNightlyVersion(current: string, yyyymmdd: string, sha7: string): string` — `<nextFormalVersion>-nightly.<yyyymmdd>.<sha7>`。
  - `latestStableTag(tags: readonly string[]): string | undefined` — 过滤 `^v\d+\.\d+\.\d+$`，返回版本最大者。
  - `isNewerVersion(candidate: string, current: string): boolean` — 去 `v` 后按数字段比较。
  - CLI（供 workflow 用）：`tsx scripts/next-versions.ts formal --current 0.0.1` → `0.0.2`；`... nightly --current 0.0.1 --date 20261110 --sha 22f0b46` → `0.0.2-nightly.20261110.22f0b46`；`... newer --candidate v7.0.2 --current 7.0.1` → `true|false`。

- [ ] **Step 1: 写失败测试** `tests/versions.spec.ts`：覆盖
  `nextFormalVersion('0.0.1') === '0.0.2'`、`nextFormalVersion('1.2.9') === '1.2.10'`、
  `nextFormalVersion('0.0.2-nightly.20261110.abc1234') === '0.0.3'`、
  `nextNightlyVersion('0.0.1','20261110','22f0b46') === '0.0.2-nightly.20261110.22f0b46'`、
  `latestStableTag(['v7.0.10','v7.0.9','v7.1.0-beta.1','v7.0.2']) === 'v7.0.10'`（过滤 prerelease）；
  `isNewerVersion('v7.0.10','7.0.9') === true`，相等/更旧为 false。
- [ ] **Step 2: 跑测试确认失败**：`pnpm exec vitest run tests/versions.spec.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 `scripts/next-versions.ts`**：纯函数 + `import.meta.url === pathToFileURL(process.argv[1]).href` 时才执行 CLI（仿 `scripts/vendor-superpowers.ts`）；非法输入抛错并以非零退出。
- [ ] **Step 4: 跑测试确认通过**：`pnpm exec vitest run tests/versions.spec.ts` → PASS。
- [ ] **Step 5: 提交**：`git add scripts/next-versions.ts tests/versions.spec.ts && git commit -m "feat(ci): add release version helper"`。

### Task 2: vendor 测试改为 lock 驱动 + frontmatter 校验

**Files:**
- Modify: `tests/vendor.spec.ts`
- Test: 同文件

**Interfaces:**
- Consumes: `upstream/superpowers.lock.json` 的 `files`/`version`；`parseSkillDocument`（`src/skills.ts` 已导出）。
- Produces: 测试不再依赖固定 15/84/85 数字；技能清单由 lock 推导。

- [ ] **Step 1: 把失败的期望写进测试**：删除 `EXPECTED_SKILLS` 常量与 `toHaveLength(84)`/`toHaveLength(85)`；改为
  `const expectedSkills = [...new Set(Object.keys(lock.files).filter(f => /^[^/]+\/SKILL\.md$/.test(f)).map(f => f.split('/')[0]))].sort()`；
  断言 `skillDirs` 等于它、`actualUpstream.length === Object.keys(lock.files).length`、
  `actualFiles.length === lock.files 数 + ADDED_FILES.length`。
  逐个技能用 `parseSkillDocument` 断言 `frontmatter.name === dir`、`description` 非空。
- [ ] **Step 2: 跑测试**：`pnpm test` → PASS（当前 pin 的 7.0.1 内容）。
- [ ] **Step 3: 用上游 7.0.2 验证（临时目录）**：
  `git clone --depth 1 https://github.com/obra/superpowers /tmp/sp702 && git -C /tmp/sp702 fetch --depth 1 origin tag v7.0.2 && git -C /tmp/sp702 checkout -q v7.0.2`
  在临时 clone 中执行 `pnpm run vendor:superpowers -- --from /tmp/sp702` 后 `pnpm test` → PASS。
- [ ] **Step 4: 提交**：`git add tests/vendor.spec.ts && git commit -m "test: derive vendored skill set from the lock"`。

### Task 3: vendor 文档同步脚本 + 一致性测试

**Files:**
- Create: `scripts/sync-vendor-references.ts`
- Create: `tests/docs-consistency.spec.ts`
- Modify: `package.json`（`scripts["sync:vendor-docs"]`、devDependency `yaml`）
- Modify: `pnpm-lock.yaml`（`pnpm install`）

**Interfaces:**
- CLI: `tsx scripts/sync-vendor-references.ts [--check]`
  - 读 `upstream/superpowers.lock.json`、`package.json`、`THIRD_PARTY_NOTICES.md`、`README.md`、`README.zh.md`。
  - 重写：notices 的 `Superpowers vX.Y.Z`、`| Version | X.Y.Z (pinned) |`、`— N skill directories, M files`、`commit` / `tag` 行；
    README 的 `vendors ... vX.Y.Z`、`dsh-superpowers-<pkgVersion>.tgz`（两语言各 3 处）、`本包内置 ... vX.Y.Z`。
  - `--check`：只比较，不写；有 drift 打印文件与期望值并以 1 退出；否则 0。
- Produces: 文档与 lock/package.json 的一致性由 `tests/docs-consistency.spec.ts` 守护。

- [ ] **Step 1: 写失败测试** `tests/docs-consistency.spec.ts`：从 lock/package.json 计算期望，断言
  notices 含 `Superpowers v${lock.version}`、`| Version | ${lock.version}`、`${skillCount} skill directories, ${fileCount} files`、`lock.ref`；
  README.md/README.zh.md 含 `v${lock.version}` 与 `dsh-superpowers-${pkgVersion}.tgz`。
- [ ] **Step 2: 跑测试**：`pnpm exec vitest run tests/docs-consistency.spec.ts` → 当前应 PASS（文档一致）；若发现 README 某些示例不是该文件名，修正为测试期望的一致形式（安装/下载示例统一）。
- [ ] **Step 3: 实现脚本**并把 `sync:vendor-docs` 加入 `package.json`；`pnpm add -D yaml`；`pnpm run sync:vendor-docs -- --check` → 0。
- [ ] **Step 4: 反向验证**：临时把 notices 中 `Superpowers v` 改成错误版本，`--check` → 非 0；恢复。
- [ ] **Step 5: 提交**：`git add scripts/sync-vendor-references.ts tests/docs-consistency.spec.ts package.json pnpm-lock.yaml && git commit -m "feat(ci): sync vendor references from the lock"`。

### Task 4: nightly workflow

**Files:**
- Create: `.github/workflows/nightly.yml`
- Test: `tests/workflows.spec.ts`（与 Task 6 共用）

**Interfaces:**
- Produces: 每天 UTC 00:00（北京时间 08:00）构建；上游 sha 未变则跳过；固定资产名；
  notes 内含 `<!-- upstream-sha: <full-sha> -->` 与 `superpowers main@<sha7>`。

- [ ] **Step 1: 写失败测试** `tests/workflows.spec.ts`（用 `yaml` 解析）：断言
  `on.schedule[0].cron === '0 0 * * *'`、`on.workflow_dispatch` 存在、`permissions.contents === 'write'`、
  `concurrency.group === 'nightly'`；steps 依次包含 `pnpm install --frozen-lockfile`、
  `vendor:superpowers`、`sync:vendor-docs`、`pnpm test`、`pnpm pack`；含固定资产名
  `dsh-superpowers-nightly.tgz`、`upstream-sha` marker、`gh release upload nightly`、
  `gh release create nightly --prerelease`。
- [ ] **Step 2: 跑测试确认失败**：workflow 文件不存在。
- [ ] **Step 3: 实现 `.github/workflows/nightly.yml`**（步骤顺序）：
  1. checkout `main`；setup pnpm/node（`cache: pnpm`）。
  2. clone 上游 `main` 到 `$RUNNER_TEMP/superpowers`，输出 full sha 与上游 version。
  3. `gh release view nightly --json body`（容忍不存在）解析上次 sha；相同则输出 `skip=true`。
  4. 非跳过步骤设置 `skip != 'true'`：`pnpm install --frozen-lockfile`；设置 nightly `package.json.version`
     （`tsx scripts/next-versions.ts nightly --current <当前> --date $(date -u +%Y%m%d) --sha <sha7>` 写回）；
     `pnpm run vendor:superpowers -- --from "$RUNNER_TEMP/superpowers"`；`pnpm run sync:vendor-docs`；`pnpm test`；
     `pnpm pack --pack-destination dist` 并复制为 `dist/dsh-superpowers-nightly.tgz`；`sha256sum` 到 `SHA256SUMS`。
  5. 非跳过：`gh release view nightly || gh release create nightly --prerelease --title nightly --target "$GITHUB_SHA"`；
     `gh release upload nightly dist/dsh-superpowers-nightly.tgz SHA256SUMS --clobber`；
     写 notes（日期、sha、版本、校验和）→ `gh release edit nightly --notes-file ... --title "nightly (<sha7>)"`；
     `git tag -f nightly "$GITHUB_SHA"` + `git push --force origin refs/tags/nightly`。
  6. 任一步失败即 job 红，不覆盖旧资产（上传在测试之后）。
- [ ] **Step 4: 跑测试确认通过**：`pnpm exec vitest run tests/workflows.spec.ts`。
- [ ] **Step 5: 提交**：`git add .github/workflows/nightly.yml tests/workflows.spec.ts && git commit -m "ci: add nightly build workflow"`。

### Task 5: upstream-release workflow（检测 → vendor → PR）

**Files:**
- Create: `.github/workflows/upstream-release.yml`
- Modify: `tests/workflows.spec.ts`

**Interfaces:**
- Produces: 每日 UTC 01:00 检查上游稳定 tag；比 lock 新时在分支
  `upstream/superpowers-vX.Y.Z` 提交 vendor + 版本 bump + 文档同步并开 PR；`workflow_dispatch` 的
  `dry_run` 只输出 diff。

- [ ] **Step 1: 测试**：断言 `on.schedule[0].cron === '0 1 * * *'`、
  `on.workflow_dispatch.inputs.dry_run.type === 'boolean'`、permissions
  `contents: write`/`pull-requests: write`；steps 含 `ls-remote --tags`、
  `next-versions.ts newer`、`vendor:superpowers`、`sync:vendor-docs`、
  `pnpm test`、`gh pr create`、`dry_run` 条件、`upstream/superpowers-v`。
- [ ] **Step 2: 实现 `.github/workflows/upstream-release.yml`**：
  1. checkout `main`；setup pnpm/node。
  2. 解析最新稳定 tag（`git ls-remote --tags --refs ... 'refs/tags/v*' | awk/sed | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1`）。
  3. 与 lock.version 比较：`tsx scripts/next-versions.ts newer --candidate "$tag" --current "$(node -p lock.version)"`；
     false → 退出。
  4. clone 该 tag 到 `$RUNNER_TEMP/superpowers`（`--branch "$tag" --depth 1`）。
  5. `pnpm install --frozen-lockfile`；`vendor:superpowers --from ...`；bump package 版本
     （`next-versions.ts formal --current ...` 写回 `package.json`）；`sync:vendor-docs`；`pnpm test`。
  6. `dry_run === 'true'`：输出 `git diff --stat` 与 vendor 摘要后退出。
  7. 分支 `upstream/superpowers-v<upstream-version>`：配置 git 用户、`git add -A`、commit；
     `git push --force origin "HEAD:refs/heads/$branch"`。
  8. PR body 文件：标题 `chore: update superpowers to <tag>`；内容含上游版本/commit、
     `sed -n "/## <tag>/,/^## v/p" RELEASE-NOTES.md` 摘要、`git diff --stat`、测试结果、
     人工检查点（新增/删除技能、frontmatter 变化、工具映射是否需要更新）、
     **"Merge 后请点 Approve workflows to run"**；已存在同名 PR 则跳过（`gh pr list --head`）。
- [ ] **Step 3: 测试通过 + `yaml` 解析**。
- [ ] **Step 4: 提交**：`git add .github/workflows/upstream-release.yml tests/workflows.spec.ts && git commit -m "ci: open a PR when upstream releases"`。

### Task 6: release-on-version-bump workflow（tag → release → dispatch）

**Files:**
- Create: `.github/workflows/release-on-version-bump.yml`
- Modify: `tests/workflows.spec.ts`

**Interfaces:**
- Produces: `push` 到 `main` 且 `v<version>` tag 不存在时创建 tag/Release，并
  `gh workflow run release-tarball.yml --ref main -f tag=v<version>`；tag 已存在则跳过。

- [ ] **Step 1: 测试**：断言 `on.push.branches` 含 `main`、permissions
  `contents: write` + `actions: write`、steps 含 `git tag -a`、`git push origin refs/tags/`、
  `gh release create --verify-tag`、`gh workflow run release-tarball.yml`、
  `-f tag=`、`ls-remote` tag 存在性检查、concurrency。
- [ ] **Step 2: 实现**：checkout；读 `package.json.version` 与 lock.version；`git ls-remote origin "refs/tags/v$version"` 非空 → 跳过；
  否则 tag + push；notes 文件（标题 `vX.Y.Z (superpowers vA.B.C)`、安装命令）；`gh release create --verify-tag`；
  `gh workflow run release-tarball.yml --ref main -f "tag=v$version"`。
- [ ] **Step 3: 测试通过**。
- [ ] **Step 4: 提交**：`git add .github/workflows/release-on-version-bump.yml tests/workflows.spec.ts && git commit -m "ci: release after a version bump lands on main"`。

### Task 7: README 更新（中英）

**Files:**
- Modify: `README.md`、`README.zh.md`

- [ ] **Step 1: 英文 README 加两节**：
  - `## Nightly builds`：下载 `releases/download/nightly/dsh-superpowers-nightly.tgz`(+`SHA256SUMS`)、
    校验、`dsh plugin --profile web add ./dsh-superpowers-nightly.tgz`；升级=重新下载后再执行同一条
    `add`（不要 `pnpm install --frozen-lockfile`，integrity 会失败）；标注「未审核的上游 main 快照，不建议生产」。
  - `## Release process`：正式版 = 上游新 tag → bot PR（含 release notes/diff）→ 人工合并 →
    自动 tag/Release/dispatch 资产；合并后 PR 上可能需要点 **Approve workflows to run**；
    nightly 每天 08:00（北京时间）构建；手动恢复命令 `gh workflow run release-tarball.yml --ref main -f tag=vX`。
- [ ] **Step 2: 中文 README 同结构新增两节**（保持 `## 工作方式` 等既有标题不变，vendor 测试依赖）。
- [ ] **Step 3: 跑测试**：`pnpm test`（README 一致性/配对断言通过）。
- [ ] **Step 4: 提交**：`git add README.md README.zh.md && git commit -m "docs: document nightly builds and the release process"`。

### Task 8: 端到端本地干跑 + 收尾

**Files:** 无（验证）

- [ ] **Step 1: 工作流静态校验**：`pnpm test`（全部 spec 含 workflows）；`pnpm typecheck`；`pnpm run sync:vendor-docs -- --check`。
- [ ] **Step 2: 正式版流程模拟（临时 clone）**：clone 上游 `v7.0.2`；在临时 repo 执行
  `pnpm install --frozen-lockfile` → `vendor:superpowers --from` → bump 版本 → `sync:vendor-docs` →
  `pnpm test` → `pnpm pack`；断言 62 tests 全绿、tarball 名 `dsh-superpowers-0.0.2.tgz`、
  notices/README 已更新、`git diff --stat` 合理。
- [ ] **Step 3: nightly 流程模拟**：基于同一临时 repo 设置 nightly 版本 → sync → test → pack；
  断言产物重命名逻辑（`dist/dsh-superpowers-nightly.tgz`）与固定校验和可行。
- [ ] **Step 4: 更新设计稿状态**：`docs/superpowers/specs/2026-11-10-...-design.md` 状态改为「已实现」。
- [ ] **Step 5: 最终提交并推送**：`git add -A && git commit -m "chore: nightly and upstream release automation"`；
  `git push origin main`；确认远端 `main` 与 tag 状态。
- [ ] **Step 6: 给用户的验收指令**：Actions → nightly → Run workflow；Actions → upstream-release → Run workflow + dry_run；
  预期首次正式 PR = superpowers v7.0.2 → 合并后 v0.0.2。
