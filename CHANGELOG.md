# Changelog

## [0.3.0] - 2026-02-21

### Added
- Plan mode (`/plan`, `/plans`, `/plans split`, `/plans work`) — discuss an idea, save it as a named plan, generate ordered implementation tasks, and work through them automatically
- Task management (`/tasks`, `/tasks add`, `/tasks work`, `/tasks rm`) — persistent task list with `planned` → `in_progress` → `done` lifecycle
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
