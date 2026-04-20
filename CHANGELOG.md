# Changelog

## [0.7.7] - 2026-04-20

### Improved
- **Microsplit** — enhanced plan microsplit behavior

## [0.7.6] - 2026-04-18

### Fixed
- **`ask_user` tool registration** — the `ask_user` tool is only offered to the model during `/plan` discussion mode; normal agent runs no longer expose it

## [0.7.5] - 2026-04-18

### Fixed
- **UI server role persistence** — `systemPromptPrefix` is retained when the system prompt is rebuilt (`/clear`, `/init`, and after `/plans split` / `/plans microsplit`), including reloading `AGENTS.md` and skills

### Improved
- **UI server documentation** — WebSocket protocol reference and guide for building custom clients

## [0.7.4] - 2026-04-18

### Changed
- **UI server `systemPromptPrefix`** — when `thread.create` includes a non-empty prefix, Nav’s default “You are nav…” identity line is omitted so the prefix defines the agent role; operational tool and edit guidance is unchanged

## [0.7.3] - 2026-04-18

### Fixed
- **macOS binary signing** — release binaries are now ad-hoc codesigned, preventing SIGKILL on launch

## [0.7.2] - 2026-04-17

### Improved
- **UI server** — now supports multiple concurrent threads

## [0.7.1] - 2026-03-26

### Fixed
- **Sandboxing** — config file–based sandbox settings now apply correctly

## [0.7.0] - 2026-03-23

### Added
- **Hooks** — configurable `stop`, `taskDone`, and `planDone` steps in `nav.config.json` (shell commands and optional custom-command steps); `taskDone` / `planDone` support `maxAttempts` with feedback to the model on failure; `NAV_HOOK_TIMEOUT_MS` / `hookTimeoutMs` for shell step timeouts (default **10 minutes** per shell step)
- **`taskImplementationMaxAttempts`** (default 3, env `NAV_TASK_IMPLEMENTATION_MAX_ATTEMPTS`) — cap full work+verify cycles per task; `/tasks run` and `/plans run` stop when exhausted instead of continuing to the next task
- **`editMode`** in `nav.config.json` — default `hashline`; set to `searchReplace` for plain-text reads (`read` / `skim` / `filegrep` / `@file`) and literal `old_string`/`new_string` edits instead of LINE:HASH anchors
- Hook **`command`** steps: optional **`args`** string with **`${VAR}`** substitution (hook env + `process.env`); result fills custom command **`{input}`** placeholders

### Improved
- TUI and UI server now show **which hook is running** (`stop`, `taskDone`, `planDone`) with **step index** and **shell command** or **custom command** label before each step executes
- Print task name when starting to work on a task

## [0.6.0] - 2026-03-17

### Added
- `ui-server` subcommand — run nav as a local HTTP/WebSocket backend for external UI clients
- UI server configuration flags/env vars: `--ui-host` / `--ui-port` and `NAV_UI_HOST` / `NAV_UI_PORT`
- UI protocol docs in `docs/ui-server-protocol.md`
- Core transport abstraction (`AgentIO`) and WebSocket-oriented agent IO modules to support non-TUI frontends

### Improved
- Sandbox re-exec arg forwarding now preserves CLI args correctly in both source and compiled runs
- Safer slash-command tab completion handling in TUI

## [0.5.1] - 2026-03-16

### Added
- Agent now knows the current date (injected dynamically into the system prompt)

## [0.5.0] - 2026-03-16

### Added
- Azure OpenAI provider — use `-p azure` with `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_BASE_URL`, and `AZURE_OPENAI_DEPLOYMENT_NAME` environment variables (or config file equivalents)
- `azureDeployment` config option — specify Azure deployment name separately from model name

## [0.4.0] - 2026-03-07

### Added
- `skim` and `filegrep` tools — lightweight file inspection with hashline output, no shell needed
- `@` file references — type `@path/to/file` in the prompt to include file contents inline
- `/plans microsplit` command — generate micro-tasks optimized for small LLMs
- Arrow key navigation for slash-command autocomplete

### Improved
- Tool parsing and output formatting
- Hashline robustness against duplicate hashes
- Edit tool simplified and made more robust
- Ollama: pass `num_ctx` and `num_batch` sizes; show `prompt_eval_count` in verbose output
- Verbose mode: log full LLM calls when enabled
- Removed duplicate logging
- Renamed `/plans work` and `/tasks work` to `/plans run` and `/tasks run`

## [0.3.0] - 2026-02-21

### Added
- Plan mode (`/plan`, `/plans`, `/plans split`, `/plans run`) — discuss an idea, save it as a named plan, generate ordered implementation tasks, and work through them automatically
- Task management (`/tasks`, `/tasks add`, `/tasks run`, `/tasks rm`) — persistent task list with `planned` → `in_progress` → `done` lifecycle
- `config-init` command — creates a `.nav/nav.config.json` with sensible defaults
- Task halting — users can stop a running task mid-execution

### Improved
- Edit tool robustness — returns only affected-line hashes after edits (not the whole file), with detailed error messages and fresh hashes on failure so the model can retry without re-reading
- Hashline parser — fixed parse error on certain edge-case lines
- Plan mode conversation flow and task field layout
- TUI indentation and visual layout

## [0.2.0] - 2026-02-16

### Added
- Skills system — define reusable agent capabilities in `SKILL.md` files under `.nav/skills/`, `~/.config/nav/skills/`, or `.claude/skills/`; automatically injected into the system prompt
- `/skills` command — list all available skills
- `/create-skill` command — interactively create a new skill

## [0.1.1] - 2026-02-15

### Improved
- Seatbelt sandbox profile is now embedded directly into the binary (no external file dependency at runtime)

## [0.1.0] - 2026-02-15

### Added
- Initial release
- Hashline-based editing — each line is prefixed with `LINE:HASH`; edits reference anchors instead of reproducing content, preventing stale-edit conflicts
- Multi-provider LLM support: OpenAI, Anthropic (Claude), Google Gemini, Ollama
- Interactive and one-shot modes
- Shell command execution with background process support (`shell` + `shell_status` tools)
- ESC to stop agent execution; Ctrl-D to exit
- Slash commands: `/clear`, `/model`, `/handover`, `/help`
- Custom slash commands via `.nav/commands/*.md` or `~/.config/nav/commands/*.md`
- Tab autocomplete for slash commands with live filtering
- Auto-handover when approaching context window limit (configurable threshold)
- macOS Seatbelt sandboxing (`-s` / `NAV_SANDBOX=1`)
- Config files: `.nav/nav.config.json` (project) and `~/.config/nav/nav.config.json` (user)
- Color themes: `nordic` (default, 24-bit truecolor) and `classic` (16-color)
- `AGENTS.md` support — project-specific instructions auto-included in system prompt
- `/init` command — generates an `AGENTS.md` from project context
- Session logging to `.nav/logs/` as JSONL
- Pre-built binaries for macOS (arm64/x64), Linux (x64/arm64), and Windows (x64) via GitHub Actions
- Progress spinner during LLM API calls
- Verbose mode (`-v`) — shows diffs, token counts, timing, and context utilization
