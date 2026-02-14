# Nav Feature Plan: Ollama Native API, Handover Tool, Slash Commands

## Feature 1: Native Ollama Provider (via `ollama` npm package)

### Motivation
Currently Ollama is accessed through the OpenAI-compatible `/v1` endpoint. Using the native `ollama` JS library gives us:
- Direct access to Ollama-specific features (model management, `keep_alive`, `think` mode)
- Proper tool calling format (Ollama's `tool_calls` return arguments as objects, not JSON strings — avoids double-parse issues)
- Streaming that matches Ollama's actual response shape
- Foundation for future Ollama-specific features (pull models, list models, etc.)

### Changes

**`package.json`** — add dependency:
```
"ollama": "^0.5"
```

**`src/config.ts`** — add `"ollama"` as a new provider:
```typescript
export type Provider = "openai" | "anthropic" | "ollama";
```
- `detectProvider()`: if model name matches known local models (llama, mistral, qwen, gemma, phi, deepseek) OR model doesn't match any cloud pattern → return `"ollama"`
- `detectBaseUrl()`: for ollama provider, return `"http://127.0.0.1:11434"` (note: no `/v1` suffix — native API)
- `findApiKey()`: ollama provider doesn't need a key, return `""`
- Update `CliFlags` and `parseArgs`: no new flags needed, existing `-p ollama` works
- Update help text to list `ollama` as a provider option

**`src/llm.ts`** — add `createOllamaClient()`:
```typescript
import { Ollama } from "ollama";

function createOllamaClient(config: Config): LLMClient {
  const client = new Ollama({ host: config.baseUrl || "http://127.0.0.1:11434" });
  const tools = getOllamaTools(); // new export from tools/index.ts

  return {
    async *stream(systemPrompt, messages) {
      // Convert nav messages → Ollama message format
      // Ollama messages: { role, content, tool_calls?, tool_name? }
      const ollamaMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map(convertToOllama),
      ];

      const response = await client.chat({
        model: config.model,
        messages: ollamaMessages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      });

      let assistantText = "";
      const toolCalls: ToolCallInfo[] = [];

      for await (const chunk of response) {
        // chunk.message.content contains text delta
        if (chunk.message.content) {
          assistantText += chunk.message.content;
          yield { type: "text", text: chunk.message.content };
        }
        // Tool calls come in the final chunk (when chunk.done === true)
        if (chunk.message.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            toolCalls.push({
              id: `call_${toolCalls.length}`,  // Ollama doesn't provide IDs
              name: tc.function.name,
              arguments: JSON.stringify(tc.function.arguments), // arguments is already an object
            });
          }
        }
      }

      // Yield completed tool calls
      for (const tc of toolCalls) {
        yield { type: "tool_call", toolCall: tc };
      }

      // Ollama streaming doesn't provide usage stats in the same way,
      // but the final chunk has eval_count and prompt_eval_count
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0 }, // populate from final chunk if available
      };
    },
  };
}
```

Message conversion (`convertToOllama`):
- `user` → `{ role: "user", content }`
- `assistant` with tool_calls → `{ role: "assistant", content, tool_calls: [{ function: { name, arguments: JSON.parse(args) }}] }`
- `tool` result → `{ role: "tool", content, tool_name: <name> }` (Ollama uses `tool_name` instead of `tool_call_id` — we need to look up the tool name from the corresponding assistant message)

**`src/tools/index.ts`** — add `getOllamaTools()`:
```typescript
// Ollama uses the same format as OpenAI's function calling
export function getOllamaTools() {
  return toolDefs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
```

**`src/llm.ts` factory** — update `createLLMClient()`:
```typescript
export function createLLMClient(config: Config): LLMClient {
  if (config.provider === "anthropic") return createAnthropicClient(config);
  if (config.provider === "ollama") return createOllamaClient(config);
  return createOpenAIClient(config);
}
```

### Key Design Decisions
- Ollama doesn't provide tool call IDs — we generate synthetic `call_0`, `call_1`, etc. This is fine because tool results are matched by `tool_name` in Ollama, not by ID.
- For the tool result message, Ollama expects `{ role: "tool", content: "...", tool_name: "read" }` rather than OpenAI's `tool_call_id`-based matching. The `convertToOllama` function needs to resolve the tool name from the preceding assistant message's tool_calls.
- Usage stats: Ollama's final streaming chunk includes `eval_count` (output tokens) and `prompt_eval_count` (input tokens) — we can map these to our usage format.
- The OpenAI-compatible path (`-p openai -b http://localhost:11434/v1`) still works for users who prefer it.

---

## Feature 2: Handover Tool

### Motivation
Local LLMs degrade with long contexts. Handover lets the model self-segment work: complete a self-contained step, write notes, then restart with a fresh context. This improves quality and speed for multi-step tasks.

### How It Works

1. User starts nav with `--enable-handover` flag
2. A `handover` tool is added to the tool set, and a system prompt addition explains when/how to use it
3. When the LLM calls `handover({ notes: "...", status: "..." })`:
   a. The agent loop stops (like the model responding with no tool calls)
   b. The conversation history is **cleared**
   c. A fresh system prompt is constructed: base prompt + AGENTS.md + handover context
   d. A synthetic user message is injected with the handover notes
   e. The agent loop restarts with this clean context
4. The cycle continues until the model finishes without calling handover (or the user intervenes)

### Changes

**`src/config.ts`**:
- Add `enableHandover: boolean` to `Config`
- Add `--enable-handover` flag to `parseArgs()` (no short alias — it's a power-user feature)
- Update help text

**`src/tools/handover.ts`** — new file:
```typescript
export const handoverToolDef = {
  name: "handover",
  description: `Signal that you have completed a self-contained step and want to hand over to a fresh context.
Use this when:
- You've completed a logical unit of work (e.g., implemented a function, fixed a bug, set up a file)
- The context is getting long and you want a clean slate for the next step
- You want to leave notes for the next step about what was done and what comes next

The current conversation will be cleared and a new one will start with your notes.`,
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of what was accomplished in this step",
      },
      next_steps: {
        type: "string",
        description: "What should be done next — be specific about files, functions, and remaining work",
      },
      context: {
        type: "string",
        description: "Any important context the next step needs (file paths modified, decisions made, errors encountered)",
      },
    },
    required: ["summary", "next_steps"],
  },
};
```

**`src/tools/index.ts`**:
- Import `handoverToolDef`
- `toolDefs` becomes a function or the handover tool is conditionally included:
  ```typescript
  export function getToolDefs(opts: { enableHandover?: boolean } = {}) {
    const defs = [readToolDef, editToolDef, writeToolDef, shellToolDef, shellStatusToolDef];
    if (opts.enableHandover) defs.push(handoverToolDef);
    return defs;
  }
  ```
- Update `getOpenAITools()`, `getAnthropicTools()`, `getOllamaTools()` to accept and pass through the options
- `executeTool()`: the handover tool is **not** executed here — it's intercepted by the agent loop (returns a special marker)

**`src/prompt.ts`**:
- Add handover instructions to system prompt when enabled:
  ```
  You are operating in handover mode. After completing a meaningful, self-contained step,
  use the handover tool to pass notes to the next context. This keeps your context fresh
  and improves quality. Don't try to do everything at once — break work into logical steps
  and hand over between them.
  ```
- `buildSystemPrompt()` accepts `opts: { enableHandover?: boolean, handoverNotes?: string }`
- When `handoverNotes` is present, append:
  ```
  <handover_notes>
  Previous step summary: ...
  Next steps: ...
  Context: ...
  </handover_notes>
  ```

**`src/agent.ts`** — core handover logic:
- Add `handoverEnabled: boolean` to `AgentOptions`
- In `agentLoop()`, when processing tool calls, check if any tool is `handover`:
  ```typescript
  if (tc.name === "handover") {
    const args = JSON.parse(tc.arguments);
    this.tui.info(`handover: ${args.summary}`);
    this.tui.info(`next: ${args.next_steps}`);

    // Clear conversation history
    this.messages = [];

    // Rebuild system prompt with handover notes
    this.currentHandoverNotes = args;

    // Inject handover as a user message
    const handoverPrompt = `Continue the task. Here's what was done and what's next:\n\nCompleted: ${args.summary}\nNext steps: ${args.next_steps}${args.context ? `\nContext: ${args.context}` : ""}`;
    this.messages.push({ role: "user", content: handoverPrompt });

    // Continue the loop (don't break)
    continue; // goes to next iteration of agentLoop
  }
  ```
- The handover tool result is never added to messages (the context is cleared instead)
- Add a handover counter for logging/display purposes

**`src/index.ts`**:
- Pass `enableHandover` from config to Agent and to tool/prompt builders

### Key Design Decisions
- Handover notes go into BOTH the system prompt (as `<handover_notes>`) AND as a user message. The system prompt version ensures the model sees it even if the user message gets truncated. The user message version gives it conversational context.
- The tool is disabled by default because it changes the agent's behavior fundamentally — it may break expectations for users who want continuous context.
- We don't persist handover notes to disk — they only live in memory for the session. If the user wants persistence, they can use AGENTS.md.
- The `summary`, `next_steps`, `context` structure ensures the model provides actionable notes, not just a dump.
- The handover counter is shown in the TUI so users can see how many handovers occurred.

---

## Feature 3: Slash Commands

### Motivation
Built-in commands for quick actions that don't need to go through the LLM. Start with `/clear` and `/model`.

### How It Works
Slash commands are intercepted in the main loop BEFORE the input is sent to the agent. They are handled directly by the TUI/main loop.

### Changes

**`src/commands.ts`** — new file:
```typescript
export interface CommandContext {
  tui: TUI;
  config: Config;           // mutable reference for /model
  agent: Agent;             // for /clear
  createLLMClient: (config: Config) => LLMClient;  // to rebuild client on model switch
}

export interface CommandResult {
  handled: boolean;
  // If the command changes the LLM client, return the new one
  newLLMClient?: LLMClient;
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult {
  if (!input.startsWith("/")) return { handled: false };

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "clear":
      return cmdClear(ctx);
    case "model":
      return cmdModel(args, ctx);
    case "help":
      return cmdHelp(ctx);
    default:
      ctx.tui.error(`Unknown command: /${cmd}. Type /help for available commands.`);
      return { handled: true };
  }
}
```

**`/clear`** — reset conversation:
```typescript
function cmdClear(ctx: CommandContext): CommandResult {
  ctx.agent.clearHistory();  // new method on Agent
  ctx.tui.success("conversation cleared");
  return { handled: true };
}
```

**`/model <name>`** — switch model:
```typescript
function cmdModel(args: string[], ctx: CommandContext): CommandResult {
  if (args.length === 0) {
    ctx.tui.info(`current model: ${ctx.config.model}`);
    return { handled: true };
  }

  const newModel = args[0];
  // Update config in place
  ctx.config.model = newModel;
  ctx.config.provider = detectProvider(newModel);
  ctx.config.baseUrl = ctx.config.baseUrl || detectBaseUrl(ctx.config.provider, newModel);
  ctx.config.apiKey = findApiKey(ctx.config.provider);

  // Create new LLM client
  const newClient = ctx.createLLMClient(ctx.config);
  ctx.tui.success(`switched to ${newModel} (${ctx.config.provider})`);
  return { handled: true, newLLMClient: newClient };
}
```

**`/help`** — list commands:
```typescript
function cmdHelp(ctx: CommandContext): CommandResult {
  ctx.tui.info("Commands:");
  ctx.tui.info("  /clear          Clear conversation history");
  ctx.tui.info("  /model [name]   Show or switch model");
  ctx.tui.info("  /help           Show this help");
  return { handled: true };
}
```

**`src/agent.ts`**:
- Add `clearHistory()` method:
  ```typescript
  clearHistory(): void {
    this.messages = [];
  }
  ```
- Add `setLLM(client: LLMClient)` method for hot-swapping the model:
  ```typescript
  setLLM(client: LLMClient): void {
    this.llm = client;
  }
  ```
  (requires removing `readonly` from `llm` field)

**`src/index.ts`** — intercept commands in the main loop:
```typescript
while (true) {
  const input = await tui.prompt();
  if (input === null) {
    tui.info("bye");
    break;
  }

  // Handle slash commands
  if (input.startsWith("/")) {
    const result = handleCommand(input, { tui, config, agent, createLLMClient });
    if (result.handled) {
      if (result.newLLMClient) {
        agent.setLLM(result.newLLMClient);
      }
      tui.separator();
      continue;
    }
  }

  await agent.run(input);
  tui.separator();
}
```

**`src/tui.ts`**:
- Update the banner to mention `/help` for commands
- No other changes needed — existing `info()`, `success()`, `error()` methods are sufficient

### Key Design Decisions
- Commands are handled synchronously in the main loop, never sent to the LLM.
- `/model` does an in-place config mutation + LLM client rebuild. The conversation history is preserved across model switches (the user can `/clear` separately if desired).
- `/model` without arguments shows the current model — useful for checking state.
- The command system is a simple switch statement — no need for a registry pattern with just a few builtins. Can be refactored later if it grows.
- Exit commands (`exit`, `quit`, `q`) stay in the TUI handler, not as slash commands — they're more fundamental.
- Future slash commands (e.g., `/compact`, `/undo`, `/log`) can be added to the same switch.

---

## Implementation Order

1. **Slash commands** (smallest scope, no new deps, independent of other features)
2. **Handover tool** (builds on existing tool system, independent of provider)
3. **Ollama native provider** (new dependency, new provider path, largest change)

Each feature is independently shippable.

---

## Files Changed Summary

| File | Feature 1 (Ollama) | Feature 2 (Handover) | Feature 3 (Slash) |
|------|--------------------|-----------------------|--------------------|
| `package.json` | add `ollama` dep | — | — |
| `src/config.ts` | add `"ollama"` provider | add `enableHandover` | export detect fns |
| `src/llm.ts` | add `createOllamaClient` | — | — |
| `src/tools/index.ts` | add `getOllamaTools` | conditional handover tool | — |
| `src/tools/handover.ts` | — | **new file** | — |
| `src/prompt.ts` | — | handover prompt additions | — |
| `src/agent.ts` | — | handover interception | add `clearHistory`, `setLLM` |
| `src/index.ts` | — | pass enableHandover | command interception |
| `src/commands.ts` | — | — | **new file** |
| `src/tui.ts` | — | — | banner update |
