# nav

Minimalist coding agent with hashline-based editing. 5 tools, tiny system prompt, fast.

## Setup

```bash
# Install dependencies
bun install

# Run directly
bun run src/index.ts

# Or link globally so `nav` is available everywhere
bun link
```

After `bun link`, you can use `nav` from any directory.

## Configuration

Configuration is resolved in order of priority: **CLI flags > environment variables > project config file > user config file > defaults**.

### API keys

```bash
# OpenAI (default)
export OPENAI_API_KEY="sk-..."

# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# Or use the unified key
export NAV_API_KEY="..."
```

### Environment variables and CLI flags

| Env var | CLI flag | Default | Description |
|---------|----------|---------|-------------|
| `NAV_MODEL` | `-m, --model` | `gpt-4o` | Model name |
| `NAV_PROVIDER` | `-p, --provider` | auto-detected | `openai`, `anthropic`, or `ollama` |
| `NAV_BASE_URL` | `-b, --base-url` | auto-detected | API base URL |
| `NAV_SANDBOX` | `-s, --sandbox` | off | Enable sandbox (macOS only) |
| `NAV_CONTEXT_WINDOW` | — | auto-detected | Context window size in tokens |
| `NAV_HANDOVER_THRESHOLD` | — | `0.8` | Auto-handover at this fraction of context (0–1) |
| `NAV_THEME` | — | `nordic` | Color theme (`nordic` or `classic`) |
| — | `-v, --verbose` | off | Show diffs, tokens, timing |

Provider is auto-detected from the model name:
- `claude-*` → anthropic
- known local models (llama, mistral, qwen, gemma, phi, deepseek) → ollama
- everything else → openai

### Config files

You can also configure nav via JSON config files. All fields are optional:

| Location | Scope |
|----------|-------|
| `.nav/nav.config.json` | Project-level (highest file priority) |
| `~/.config/nav/nav.config.json` | User-level |

```json
{
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "verbose": true,
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

# OpenRouter
NAV_API_KEY="or-..." NAV_BASE_URL=https://openrouter.ai/api/v1 nav -m google/gemini-2.5-flash "task"
```

## Commands

Type these in interactive mode:

- `/clear` — clear conversation history
- `/model [name]` — show or switch the current model
- `/handover [prompt]` — summarize progress and continue in a fresh context
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

### Handover

For long tasks, `/handover` lets you reset context without losing track of progress. The model summarizes what it's done, the conversation is cleared, and a fresh context starts with the summary, a current file tree, and any instructions you provide:

```
> /handover now write tests for the auth module
```

This is useful when context is getting long and you want to refocus the model on the next phase of work.

### Auto-handover

nav can automatically trigger a handover when the conversation approaches the model's context window limit. This prevents context overflow errors and keeps the model working effectively.

Context window sizes are auto-detected (not perfect and you can always override the values, see below):
- **OpenAI / Anthropic** — looked up from a built-in table of known models
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
