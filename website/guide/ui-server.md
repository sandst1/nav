# UI server and custom clients

`nav ui-server` runs nav as a **local HTTP and WebSocket backend** so you can drive the same agent (tools, model, project `cwd`) from a **desktop shell, Electron app, Tauri window, or browser UI** you build yourself. The default terminal workflow (`nav` with no subcommand) is unchanged.

This page is a **step-by-step path** to a working client. For every message type and field, see the canonical protocol: [ui-server protocol (GitHub)](https://github.com/sandst1/nav/blob/main/docs/ui-server-protocol.md).

## Prerequisites

- [nav installed](./getting-started) and on your `PATH`.
- Same **configuration** as the CLI: model, provider, API keys, and project settings apply to ui-server ([Configuration](./configuration)). The server uses the **current working directory** as the project root (`cwd` is reported in `session.ready` and `/health`).
- Treat the server as **local-only**: bind to `127.0.0.1` unless you know you need otherwise.

## Step 1 — Start the server

From your project directory:

```bash
nav ui-server
```

Optional host and port:

```bash
nav ui-server --ui-host 127.0.0.1 --ui-port 7777
```

Environment variables: `NAV_UI_HOST`, `NAV_UI_PORT`.

**Health check** (optional):

```bash
curl -s http://127.0.0.1:7777/health
```

You should see JSON including `ok`, `protocolVersion`, `cwd`, and `threadCount`. Other HTTP paths: `GET /` returns plain text identifying the server; WebSocket upgrades use `/ws` (below).

## Step 2 — Open a WebSocket session

Connect to:

```txt
ws://<host>:<port>/ws
```

On connect, the server sends **`session.ready`** with `protocolVersion`, `model`, `provider`, `cwd`, and `sandbox`. You do not have to send anything first.

You may send **`session.start`** (optional payload `{ protocolVersion?: number }`) to receive **`session.ready`** again — useful if your client reconnects logic relies on a explicit handshake. The client `protocolVersion` field is currently **not validated**; the server always speaks the version it advertises in `session.ready`.

Close the socket with **`session.stop`** or by closing the WebSocket from the client.

## Step 3 — Create threads (conversations)

Protocol v2 is **multi-thread**: each **thread** is one independent agent with its own message history. Messages on a single thread are **serialized** (one run at a time per thread). **Different threads can run at the same time.**

Send:

```json
{ "type": "thread.create" }
```

Optional payload:

```json
{
  "type": "thread.create",
  "payload": {
    "threadId": "<your-uuid>",
    "systemPromptPrefix": "You are a focused code reviewer..."
  }
}
```

- If you omit `threadId`, the server generates one.
- The server broadcasts **`thread.created`** to **all** connected WebSocket clients with `{ "threadId": "..." }`.

**List threads** (metadata for sidebars):

```json
{ "type": "thread.list" }
```

The requesting client receives **`thread.list`** with `threads`: `threadId`, `createdAt`, `messageCount`, `isRunning`.

**Delete** a thread:

```json
{ "type": "thread.delete", "payload": { "threadId": "<id>" } }
```

On success, **`thread.deleted`** is broadcast. If the id is unknown, the server sends **`error`** with that `threadId` instead.

**Edge case:** If you send **`thread.create`** with a `threadId` that **already exists**, the server does not create a duplicate thread but still broadcasts **`thread.created`** with that id. Track thread ids in your UI or always use server-generated ids to avoid surprises.

## Step 4 — Send chat and stream results

Send user text to a specific thread:

```json
{
  "type": "message.user",
  "payload": { "threadId": "<id>", "text": "Read src/foo.ts and summarize it." }
}
```

Empty or whitespace-only `text` is **ignored** (no error).

Subscribe to server messages and route by **`threadId`** (and by `type`):

| Type | Purpose |
|------|---------|
| `assistant.delta` | Streaming assistant text chunk |
| `assistant.done` | Final assistant message for the turn |
| `tool.call` | Tool name and arguments |
| `tool.result` | Short summary; may include `diff` when there is a file diff |
| `status` | Lifecycle and UI hints (`phase` — see below) |
| `error` | Failure; `threadId` may be absent for global errors |

Assistant and tool events always include **`threadId`**. **`status`** and **`error`** may omit `threadId` for server-wide messages.

### `status.phase` values

Your UI can use these (non-exhaustive; new phases may appear):

| Phase | Typical meaning |
|-------|-----------------|
| `running` / `idle` | Agent run started / finished |
| `queued` | User message held until the current run finishes |
| `prompt` | Server is waiting for the **next** `message.user` on this thread (e.g. confirmation in `/tasks add` or `/plan`) |
| `info` / `success` / `print` | Informational lines, success toasts, printable text |
| `aborted` | Run was cancelled |
| `interjection` | Queued user input applied during a run |
| `handover` | Context handover in progress |

## Step 5 — Build a multi-thread UI

**Broadcast model:** Thread lifecycle and agent events are sent to **every** connected client. Your UI should **filter** by `threadId` (e.g. tabs, columns, or a board of cards).

**Parallel orchestration:** Create several threads, then send **`message.user`** to each with different `threadId`s — runs proceed **concurrently** across threads.

**Suggested layout:**

- Sidebar or list from **`thread.list`** (`isRunning` for a spinner, `messageCount` for activity).
- Main area keyed by `threadId` for transcript + tool timeline.
- **`run.cancel`** per thread when the user stops generation.

```
  Client 1 ──┐
  Client 2 ──┼── WebSocket ──► ThreadManager ──► Thread A (history + queue)
  Client 3 ──┘                              └──► Thread B (history + queue)
```

Production clients should not assume they are the only WebSocket — ignore **`thread.created`** unless you just requested a new thread, or merge by `threadId` into your state.

## Step 6 — Agent roles (`systemPromptPrefix`)

When creating a thread, optional **`systemPromptPrefix`** defines a **custom role**:

- The string is **prepended** to the same **operational** system prompt nav uses in the terminal (tools, edit mode, exploration hints, `~/.config/nav/nav.md`, `.nav/nav.md`, `AGENTS.md`, and skills).
- Nav’s default one-line identity (**“You are nav…”**) is **omitted** when the prefix is non-empty after trim, so your prefix sets the persona instead.

Example prefixes:

- “You are a security reviewer. Prefer concise findings and severity labels.”
- “You are writing tests only; do not change production code unless asked.”

**Important — role persistence:** Some slash commands **reload** the system prompt from disk **without** re-applying `systemPromptPrefix` — notably **`/clear`** and **`/init`**. After those commands on a ui-server thread, the custom role may be **lost** until you **create a new thread** with the prefix again. **`/plans split`** and **`/plans microsplit`** also rebuild the system prompt for their internal run; expect the default nav identity to return for that flow unless you recreate the thread.

## Cancellation and queued messages

- **`run.cancel`** with `{ "threadId": "<id>" }` aborts the active run on that thread (same abort path as the terminal).
- If the user sends **`message.user`** while a run is still active, nav **queues** the text and emits **`status`** with `phase: "queued"**.

## Interactive slash commands in ui-server

Flows that need typed confirmation use **`status`** with `phase: "prompt"` and a `message` explaining the prompt; the user’s reply is the **next** **`message.user`** on that thread. Supported in ui-server include **`/tasks add`**, **`/plan`**, **`/plans split`**, and **`/plans microsplit`**.

**Not supported** over ui-server (use the terminal REPL): **`/tasks run`** and **`/plans run`** — the server returns an **error** explaining they are terminal-only.

## Hooks

See [Hooks](./hooks): in ui-server mode, **`stop`** hooks run after each completed agent turn; **`taskDone`** and **`planDone`** are terminal-only today.

## Full protocol reference

Message shapes, examples, and notes are maintained in the repo:

**[docs/ui-server-protocol.md](https://github.com/sandst1/nav/blob/main/docs/ui-server-protocol.md)**

Use that document when implementing parsers and when tracking protocol version changes.
