# CLI Reference

## Usage

```bash
nav [options] [prompt]
```

If no prompt is given, nav starts in interactive mode.

## Options

| Flag | Description |
|------|-------------|
| `-m, --model <name>` | Model name (default: `gpt-4.1`) |
| `-p, --provider <name>` | Provider: `openai`, `anthropic`, `google`, `ollama`, `azure` |
| `-b, --base-url <url>` | API base URL |
| `-s, --sandbox` | Enable macOS Seatbelt sandboxing |
| `-v, --verbose` | Show diffs, token counts, and timing |

## Environment variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_API_BASE_URL` | Azure OpenAI endpoint (include `/openai/v1`) |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Azure deployment name |
| `NAV_API_KEY` | Unified API key (any provider) |
| `NAV_MODEL` | Default model name |
| `NAV_PROVIDER` | Default provider |
| `NAV_BASE_URL` | Default API base URL |
| `NAV_SANDBOX` | Enable sandbox (`1` to enable) |
| `NAV_CONTEXT_WINDOW` | Context window size in tokens |
| `NAV_OLLAMA_BATCH_SIZE` | Ollama `num_batch` option (default: `1024`) |
| `NAV_HANDOVER_THRESHOLD` | Auto-handover threshold, 0--1 (default: `0.8`) |
| `NAV_THEME` | Color theme: `nordic` or `classic` |

## Interactive commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/model [name]` | Show or switch model |
| `/handover [prompt]` | Manual handover with optional prompt |
| `/init` | Generate `AGENTS.md` |
| `/plan` | Enter plan mode |
| `/plans` | List plans |
| `/plans split <id>` | Split plan into tasks |
| `/plans microsplit <id>` | Split plan into micro-tasks |
| `/plans run <id>` | Run all tasks in a plan |
| `/tasks` | List tasks |
| `/tasks add <desc>` | Add a task |
| `/tasks run [id]` | Run a task (or next available) |
| `/tasks rm <id>` | Remove a task |
| `/skills` | List skills |
| `/create-skill` | Create a skill interactively |
| `/help` | Show help |

## Config files

| Location | Scope |
|----------|-------|
| `.nav/nav.config.json` | Project-level |
| `~/.config/nav/nav.config.json` | User-level |

See [Configuration](/guide/configuration) for details.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| ESC | Stop agent execution |
| Ctrl-D | Exit nav |
| Tab | Autocomplete slash commands |
| Type during execution | Queue follow-up message |

## Logs

Session logs are written to `.nav/logs/` as JSONL files. Each line captures a message, tool call, or result with timestamps.
