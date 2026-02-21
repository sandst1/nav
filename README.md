# nav

Minimalist coding agent with hashline-based editing.

**Built for [Bun](https://bun.sh)** — leverages Bun's native APIs for optimal performance.

## Installation

### Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/sandst1/nav/main/install.sh | bash
```

Or with wget:

```bash
wget -qO- https://raw.githubusercontent.com/sandst1/nav/main/install.sh | bash
```

This installs the latest binary to `~/.local/bin/nav`. To install to a different location:

```bash
NAV_INSTALL_DIR=/usr/local/bin bash -c "$(curl -fsSL https://raw.githubusercontent.com/sandst1/nav/main/install.sh)"
```

### Manual download

Download the latest binary for your platform from [GitHub Releases](https://github.com/sandst1/nav/releases):

- **macOS (Apple Silicon)**: `nav-darwin-arm64.tar.gz`
- **macOS (Intel)**: `nav-darwin-x64.tar.gz`
- **Linux (x64)**: `nav-linux-x64.tar.gz`
- **Linux (ARM64)**: `nav-linux-arm64.tar.gz`
- **Windows (x64)**: `nav-windows-x64.zip`

Extract and move to a directory in your PATH:

```bash
# macOS/Linux example
tar -xzf nav-darwin-arm64.tar.gz
mv nav-darwin-arm64 /usr/local/bin/nav
chmod +x /usr/local/bin/nav
```

## Development Setup

Requires [Bun](https://bun.sh) runtime (1.0+).

```bash
# Install Bun first (if needed)
curl -fsSL https://bun.sh/install | bash
```


```bash
# Install dependencies
bun install

# Run directly
bun run src/index.ts

# Or link globally so `nav` is available everywhere
bun link
```

## Configuration

Configuration is resolved in order of priority: **CLI flags > environment variables > project config file > user config file > defaults**.

### API keys

```bash
# OpenAI (default)
export OPENAI_API_KEY="sk-..."

# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# Google Gemini
export GEMINI_API_KEY="..."

# Or use the unified key
export NAV_API_KEY="..."
```

### Environment variables and CLI flags

| Env var | CLI flag | Default | Description |
|---------|----------|---------|-------------|
| `NAV_MODEL` | `-m, --model` | `gpt-4.1` | Model name |
| `NAV_PROVIDER` | `-p, --provider` | auto-detected | `openai`, `anthropic`, `ollama`, or `google` |
| `NAV_BASE_URL` | `-b, --base-url` | auto-detected | API base URL |
| `NAV_SANDBOX` | `-s, --sandbox` | off | Enable sandbox (macOS only) |
| `NAV_CONTEXT_WINDOW` | — | auto-detected | Context window size in tokens |
| `NAV_HANDOVER_THRESHOLD` | — | `0.8` | Auto-handover at this fraction of context (0–1) |
| `NAV_THEME` | — | `nordic` | Color theme (`nordic` or `classic`) |
| — | `-v, --verbose` | off | Show diffs, tokens, timing |

Provider is auto-detected from the model name:
- `claude-*` → anthropic
- `gemini-*` → google
- known local models (llama, mistral, qwen, gemma, phi, deepseek) → ollama
- everything else → openai

### Config files

You can also configure nav via JSON config files. All fields are optional:

| Location | Scope |
|----------|-------|
| `.nav/nav.config.json` | Project-level (highest file priority) |
| `~/.config/nav/nav.config.json` | User-level |

To create a project config with sensible defaults, run:

```bash
nav config-init
```

This creates `.nav/nav.config.json` in the current directory if one doesn't exist yet. You can also create the file manually:

```json
{
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "verbose": true,
  "sandbox": false,
  "contextWindow": 200000,
  "handoverThreshold": 0.8,
  "theme": "nordic"
}
```

Available keys: `model`, `provider`, `baseUrl`, `apiKey`, `verbose`, `sandbox`, `contextWindow`, `handoverThreshold`, `theme`.

## Usage

```bash
# Interactive mode
nav

# One-shot mode
nav "fix the type error in src/app.ts"

# With a specific model
nav -m claude-sonnet-4-20250514 "add error handling to the API routes"

# Google Gemini (auto-detected)
nav -m gemini-3-flash-preview "refactor the auth module"

# Verbose mode (shows full diffs, token counts, timing)
nav -v "refactor the auth module"
```

### Local models (Ollama, LM Studio)

```bash
# Ollama (auto-detected from model name, uses native Ollama API on port 11434)
nav -m llama3 "describe the codebase"

# Ollama with explicit provider and base URL
nav -p ollama -b http://127.0.0.1:11434 -m mymodel "task"

# Ollama on a different host/port
NAV_BASE_URL=http://192.168.1.50:11434 nav -p ollama -m llama3 "task"

# LM Studio (OpenAI-compatible API on port 1234)
NAV_BASE_URL=http://localhost:1234/v1 nav -p openai -m local-model "fix the bug"

# Google Gemini
export GEMINI_API_KEY="..."
nav -m gemini-2.5-flash "implement user authentication"

# OpenRouter
NAV_API_KEY="or-..." NAV_BASE_URL=https://openrouter.ai/api/v1 nav -m google/gemini-2.5-flash "task"
```

## Commands

Type these in interactive mode:

- `/clear` — clear conversation history
- `/model [name]` — show or switch the current model
- `/handover [prompt]` — summarize progress and continue in a fresh context
- `/plan` — enter plan mode: discuss an idea, then save a named plan
- `/plans` — list all plans with task status summary
- `/plans split <id>` — generate implementation + test tasks from a plan
- `/plans work <id>` — work through all tasks belonging to a plan
- `/tasks` — list planned and in-progress tasks
- `/tasks add <description>` — add a new task (agent drafts name/description for confirmation)
- `/tasks work [id]` — work on a specific task, or pick the next planned one automatically
- `/tasks rm <id>` — remove a task
- `/skills` — list available skills
- `/create-skill` — create a new skill interactively
- `/help` — list available commands

Typing `/` shows all available commands. As you continue typing, the list filters in real-time. Press **Tab** to autocomplete when there's a single match.

### Custom commands

You can create custom slash commands by adding markdown files:

| Location | Scope |
|----------|-------|
| `.nav/commands/*.md` | Project-level (takes precedence) |
| `~/.config/nav/commands/*.md` | User-level |

The filename (minus `.md`) becomes the command name. The markdown content is sent to the agent as a prompt. For example, `.nav/commands/review.md`:

```markdown
Review the code I've changed. Focus on correctness, edge cases, and readability.
Check for common bugs and suggest improvements.
```

Then use it with `/review`. You can pass arguments too — use `{input}` as a placeholder:

```markdown
Review the following file for issues: {input}
```

```
> /review src/auth.ts
```

Custom commands appear in `/help` and in the autocomplete suggestions.

### Skills

Skills are reusable agent capabilities defined in `SKILL.md` files. They provide specialized knowledge or workflows that nav can use automatically based on the skill's description.

| Location | Scope |
|----------|-------|
| `.nav/skills/<skill-name>/SKILL.md` | Project-level (takes precedence) |
| `.claude/skills/<skill-name>/SKILL.md` | Project-level (Claude compatibility) |
| `~/.config/nav/skills/<skill-name>/SKILL.md` | User-level |

Each skill lives in its own directory and has a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: docx-creator
description: "Use this skill when the user wants to create Word documents (.docx files)"
---

# Word Document Creator

## Overview

This skill creates .docx files using...

## Instructions

1. Install the required package...
2. Use the following template...
```

The `description` field tells nav when to use the skill. Write it as a trigger condition, not just what the skill does.

**Commands:**
- `/skills` — list all available skills
- `/create-skill` — interactively create a new skill

Skills are automatically detected and injected into the system prompt. When nav sees a task matching a skill's description, it uses that skill's instructions.

### Plans & Tasks

nav has a two-level planning system: **plans** capture the high-level design, **tasks** are the concrete units of work.

#### Plans

Plans are stored in `.nav/plans.json`. Start a plan with `/plan`:

```
> /plan add dark mode to the settings screen
```

nav enters plan mode — it discusses the idea with you, asking one clarifying question at a time. When the plan is ready, it produces a summary and asks you to confirm:

```
[y]es to save plan, type feedback to refine, [a]bandon
> y
Plan #1 saved: Dark mode settings
  Use /plans split 1 to generate implementation tasks.
```

Once saved, split it into tasks:

```
> /plans split 1
```

The agent reads the plan, explores the codebase, then creates ordered implementation tasks **and** test-writing tasks. Tasks are saved with IDs like `1-1`, `1-2`, etc. (the prefix is the plan ID).

To work through all tasks in a plan:

```
> /plans work 1
Working plan #1: Dark mode settings
Working on task #1-1: Add theme state to settings store
...
```

List all plans with a status summary:

```
> /plans
Plans:
  #1  Dark mode settings  [0/5 done, 5 planned]
```

#### Standalone tasks

Tasks without a plan use IDs like `0-1`, `0-2`, etc.

```
> /tasks add implement rate limiting for the API
```

The agent drafts a name and description, shows a preview, and asks for confirmation. Reply `y` to save, `n` (optionally with more instructions) to revise, or `a` to abandon.

```
> /tasks
Tasks:
  #0-1   [planned  ]  Rate limiting
               Add token-bucket rate limiting to the API middleware

> /tasks work 0-1
Working on task #0-1: Rate limiting
...
Task #0-1 marked as done.

> /tasks work       # picks the next planned task automatically (all tasks)
```

Tasks cycle through three statuses: `planned` → `in_progress` → `done`. When working plan-linked tasks, the plan's description and approach are included in the agent's context alongside the status of all sibling tasks.

### Handover

For long tasks, `/handover` lets you reset context without losing track of progress. The model summarizes what it's done, the conversation is cleared, and a fresh context starts with the summary, a current file tree, and any instructions you provide:

```
> /handover now write tests for the auth module
```

This is useful when context is getting long and you want to refocus the model on the next phase of work.

### Auto-handover

nav can automatically trigger a handover when the conversation approaches the model's context window limit. This prevents context overflow errors and keeps the model working effectively.

Context window sizes are auto-detected (not perfect and you can always override the values, see below):
- **OpenAI / Anthropic / Gemini** — looked up from a built-in table of known models
- **Ollama** — queried from the Ollama API at startup (`ollama show`)
- **LM Studio / custom** — set manually via `NAV_CONTEXT_WINDOW`

Configure with environment variables:

```bash
# Override context window (e.g. for LM Studio or custom endpoints)
export NAV_CONTEXT_WINDOW=32768

# Trigger auto-handover at 90% instead of the default 80%
export NAV_HANDOVER_THRESHOLD=0.9
```

When the threshold is reached mid-task, the agent completes its current step, generates a summary, and continues in a fresh context. If it's reached after the model finishes responding, the auto-handover triggers on the next user message. In verbose mode (`-v`), each response shows context utilization: `tokens: 45.2k in / 1.2k out (3.1s) (35% of 128k ctx)`.

## Keyboard Shortcuts

- **ESC** — stop the current agent execution and return to prompt
- **Ctrl-D** — exit nav
- Type while the agent is working to queue a follow-up message

## Sandboxing

> **By default, nav runs without any sandbox.** Shell commands the agent executes have full access to your system — it can read, write, and delete files anywhere your user account can. This is the fastest way to work, but it means a confused or misbehaving model can cause real damage.

Enable sandboxing to restrict what the agent can do:

```bash
# Via CLI flag
nav -s "task"

# Or via environment variable
export NAV_SANDBOX=1
```

The sandbox uses **macOS Seatbelt** (`sandbox-exec`) and is **macOS only** for now. On other platforms, `-s` will exit with an error.

When enabled, all processes spawned by nav (including shell commands) inherit these restrictions:

- **File writes** are limited to the current project directory, temp, and cache directories. Writes anywhere else are denied by the kernel.
- **File reads** are unrestricted — the agent can still read your whole filesystem.
- **Network** is unrestricted — needed for LLM API calls.

The Seatbelt profile lives in `sandbox/nav-permissive.sb` and can be customized.

## How it works

nav has 5 tools:

- **read** — reads files with hashline-prefixed output: `LINE:HASH|content`
- **edit** — edits files by referencing `LINE:HASH` anchors from read output
- **write** — creates new files
- **shell** — runs shell commands
- **shell_status** — check on background processes

The hashline format (inspired by [can.ac/the-harness-problem](https://blog.can.ac/2026/02/12/the-harness-problem/)) gives each line a short content hash. When the model edits, it references lines by `LINE:HASH` instead of reproducing old content. If the file changed since the last read, hashes won't match and the edit is rejected with corrected hashes shown — so the model can retry without re-reading.

## AGENTS.md

If an `AGENTS.md` file exists in the working directory, its content is automatically included in the system prompt. This is the standard way to give nav project-specific instructions.

## Logs

Session logs are written to `.nav/logs/` as JSONL files. Each line captures a message, tool call, or result with timestamps — useful for debugging and replay.

## Development

```bash
# Type check
bunx tsc --noEmit

# Run with watch mode
bun run --watch src/index.ts
```
