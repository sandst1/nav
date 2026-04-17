# nav ui-server Protocol

`nav ui-server` starts a local HTTP/WebSocket backend for desktop UI clients while preserving the default terminal workflow (`nav` without subcommands).

## Start

- `nav ui-server`
- `nav ui-server --ui-host 127.0.0.1 --ui-port 7777`

Optional env vars:

- `NAV_UI_HOST`
- `NAV_UI_PORT`

Health check:

- `GET /health` -> `{ ok, protocolVersion, cwd, threadCount }`

WebSocket endpoint:

- `ws://<host>:<port>/ws`

## Protocol Version

- Current `protocolVersion`: `2`
- Version is sent in `session.ready`.

### v2 Changes (Thread Support)

Protocol v2 introduces **multi-thread support** for orchestration UIs:

- Multiple independent agent conversations (threads) can run in parallel
- Multiple WebSocket clients can connect simultaneously
- All thread-scoped events include `threadId`
- New message types for thread lifecycle management

## Client -> Server

### Session Management

- `session.start`
  - optional payload: `{ protocolVersion?: number }`
- `session.stop`

### Thread Management

- `thread.create`
  - optional payload: `{ threadId?: string }` — provide your own UUID or let the server generate one
  - server responds with `thread.created`
- `thread.list`
  - server responds with `thread.list`
- `thread.delete`
  - payload: `{ threadId: string }`
  - server responds with `thread.deleted` on success

### Agent Interaction

- `message.user`
  - payload: `{ threadId: string, text: string }`
  - requires a valid `threadId` — create a thread first
- `run.cancel`
  - payload: `{ threadId: string }`
  - cancels the active run on the specified thread

## Server -> Client

### Session Events

- `session.ready`
  - payload: `{ protocolVersion, model, provider, cwd, sandbox }`
  - sent on connection and in response to `session.start`

### Thread Events

- `thread.created`
  - payload: `{ threadId: string }`
  - broadcast to all clients
- `thread.list`
  - payload: `{ threads: [{ threadId, createdAt, messageCount, isRunning }] }`
  - sent only to requesting client
- `thread.deleted`
  - payload: `{ threadId: string }`
  - broadcast to all clients

### Agent Events (Thread-Scoped)

All agent events include `threadId` to identify which thread they belong to:

- `assistant.delta`
  - payload: `{ threadId, text }`
- `assistant.done`
  - payload: `{ threadId, text }`
- `tool.call`
  - payload: `{ threadId, name, args }`
- `tool.result`
  - payload: `{ threadId, summary, hasDiff, diff? }`
- `status`
  - payload: `{ threadId?, phase, message? }`
  - `threadId` is optional for server-wide status messages
  - interactive workflows emit `phase: "prompt"` and expect the next `message.user` as the response
- `error`
  - payload: `{ threadId?, message }`
  - `threadId` is optional for server-wide errors

## Thread Model

Each thread is an independent agent session:

- Own conversation history (isolated from other threads)
- Own run queue (messages within a thread are serialized)
- Parallel execution across threads (multiple threads can run simultaneously)

```
┌─────────────────────────────────────────────────────┐
│                    UI Server                         │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Thread A │  │ Thread B │  │ Thread C │  ...     │
│  │ Agent    │  │ Agent    │  │ Agent    │          │
│  │ History  │  │ History  │  │ History  │          │
│  │ RunQueue │  │ RunQueue │  │ RunQueue │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│        ▲             ▲             ▲                │
│        └─────────────┼─────────────┘                │
│                      │                              │
│              ┌───────┴───────┐                      │
│              │ ThreadManager │                      │
│              └───────────────┘                      │
│                      ▲                              │
│         ┌────────────┼────────────┐                 │
│         │            │            │                 │
│    ┌────┴────┐  ┌────┴────┐  ┌────┴────┐           │
│    │Client 1 │  │Client 2 │  │Client 3 │   ...    │
│    └─────────┘  └─────────┘  └─────────┘           │
└─────────────────────────────────────────────────────┘
```

## Example Flow

```javascript
// 1. Connect
const ws = new WebSocket("ws://localhost:7777/ws");

// 2. Wait for session.ready
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "session.ready") {
    // 3. Create a thread
    ws.send(JSON.stringify({ type: "thread.create" }));
  }
  if (msg.type === "thread.created") {
    const { threadId } = msg.payload;
    // 4. Send a message to the thread
    ws.send(JSON.stringify({
      type: "message.user",
      payload: { threadId, text: "Hello, agent!" }
    }));
  }
  // 5. Handle agent responses
  if (msg.type === "assistant.delta") {
    console.log(`[${msg.payload.threadId}] ${msg.payload.text}`);
  }
};
```

## Parallel Orchestration

To run multiple agents in parallel:

```javascript
// Create multiple threads
ws.send(JSON.stringify({ type: "thread.create" }));
ws.send(JSON.stringify({ type: "thread.create" }));
ws.send(JSON.stringify({ type: "thread.create" }));

// After receiving thread.created for each, send messages
// All three will execute in parallel
ws.send(JSON.stringify({
  type: "message.user",
  payload: { threadId: threadA, text: "Task A" }
}));
ws.send(JSON.stringify({
  type: "message.user",
  payload: { threadId: threadB, text: "Task B" }
}));
ws.send(JSON.stringify({
  type: "message.user",
  payload: { threadId: threadC, text: "Task C" }
}));
```

## Notes

- If a user message arrives while a thread's run is active, it is queued as an interjection.
- `run.cancel` maps to the same abort flow used in terminal mode.
- Supported interactive flows in ui-server mode:
  - `/tasks add`
  - `/plan`
  - `/plans split`
  - `/plans microsplit`
- Currently terminal-only workflows:
  - `/tasks run`
  - `/plans run`
- Thread events (`thread.created`, `thread.deleted`) are broadcast to all connected clients.
- Agent events are broadcast to all clients (filtering by thread subscription is left to the client).
