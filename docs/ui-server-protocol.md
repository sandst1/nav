# nav ui-server Protocol

`nav ui-server` starts a local HTTP/WebSocket backend for desktop UI clients while preserving the default terminal workflow (`nav` without subcommands).

## Start

- `nav ui-server`
- `nav ui-server --ui-host 127.0.0.1 --ui-port 7777`

Optional env vars:

- `NAV_UI_HOST`
- `NAV_UI_PORT`

Health check:

- `GET /health` -> `{ ok, protocolVersion, cwd }`

WebSocket endpoint:

- `ws://<host>:<port>/ws`

## Protocol Version

- Current `protocolVersion`: `1`
- Version is sent in `session.ready`.

## Client -> Server

- `session.start`
  - optional payload: `{ protocolVersion?: number }`
- `message.user`
  - payload: `{ text: string }`
- `run.cancel`
- `session.stop`

## Server -> Client

- `session.ready`
  - payload: `{ protocolVersion, model, provider, cwd, sandbox }`
- `assistant.delta`
  - payload: `{ text }`
- `assistant.done`
  - payload: `{ text }`
- `tool.call`
  - payload: `{ name, args }`
- `tool.result`
  - payload: `{ summary, hasDiff, diff? }`
- `status`
  - payload: `{ phase, message? }`
  - interactive workflows emit `phase: "prompt"` and expect the next `message.user` text as the response
- `error`
  - payload: `{ message }`

## Notes

- If a user message arrives while a run is active, it is queued as an interjection.
- `run.cancel` maps to the same abort flow used in terminal mode.
- Commands that require interactive terminal prompts are currently rejected in ui-server mode with an `error` event.
- Supported interactive flows in ui-server mode:
  - `/tasks add`
  - `/plan`
  - `/plans split`
  - `/plans microsplit`
- Currently terminal-only workflows:
  - `/tasks run`
  - `/plans run`
