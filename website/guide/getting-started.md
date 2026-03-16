# Getting Started

## Installation

### Quick install (recommended)

::: code-group

```bash [curl]
curl -fsSL https://raw.githubusercontent.com/sandst1/nav/main/install.sh | bash
```

```bash [wget]
wget -qO- https://raw.githubusercontent.com/sandst1/nav/main/install.sh | bash
```

:::

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
tar -xzf nav-darwin-arm64.tar.gz
mv nav-darwin-arm64 /usr/local/bin/nav
chmod +x /usr/local/bin/nav
```

### From source

Requires [Bun](https://bun.sh) runtime (1.0+).

```bash
curl -fsSL https://bun.sh/install | bash
```

```bash
git clone https://github.com/sandst1/nav.git
cd nav
bun install
bun link
```

## Configuration

The recommended way to configure nav is with a config file. You can create one per-project or a global user-level default:

```bash
# Create a project config in <current-dir>/.nav/nav.config.json
nav config-init
```

Or create one manually at `~/.config/nav/nav.config.json` to set your defaults across all projects:

```json
{
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "apiKey": "sk-ant-..."
}
```

The `apiKey` field accepts any provider's key — nav resolves the right one based on the provider. You can also set API keys via environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), but a config file keeps things in one place.

See [Configuration](/guide/configuration) for all options and provider setup (Azure, Ollama, LM Studio, OpenRouter, and more).

## First run

```bash
# Interactive mode
nav

# One-shot mode
nav "describe this codebase"

# With a specific model
nav -m claude-sonnet-4-20250514 "add error handling to the API routes"

# Verbose mode (diffs, token counts, timing)
nav -v "refactor the auth module"

# Reference files with @ — their contents are included in the prompt
nav "explain @src/auth.ts and refactor the error handling"
```

## Keyboard shortcuts

- **ESC** — stop the current agent execution and return to prompt
- **Ctrl-D** — exit nav
- Type while the agent is working to queue a follow-up message
