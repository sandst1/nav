# Tools

nav has seven focused tools. Each tool takes parameters and returns structured results (success/error, data, messages). Tool schemas use JSON Schema for LLM function calling.

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
