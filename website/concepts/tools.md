# Tools

nav exposes a small set of built-in tools (read, edit, write, skim, filegrep, shell, shell_status), plus **subagent** delegation when configured. Each tool takes parameters and returns structured results (success/error, data, messages). Tool schemas use JSON Schema for LLM function calling.

## Tool allowlists

In `nav.config.json`, the optional **`tools`** array lists tool names the main session may use. When set, only those tools are sent to the provider and only those capabilities are described in the system prompt, so the model never sees disallowed tools. Valid names: `read`, `edit`, `write`, `skim`, `filegrep`, `shell`, `shell_status`, `subagent`, and (in plan mode) `ask_user`.

A separate **`subagent.tools`** array under the **`subagent`** object sets the default allowlist for delegated runs. If omitted, each subagent inherits the main agent’s `tools` setting (or all tools if `tools` is unset).

See [Subagents](/guide/subagents) for delegation and `.nav/subagents/*.md`.

## read

Reads a file with hashline-prefixed output. Each line gets a `LINE:HASH|` prefix.

```
42:a3|const foo = "bar";
43:f1|const baz = 42;
```

Used as the starting point for any edit operation — the model needs to see the hashline anchors before it can reference them.

## edit

Edits a file by referencing `LINE:HASH` anchors from a previous read. The model specifies a range of anchors and provides replacement content.

If hashes don't match the current file (e.g., the file was modified), the edit is rejected with corrected anchors so the model can retry.

Pass an **`edits`** array to apply multiple changes to the same file atomically — all steps are applied in-memory and written in a single operation. Each item uses `anchor`/`end_anchor`/`new_text` (hashline mode) or `old_string`/`new_string`/`replace_all` (searchReplace mode).

## write

Creates a new file. Used when the model needs to add a file that doesn't exist yet.

## skim

Reads a specific line range with hashline output. Useful for large files where the model only needs to see a portion — avoids reading the entire file into context.

## filegrep

Searches within a single file for a pattern and returns matching lines with surrounding context, all in hashline format. Useful for finding specific code before editing.

## shell

Executes shell commands. Commands that don't finish within a configurable timeout (`wait_ms`) are automatically backgrounded. The model gets the output so far and can check back later.

When [sandboxing](/guide/sandboxing) is enabled, shell commands inherit the Seatbelt restrictions.

## shell_status

Checks on background processes started by the `shell` tool. Can:

- Read accumulated output from a background process
- Check if a process is still running
- Kill a background process

## subagent

Runs a nested agent with its own system prompt (from `.nav/subagents/<id>.md`) and optional model or tool allowlist overrides. The parent session receives the subagent’s final reply as the tool result. See the [Subagents guide](/guide/subagents).
