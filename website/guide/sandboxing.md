# Sandboxing

::: warning
By default, nav runs without any sandbox. Shell commands the agent executes have full access to your system — it can read, write, and delete files anywhere your user account can.
:::

Enable sandboxing to restrict what the agent can do:

```bash
# Via CLI flag
nav -s "task"

# Or via environment variable
export NAV_SANDBOX=1
```

Or set it permanently in your project or user config:

```json
// .nav/nav.config.json
{
  "sandbox": true
}
```

## How it works

The sandbox uses **macOS Seatbelt** (`sandbox-exec`) and is **macOS only**. On other platforms, `-s` will exit with an error.

When enabled, all processes spawned by nav (including shell commands) inherit these restrictions:

- **File writes** are limited to the current project directory, temp, and cache directories. Writes anywhere else are denied by the kernel.
- **File reads** are unrestricted — the agent can still read your whole filesystem.
- **Network** is unrestricted — needed for LLM API calls.

## Customization

The Seatbelt profile lives in `sandbox/nav-permissive.sb` in the nav source and can be customized for stricter or more relaxed policies.

## Platform support

| Platform | Status |
|----------|--------|
| macOS | Supported (Seatbelt) |
| Linux | Not yet supported |
| Windows | Not yet supported |
