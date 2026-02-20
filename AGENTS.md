# nav - Agent Guidelines

## Project Overview

nav is a minimalist AI coding agent that uses a unique **hashline-based editing system** for precise code modifications. Instead of reproducing entire files, it references lines by `LINE:HASH` anchors, preventing edit conflicts when files change.

**Built for [Bun](https://bun.sh)** — leverages Bun's native APIs (`Bun.file()`, `Bun.spawn()`, `Bun.hash.xxHash32()`) for optimal performance.

**Core capabilities:**
- Read, edit, and write files with hash-based line tracking
- Execute shell commands (with optional macOS sandboxing)
- Support multiple LLM providers (OpenAI, Anthropic, Google, Ollama)
- Auto-detect context windows and perform handovers when approaching limits
- Custom slash commands and project-specific instructions

**Target users:** Developers who want a fast, minimal coding assistant that can navigate codebases, make precise edits, and execute tasks without reproducing large code blocks.

## Project Structure

```
src/
  tools/           # Core editing tools (read, edit, write, shell, shell-status)
    read.ts        # Reads files with hashline format (LINE:HASH|content)
    edit.ts        # Edits files using LINE:HASH anchors
    write.ts       # Creates new files
    shell.ts       # Executes shell commands, handles backgrounding
    shell-status.ts # Monitors background processes
    index.ts       # Exports all tools

  agent.ts         # Main agent loop - handles tool calls and conversation flow
  llm.ts           # LLM provider abstraction (OpenAI, Anthropic, Google, Ollama)
  config.ts        # Configuration loading (CLI, env vars, config files)
  hashline.ts      # Hashline format implementation (LINE:HASH generation/parsing)
  diff.ts          # Diff generation for verbose mode
  prompt.ts        # System prompt and input handling
  commands.ts      # Built-in slash commands (/clear, /model, /handover, /tasks, etc.)
  custom-commands.ts # User-defined slash commands from .nav/commands/*.md
  skills.ts        # Agent skills loaded from SKILL.md files
  skill-watcher.ts # Watches skill directories for changes, triggers reload
  create-skill.ts  # /create-skill command prompt builder
  tasks.ts         # Task management — persistent task list in .nav/tasks.json
  logger.ts        # JSONL session logging to .nav/logs/
  process-manager.ts # Background process tracking for shell commands
  init.ts          # /init command — generates AGENTS.md from project context
  index.ts         # Entry point
  
  sandbox.ts       # macOS Seatbelt sandboxing - re-execs nav with filesystem restrictions
  theme.ts         # Color themes (nordic/classic) for terminal output
  tree.ts          # Project file tree generator with smart compaction
  tui.ts           # Terminal UI with readline, input queuing, and streaming support

scripts/
  build.ts         # Build standalone binaries for all platforms using Bun's --compile

sandbox/
  nav-permissive.sb # macOS Seatbelt profile for sandboxing

.github/workflows/
  release.yml      # GitHub Actions workflow for automated binary builds and releases
```

## Commands

### Development
```bash
# Install dependencies
bun install

# Type checking
bunx tsc --noEmit

# Run directly (no build needed with Bun)
bun run src/index.ts

# Development with watch mode
bun run --watch src/index.ts

# Link globally for local testing
bun link

# Build standalone binaries
bun run build                    # All platforms
bun run build:darwin-arm64       # Current platform (example)
```

### Testing
Test manually by running `nav` in a test directory:
```bash
nav "describe this codebase"
nav -v "make a small change to test.ts"
```

### Publishing
```bash
# Create a new release (builds binaries for all platforms via GitHub Actions)
npm version patch|minor|major
git push origin main --tags

# Or publish source to npm (requires Bun to be installed by users)
npm publish
```

See `RELEASE.md` for the complete release process.

Package name is `nav-agent` on npm, but the command is `nav`.

## Conventions

### Code Style
- **TypeScript strict mode** - All types must be explicit
- **ESM modules** - Use `import`/`export`
- **Bun runtime** - Uses Bun-specific APIs for performance
- **Minimal dependencies** - Only essential packages (LLM SDKs, no frameworks)
- **No external UI libraries** - Terminal output uses ANSI codes directly

### Architecture Patterns

**Tool Design:**
- Each tool is a function that takes parameters and returns a result object
- Tools are exported from `src/tools/index.ts`
- Tool schemas use JSON Schema for LLM function calling
- Always return structured results (success/error, data, messages)

**Hashline Format:**
- Lines are prefixed with `LINE:HASH|` where HASH is first 2 chars of xxhash
- Example: `42:a3|const foo = "bar";`
- Edit operations reference anchors like `42:a3` to ensure file hasn't changed
- Hash mismatches trigger retries with corrected anchors

**Configuration Priority:**
1. CLI flags (`-m`, `-p`, `-v`, etc.)
2. Environment variables (`NAV_MODEL`, `NAV_API_KEY`, etc.)
3. Project config (`.nav/nav.config.json`)
4. User config (`~/.config/nav/nav.config.json`)
5. Defaults

**LLM Provider Abstraction:**
- `llm.ts` exports a unified `streamChat()` function
- Auto-detects provider from model name
- Handles streaming, tool calls, and context window detection
- Each provider (OpenAI, Anthropic, Google, Ollama) has its own adapter

**Process Management:**
- Shell commands that don't finish in `wait_ms` are backgrounded
- Background processes tracked in `process-manager.ts`
- Users can check status, read output, or kill via `shell_status` tool

**Terminal UI:**
- `tui.ts` provides minimal readline-based interface
- Supports input queuing - users can type while agent is working
- Messages queued mid-execution are sent after current task completes
- ESC key stops agent execution, Ctrl-D exits

**Theming:**
- Two color themes: `nordic` (24-bit truecolor, default) and `classic` (16-color)
- Set via `NAV_THEME` env var or config file
- Nordic palette inspired by Finnish winter dusk colors

**File Tree Generation:**
- `tree.ts` generates compact project structure for context
- Strategies: collapse single-child chains, truncate large dirs, skip lockfiles
- Included in system prompt for stability across handovers (preserves KV cache)

**Sandboxing:**
- `sandbox.ts` re-execs nav under macOS `sandbox-exec` with Seatbelt policy
- Restricts file writes to project dir, temp, and cache (reads unrestricted)
- NAV_SANDBOXED=1 env var prevents infinite re-exec loop
- Only available on macOS; exits with error on other platforms

### File Organization
- Keep tool implementations in `src/tools/`
- Core agent logic in `src/agent.ts`
- Configuration and CLI parsing separate from business logic
- Utilities (hashline, diff, logger) in their own modules

### Error Handling
- Tool errors return structured error objects, not exceptions
- Hash mismatches in edits include corrected anchors for retry
- Shell command failures include exit code and stderr
- LLM API errors are caught and reported clearly

### Session Logging
- All messages, tool calls, and results logged as JSONL to `.nav/logs/`
- Format: `{"type": "message|tool_call|tool_result", "timestamp": ..., "data": {...}}`
- Useful for debugging, replay, and analysis

### Custom Commands
- Markdown files in `.nav/commands/*.md` or `~/.config/nav/commands/*.md`
- Filename (without `.md`) becomes command name
- Content sent as prompt, supports `{input}` placeholder
- Project commands take precedence over user commands

### Task Management
- Tasks stored as JSON in `.nav/tasks.json` (loaded/saved via `tasks.ts`)
- Three statuses: `planned` → `in_progress` → `done`
- `/tasks add <description>` — agent drafts name+description, user confirms before saving
- `/tasks work [id]` — marks task `in_progress`, runs agent with task prompt, marks `done` on completion
- `/tasks work` (no id) — picks next workable task (`in_progress` first, then `planned`)
- `/tasks rm <id>` — removes a task by id
- Task add confirmation loop lives in `index.ts` (`taskAddMode` result flag from `handleCommand`)
- Task work loop also lives in `index.ts` (`workTask` result flag from `handleCommand`)

### Agent Skills
- Skills are loaded from `SKILL.md` files in skill directories:
  - `~/.config/nav/skills/<skill-name>/SKILL.md` (user-level)
  - `.nav/skills/<skill-name>/SKILL.md` (project-level)
  - `.claude/skills/<skill-name>/SKILL.md` (Claude compatibility)
- SKILL.md uses YAML frontmatter with `name` and `description` fields
- Skills are injected into the system prompt so the agent knows what's available
- Use `/skills` to list available skills
- Use `/create-skill` to create a new skill interactively
- Project skills take precedence over user skills with the same name

### AGENTS.md Convention
- If `AGENTS.md` exists in working directory, automatically included in system prompt
- Use for project-specific instructions, conventions, or context
- Keep concise - this file is sent with every request
