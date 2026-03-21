# Hooks

Hooks are **deterministic steps** wired into nav at specific lifecycle points. They are configured in `nav.config.json` under `hooks`.

- **`stop`** — After each completed `agent` turn (shell steps only). Failures are logged and do not block the session.
- **`taskDone`** — After the model finishes working a task in `/tasks run` or `/plans run`, **before** the task is marked `done`. Supports `maxAttempts`: on failure, hook output is appended as a user message and the model continues in the **existing** conversation until verification passes or attempts are exhausted.
- **`planDone`** — When `/plans run` has no remaining work for that plan (all tasks are `done`). Same retry pattern as `taskDone`.

`taskDone` and `planDone` are only evaluated in the **terminal** REPL. The `nav ui-server` transport runs **`stop`** hooks after each run; task/plan hooks are not available there until work loops exist for the UI.

**Implementation attempts** (`taskImplementationMaxAttempts` in config, default **3**, env `NAV_TASK_IMPLEMENTATION_MAX_ATTEMPTS`): each “implementation” is one full **work** run (`buildWorkPrompt`) plus **taskDone** verification. If that cycle does not end with the task marked `done` (after hook retries inside `taskDone`), nav counts that as a failed implementation and may **retry the whole cycle** (fresh `clearHistory` + work prompt) up to this limit. When the limit is reached, **`/tasks run` and `/plans run` stop** so later tasks are not started while the current task is still blocked.

## Config shape

```json
{
  "hooks": {
    "stop": [{ "shell": "echo stop >> .nav/hook.log" }],
    "taskDone": [
      {
        "maxAttempts": 3,
        "steps": [
          { "shell": "bun run lint" },
          { "command": "verify" }
        ]
      }
    ],
    "planDone": [{ "steps": [{ "shell": ".nav/hooks/plan-done.sh" }] }]
  },
  "hookTimeoutMs": 600000,
  "taskImplementationMaxAttempts": 3
}
```

- **`steps`** — Run in order. Each entry is either `{ "shell": "<sh -c string>" }` or `{ "command": "<name>" }` (optional `"args": "..."`). The command name refers to a [custom slash command](/guide/commands) (markdown in `.nav/commands/<name>.md`). Command steps run an extra `agent` turn with that prompt (LLM), not a subprocess.
- **`maxAttempts`** — Applies to the whole `steps` sequence for that group (default `1`). One attempt runs all steps; on first failure, nav may send the combined output to the model and run another attempt.
- **`hookTimeoutMs`** — Optional; default is ten minutes per shell step. Set `NAV_HOOK_TIMEOUT_MS` to override by environment.

You can list several objects inside `taskDone` or `planDone`; nav merges them into one group (concatenated `steps`, `maxAttempts` = maximum of the listed groups).

## Command step `args` and `{input}`

Optional **`args`** is a string that is substituted into the custom command’s **`{input}`** placeholders (same as manual `/command text`). You can embed **`${VAR}`**; each name is replaced using the **same variables as shell steps for that event** (see below), layered on top of **`process.env`** (hook values win).

Example:

```json
{ "command": "verify", "args": "Focus on task ${NAV_TASK_ID} (${NAV_TASK_NAME})." }
```

Use `{input}` in `.nav/commands/verify.md` where the dynamic part should appear. If the markdown has no `{input}`, `args` has no effect.

## Environment variables (shell steps)

These variables are also available for **`${...}` expansion** in command **`args`**. Common:

| Variable | Description |
|----------|-------------|
| `NAV_HOOK` | `stop`, `taskDone`, or `planDone` |
| `NAV_CWD` | Project directory |

**taskDone**

| Variable | Description |
|----------|-------------|
| `NAV_TASK_ID` | Task id (e.g. `1-2`) |
| `NAV_TASK_NAME` | Task title |
| `NAV_PLAN_ID` | Set when the task belongs to a plan |
| `NAV_PLAN_NAME` | Plan title |
| `NAV_ATTEMPT` | 1-based attempt number |

**planDone**

| Variable | Description |
|----------|-------------|
| `NAV_PLAN_ID` | Plan id |
| `NAV_PLAN_NAME` | Plan title |
| `NAV_PLAN_TASK_COUNT` | Number of tasks in that plan |
| `NAV_ATTEMPT` | 1-based attempt number |

## Examples

**Lint and test after each task:**

```json
"taskDone": [{
  "maxAttempts": 5,
  "steps": [
    { "shell": "bun run lint" },
    { "shell": "bun test" }
  ]
}]
```

**Delegate review to a custom `/verify` command:**

Put `.nav/commands/verify.md` with your checklist, then:

```json
"taskDone": [{ "maxAttempts": 3, "steps": [{ "command": "verify" }] }]
```

## See also

- [Configuration](./configuration) — all config keys
- [Plans & Tasks](./plans-and-tasks) — when `taskDone` / `planDone` run
