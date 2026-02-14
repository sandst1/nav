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

Set your API key and optionally a model:

```bash
# OpenAI (default)
export OPENAI_API_KEY="sk-..."

# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# Or use the unified key
export NAV_API_KEY="..."
```

Override defaults with env vars or CLI flags:

| Env var | CLI flag | Default | Description |
|---------|----------|---------|-------------|
| `NAV_MODEL` | `-m, --model` | `gpt-4o` | Model name |
| `NAV_PROVIDER` | `-p, --provider` | auto-detected | `openai`, `anthropic`, or `ollama` |
| `NAV_BASE_URL` | `-b, --base-url` | auto-detected | API base URL |
| — | `-v, --verbose` | off | Show diffs, tokens, timing |
| — | `--enable-handover` | off | Enable handover mode for context management |

Provider is auto-detected from the model name:
- `claude-*` → anthropic
- known local models (llama, mistral, qwen, gemma, phi, deepseek) → ollama
- everything else → openai

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
# Ollama (auto-detected, native API)
nav -m llama3 "describe the codebase"

# With explicit provider
nav -p ollama -m mymodel "task"

# LM Studio (OpenAI-compatible)
NAV_BASE_URL=http://localhost:1234/v1 nav -p openai -m local-model "fix the bug"

# OpenRouter
NAV_API_KEY="or-..." NAV_BASE_URL=https://openrouter.ai/api/v1 nav -m google/gemini-2.5-flash "task"
```

## Commands

Type these in interactive mode:

- `/clear` — clear conversation history
- `/model [name]` — show or switch the current model
- `/help` — list available commands

## Handover Mode

For long tasks with local LLMs, handover mode lets the model break work into
self-contained steps, clearing context between them:

```bash
nav --enable-handover -m llama3 "refactor the entire auth module"
```

The model will complete a step, call the handover tool with notes, and a fresh
context starts with those notes. This prevents context degradation and improves
output quality with limited-context models.

## Keyboard Shortcuts

- **ESC** — stop the current agent execution and return to prompt
- **Ctrl-D** — exit nav
- Type while the agent is working to queue a follow-up message

## How it works

nav has 5 tools (+ optional handover):

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
