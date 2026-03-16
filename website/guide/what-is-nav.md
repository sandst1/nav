# What is nav?

nav is a minimalist AI coding agent that uses a unique **hashline-based editing system** for precise code modifications. Instead of reproducing entire files, it references lines by `LINE:HASH` anchors, preventing edit conflicts when files change.

## Key ideas

- **Hashline editing** — each line is tracked by a short content hash. Edits reference anchors like `42:a3` instead of reproducing old code. If the file changed, hashes won't match and the edit is safely rejected with corrected anchors.

- **Built for Bun** — leverages Bun's native APIs (`Bun.file()`, `Bun.spawn()`, `Bun.hash.xxHash32()`) for optimal performance. Ships as single-binary builds for macOS, Linux, and Windows.

- **Multi-provider** — works with OpenAI, Anthropic, Google Gemini, Azure OpenAI, Ollama, LM Studio, and OpenRouter. Auto-detects the provider from the model name.

- **Minimal by design** — seven tools, no frameworks, no UI libraries. Terminal output uses ANSI codes directly. Dependencies are limited to LLM SDKs.

## Tools

nav has seven focused tools:

| Tool | Purpose |
|------|---------|
| **read** | Read files with hashline-prefixed output |
| **edit** | Edit files by referencing `LINE:HASH` anchors |
| **write** | Create new files |
| **skim** | Read a specific line range with hashline output |
| **filegrep** | Search within a file with context lines |
| **shell** | Run shell commands (with background support) |
| **shell_status** | Check on background processes |

## Who is it for?

Developers who want a fast, minimal coding assistant that can navigate codebases, make precise edits, and execute tasks without reproducing large code blocks. nav works best when you want to stay in the terminal and let an LLM handle the editing while you steer.
