# Configuration

The recommended way to configure nav is with a **config file** — either per-project or as a user-level default. CLI flags and environment variables are also supported for one-off overrides.

Priority order: **CLI flags > environment variables > project config > user config > defaults**.

## Config files

Create a JSON config file to set your model, provider, API key, and preferences in one place. All fields are optional.

| Location | Scope |
|----------|-------|
| `.nav/nav.config.json` | Project-level (highest file priority) |
| `~/.config/nav/nav.config.json` | User-level default for all projects |

### Quick setup

```bash
nav config-init
```

This creates `.nav/nav.config.json` in the current directory with sensible defaults. You can also create or edit the file manually.

A user-level config at `~/.config/nav/nav.config.json` is a good place for your API key and default model so they apply everywhere. A project-level config can then override just the settings that differ, like the model or sandbox mode.

### All config keys

| Key | Default | Description |
|-----|---------|-------------|
| `model` | `gpt-4.1` | Model name |
| `provider` | auto-detected | `openai`, `anthropic`, `google`, `ollama`, or `azure` |
| `baseUrl` | auto-detected | API base URL |
| `apiKey` | — | API key for the provider |
| `verbose` | `false` | Show diffs, token counts, timing |
| `sandbox` | `false` | Enable macOS Seatbelt sandboxing |
| `contextWindow` | auto-detected | Context window size in tokens |
| `handoverThreshold` | `0.8` | Auto-handover at this fraction of context (0–1) |
| `ollamaBatchSize` | `1024` | Ollama `num_batch` option |
| `theme` | `nordic` | Color theme (`nordic` or `classic`) |
| `hooks` | — | Optional lifecycle hooks — see [Hooks](./hooks) |
| `hookTimeoutMs` | `600000` | Max wall time per shell hook step (ms); env: `NAV_HOOK_TIMEOUT_MS` |
| `taskImplementationMaxAttempts` | `3` | Max full work+verify cycles per task in `/tasks run` / `/plans run`; env: `NAV_TASK_IMPLEMENTATION_MAX_ATTEMPTS` |
| `editMode` | `hashline` | `hashline` (LINE:HASH reads + anchor edits) or `searchReplace` (plain reads + `old_string`/`new_string` edits) |
| `parallelToolCalls` | `1` | Max tool calls from a single assistant message that may run at the same time (integer **1–32**). Values above 32 are clamped. **`1`** means tools run one after another (default). Higher values speed up independent work (e.g. several reads or shells, or multiple **`subagent`** delegations in parallel). **Nested subagent sessions always use `1`** regardless of this setting — only the top-level agent may parallelize. Plan mode **`ask_user`** forces a fully sequential batch when that tool is used. Env override: **`NAV_PARALLEL_TOOL_CALLS`**. When multiple tools run in parallel, the TUI and [UI server](./ui-server) may attach a **`colorSlot`** index on tool events so clients can color interleaved lines. |
| `tools` | all built-in tools | Optional array of tool names. Only those tools are registered with the LLM and described in the system prompt; others are hidden entirely. See [Tools](/concepts/tools) and [Subagents](./subagents). If you use an allowlist and rely on **`/plan`**, include **`ask_user`** in the array so plan mode can ask clarifying questions. |
| `subagent` | — | Optional object with defaults for [delegated subagents](./subagents) runs: same keys as top-level for model/provider/API (`model`, `provider`, `baseUrl`, `apiKey`, `azureDeployment`, `ollamaBatchSize`), plus `contextWindow`, `handoverThreshold`, and `tools` (allowlist for subagent sessions only). Each key overrides only that field; omitted keys inherit the main session’s resolved values (so e.g. **`model`** alone does not change provider or base URL). If the **`subagent`** key is missing entirely, delegated runs use the main agent’s settings. Scaffold files with **`/create-subagent`**. |

### editMode: search-replace

Use classic search-and-replace editing instead of hashline anchors:

```json
{
  "model": "gpt-4.1",
  "provider": "openai",
  "editMode": "searchReplace"
}
```

## Providers

nav supports multiple LLM providers. Each example below is a complete, ready-to-use config file. Pick your provider, fill in your key, and save as `.nav/nav.config.json` or `~/.config/nav/nav.config.json`.

### OpenAI

```json
{
  "provider": "openai",
  "model": "gpt-4.1",
  "apiKey": "sk-...",
  "contextWindow": 1047576,
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

### Anthropic

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKey": "sk-ant-...",
  "contextWindow": 200000,
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

### Google Gemini

```json
{
  "provider": "google",
  "model": "gemini-2.5-flash",
  "apiKey": "...",
  "contextWindow": 1048576,
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

### Azure OpenAI

Azure's [v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/latest) is OpenAI-compatible. Set `model` to your Azure deployment name and point `baseUrl` at your resource endpoint.

```json
{
  "provider": "azure",
  "model": "my-gpt4o-deployment",
  "baseUrl": "https://my-resource.openai.azure.com/openai/v1",
  "apiKey": "...",
  "contextWindow": 128000,
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

### Ollama

Uses the native Ollama API on port 11434. No API key needed. Context window is queried from Ollama automatically.

```json
{
  "provider": "ollama",
  "model": "llama3",
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

For a remote Ollama instance, add `baseUrl`:

```json
{
  "provider": "ollama",
  "model": "llama3",
  "baseUrl": "http://192.168.1.50:11434",
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

### LM Studio

Uses the OpenAI-compatible API. You must set `contextWindow` manually since nav can't query it from LM Studio.

```json
{
  "provider": "openai",
  "model": "local-model",
  "baseUrl": "http://localhost:1234/v1",
  "contextWindow": 32768,
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

### OpenRouter

```json
{
  "provider": "openai",
  "model": "google/gemini-2.5-flash",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "or-...",
  "contextWindow": 1048576,
  "handoverThreshold": 0.8,
  "verbose": false,
  "sandbox": false
}
```

## CLI flags and environment variables

For one-off overrides, CLI flags and environment variables are available. These take precedence over config files.

| Env var | CLI flag | Default | Description |
|---------|----------|---------|-------------|
| `NAV_MODEL` | `-m, --model` | `gpt-4.1` | Model name |
| `NAV_PROVIDER` | `-p, --provider` | auto-detected | `openai`, `anthropic`, `ollama`, `google`, or `azure` |
| `NAV_BASE_URL` | `-b, --base-url` | auto-detected | API base URL |
| `NAV_SANDBOX` | `-s, --sandbox` | off | Enable sandbox (macOS only) |
| `NAV_CONTEXT_WINDOW` | — | auto-detected | Context window size in tokens |
| `NAV_OLLAMA_BATCH_SIZE` | — | `1024` | Ollama `num_batch` option |
| `NAV_HANDOVER_THRESHOLD` | — | `0.8` | Auto-handover at this fraction of context (0–1) |
| `NAV_PARALLEL_TOOL_CALLS` | — | `1` | Max concurrent tool calls per assistant message (**1–32**); overrides `parallelToolCalls` in config files |
| `NAV_THEME` | — | `nordic` | Color theme (`nordic` or `classic`) |
| — | `-v, --verbose` | off | Show diffs, tokens, timing |
