# Subagents

Subagents let the main agent **delegate** a self-contained task to another model session with a **custom system prompt**, optional **different model/settings**, and optional **tool allowlist**.

You set them up in two places: **markdown definitions** under **`.nav/subagents/`** (who each specialist is and what they should do) and **`nav.config.json`** (defaults for every delegated run, whether the main session may call **`subagent`**, and optional parallel tool execution). The sections below cover both.

## `/create-subagent`

Run **`/create-subagent`** (optionally **`/create-subagent <id> <purpose...>`**) to have the main agent walk through creating a file:

1. Asks for **id** (filename stem) and **purpose** if you did not pass them on the command line.
2. Proposes **frontmatter** (`name`, `description`) and a full **body** (system prompt) for that subagent.
3. Creates **`.nav/subagents/<id>.md`** in the correct format.

After the run, the session reloads the system prompt so **`<available_subagents>`** can include the new entry without `/clear`.

## Definitions: `.nav/subagents/*.md`

Create markdown files under **`.nav/subagents/`** (project root). The **filename stem** is the subagent **id** (for example `researcher.md` → id `researcher`).

Each file uses **YAML frontmatter** and a **body**:

- **`name`** — Short display name (shown in the main system prompt catalog).
- **`description`** — One-line summary (shown next to the name).

The **body** (after the closing `---` of the frontmatter) becomes the **role prefix** for that subagent. It is prepended to the same shared project prompt the main agent uses (`nav.md`, `AGENTS.md`, skills, hashline rules, etc.), with the default “You are nav…” identity omitted — similar to a custom role on the [UI server](./ui-server).

Example `.nav/subagents/researcher.md`:

```markdown
---
name: Repo researcher
description: Read-only exploration and summarization
---

You are a read-only assistant. Do not edit files or run destructive shell commands.
Summarize findings clearly for the parent agent.
```

Example `.nav/subagents/reviewer.md` (a second id the main agent might call alongside `researcher`):

```markdown
---
name: Code reviewer
description: Focused review against project conventions
---

You review proposed changes for correctness and style. Do not modify files unless asked.
Report issues as a short list for the parent agent.
```

## Configuration (`nav.config.json`)

Project and user config files control **how** delegations run, not the per-id prompts (those stay in **`.nav/subagents/*.md`**).

### `subagent` defaults

An optional **`subagent`** object supplies **defaults for every delegated run**. Any field omitted falls back to the main agent’s resolved value (including **`provider`**, **`baseUrl`**, and **`contextWindow`**). Setting **`model`** alone switches the subagent model name only; set **`provider`** / **`baseUrl`** / **`apiKey`** when you need a different API or vendor.

Supported keys:

| Key | Purpose |
|-----|---------|
| `model`, `provider`, `baseUrl`, `apiKey`, `azureDeployment`, `ollamaBatchSize` | Same as top-level — override provider/model for subagents |
| `contextWindow`, `handoverThreshold` | Subagent context and auto-handover threshold |
| `tools` | Allowlist for subagent sessions only (same name strings as top-level `tools`) |

If the entire **`subagent`** key is missing, delegated runs use the main agent’s model and **`tools`** (if any).

Example combining **`parallelToolCalls`** (see below) with **`subagent`** defaults:

```json
{
  "parallelToolCalls": 3,
  "subagent": {
    "model": "gpt-4.1-mini",
    "tools": ["read", "skim", "filegrep"]
  }
}
```

### Main session `tools`

Top-level **`tools`** restricts which tools the **main** session may use. Omitted means all built-in tools, including **`subagent`**. To disable delegation, omit **`subagent`** from the `tools` array; the catalog still lists defined subagents but notes that delegation is not enabled.

If you set **`subagent.tools`**, that list is the default allowlist for nested sessions; if **`subagent.tools`** is omitted, each subagent inherits the main agent’s **`tools`** setting (or all tools when **`tools`** is unset). See [Tools](/concepts/tools) for valid tool names.

### `parallelToolCalls`

When the main session’s **`parallelToolCalls`** (in **`nav.config.json`** or env **`NAV_PARALLEL_TOOL_CALLS`**) is greater than **`1`**, several tool calls from a **single** assistant message—including multiple **`subagent`** calls with different **`agent`** / **`prompt`** pairs—may run **concurrently**. Use that when subtasks are independent (for example, delegating to `researcher` and `reviewer` in parallel on separate questions). Each subagent still consumes its own tokens and API usage at the same time.

**Nested** runs (a subagent that itself calls **`subagent`**) always use a parallel limit of **`1`** regardless of config—only the **top-level** agent may parallelize tool calls from one message.

See **`parallelToolCalls`** in [Configuration](./configuration) for allowed values (1–32, clamped), **`colorSlot`** when the TUI or [UI server](./ui-server) interleaves parallel tool output, and plan mode **`ask_user`** forcing a sequential batch.

## Main agent catalog

When at least one subagent file exists, the main system prompt includes an **`<available_subagents>`** block listing **name**, **description**, and **id**, like skills. If the **`subagent`** tool is allowed for the session, a line explains how to call it with `agent` (the id) and `prompt` (the task).

## Delegation: `subagent` tool

The model calls the **`subagent`** tool with:

- **`agent`** — Subagent id (filename stem).
- **`prompt`** — Task or question for that subagent.

The subagent runs to completion in a **separate** context (and separate background shell tracker), then returns its final assistant text to the parent.

## Further reading

- [Configuration](./configuration) — all `nav.config.json` keys, including **`parallelToolCalls`** and **`NAV_PARALLEL_TOOL_CALLS`**
- [Tools](/concepts/tools) — tool allowlists and built-in tools
