# DeepSeek Harness (DSH) tool mapping

Superpowers skills name *actions*, never harness tools. On DeepSeek Harness those actions
resolve to the tools below. Use these exact names, and treat `Task`, `TodoWrite`,
`AskUserQuestion` and `Skill` in older skill text as the *actions* they describe — never
invent tools with those names.

| Superpowers action | DSH tool | Notes |
| --- | --- | --- |
| Invoke / load a skill | `skill` | Call `skill({ name: "<kebab-case>" })`. The catalog of names + descriptions is already in context; load a body with this tool instead of reading `SKILL.md` with file tools. |
| Read a file | `read` | Supports `offset` / `limit` for long files. |
| Create or overwrite a file | `write` | |
| Edit an existing file | `edit` | Prefer this over `write` for targeted changes. |
| Run a shell command | `bash` | Runs tests, git, builds. Not `Bash`. |
| Search file contents | `grep` | Not `Grep`; ripgrep syntax. |
| Find files by path pattern | `glob` | Not `Glob`. |
| Fetch a URL | `web_fetch` | Returns page content decoded to text. |
| Search the web | `web_search` | Use for current information; follow up with `web_fetch` for full pages. |
| Dispatch a subagent (Claude Code's `Task`) | `subagent` | Fresh context: pass a complete, self-contained prompt with paths, acceptance criteria and commands. Returns immediately with an id; the runtime notifies on completion. `subagent_fork` additionally inherits this conversation's completed turns. |
| Dispatch many independent subagents (fan-out) | `workflow` | JavaScript orchestration script with phases; use for multi-file audits, migrations, or `dispatching-parallel-agents`-style fan-out. |
| Coordinate persistent named helpers (Agent Teams) | `spawn_teammate`, `send_message`, `wait_agent`, `list_agents`, `team_task_*` | Available only when the Agent Teams profile is enabled. Useful when `subagent-driven-development` needs per-task review and steering instead of one-shot children. |
| Create / update the todo list | `todo_write` | Treat `TodoWrite` as this action. Replaces the whole list on each call. |
| Ask the user a question | `ask_user_question` | Treat `AskUserQuestion` as this action; use it for one-question-at-a-time brainstorming. |
| Ask the user to approve a plan / leave plan mode | `exit_plan_mode` | Present the plan for approval when in plan mode. |
| Create an isolated worktree | `bash` with `git worktree ...` | Plain git through `bash` is the portable path; no dedicated tool is required. |

## Harness-specific cautions

- **The skill catalog is auto-indexed.** Every skill's name + description is maintained in
  context by the harness. Do not paste skill indexes into files, and do not re-scan
  `skills/` with `bash` just to discover skills.
- **Subagents do not inherit this conversation.** For `subagent-driven-development`, put the
  plan excerpt, exact file paths, verification commands and review criteria into every
  `subagent` prompt; the child reads the plan file itself.
- **Compaction.** DSH may compact long sessions. If this bootstrap is gone after a compaction
  and a skill stops triggering, re-read `skills/using-superpowers/SKILL.md` once (the
  sanctioned fallback) or start a fresh session.
- **Plan mode.** `exit_plan_mode` is the only way to leave plan mode; do not simulate plan
  approval by asking a plain question.
- **Portability.** DSH is cross-platform. If `bash` is unavailable on the host, use the
  harness's shell tool for commands and `read` for files instead of shell pipelines.

## Provenance

This file is authored by the `dsh-superpowers` project and is vendored into the skill tree
as `using-superpowers/references/dsh-tools.md`. It is listed under `addedFiles` in
`upstream/superpowers.lock.json` and is **not** part of the upstream Superpowers content;
the upstream files stay byte-for-byte identical to the pinned commit. The Superpowers
bootstrap injects this mapping inline, so the upstream `using-superpowers/SKILL.md` is left
unmodified in v1.
