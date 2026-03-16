# Handover

For long tasks, handover lets you reset context without losing track of progress.

## Manual handover

Use `/handover` to trigger a handover. The model summarizes what it's done, the conversation is cleared, and a fresh context starts with the summary, a current file tree, and any instructions you provide:

```
> /handover now write tests for the auth module
```

This is useful when context is getting long and you want to refocus the model on the next phase of work.

## Auto-handover

nav can automatically trigger a handover when the conversation approaches the model's context window limit. This prevents context overflow errors and keeps the model working effectively.

### How it works

1. nav tracks token usage after each response
2. When usage crosses the threshold (default: 80% of the context window), a handover is triggered
3. The agent completes its current step, generates a summary, and continues in a fresh context
4. If the threshold is reached after the model finishes responding, the auto-handover triggers on the next user message

### Configuration

```bash
# Override context window (e.g. for LM Studio or custom endpoints)
export NAV_CONTEXT_WINDOW=32768

# Trigger auto-handover at 90% instead of the default 80%
export NAV_HANDOVER_THRESHOLD=0.9
```

### Context window detection

Context window sizes are auto-detected per provider:

| Provider | Detection method |
|----------|-----------------|
| OpenAI / Anthropic / Gemini | Built-in table of known models |
| Ollama | Queried from the Ollama API at startup |
| LM Studio / custom | Set manually via `NAV_CONTEXT_WINDOW` |

### Verbose mode

In verbose mode (`-v`), each response shows context utilization:

```
tokens: 45.2k in / 1.2k out (3.1s) (35% of 128k ctx)
```
