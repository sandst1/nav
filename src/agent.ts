/**
 * Agent loop — the core step-by-step execution engine.
 *
 * Takes user input, calls the LLM, dispatches tool calls, feeds results
 * back, and repeats until the model responds with text only (no tool calls).
 *
 * Supports mid-run user interjections: if the user types something while
 * the agent is executing, it gets injected as a new user message.
 */

import type {
  LLMClient,
  Message,
  StreamEvent,
  AssistantToolCallMessage,
  ToolResultMessage,
  ToolCallInfo,
} from "./llm";
import { executeTool } from "./tools/index";
import { buildSystemPrompt } from "./prompt";
import { generateProjectTree } from "./tree";
import type { ProcessManager } from "./process-manager";
import type { Logger } from "./logger";
import type { TUI } from "./tui";

const MAX_STEPS = 50; // Safety limit

export interface AgentOptions {
  llm: LLMClient;
  systemPrompt: string;
  cwd: string;
  logger: Logger;
  tui: TUI;
  processManager: ProcessManager;
}

export class Agent {
  private messages: Message[] = [];
  private llm: LLMClient;
  private systemPrompt: string;
  private readonly cwd: string;
  private readonly logger: Logger;
  private readonly tui: TUI;
  private readonly processManager: ProcessManager;

  constructor(opts: AgentOptions) {
    this.llm = opts.llm;
    this.systemPrompt = opts.systemPrompt;
    this.cwd = opts.cwd;
    this.logger = opts.logger;
    this.tui = opts.tui;
    this.processManager = opts.processManager;
  }

  /** Clear conversation history. */
  clearHistory(): void {
    this.messages = [];
  }

  /** Hot-swap the LLM client (for /model command). */
  setLLM(client: LLMClient): void {
    this.llm = client;
  }

  /** Update the system prompt. */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** Number of messages in the conversation history. */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Hand over to a fresh context.
   *
   * Asks the model to summarize what it accomplished (streamed to TUI),
   * clears the conversation, and starts a fresh run with the summary,
   * optional user instructions, and a current file tree.
   */
  async handover(userInstructions?: string): Promise<void> {
    // Ask the model to summarize using the current conversation context
    const summarizePrompt =
      "Summarize concisely what you've accomplished so far: files changed, key decisions, and current state. Be specific about file paths and what was done. Reply with only the summary, no preamble.";
    this.messages.push({ role: "user", content: summarizePrompt });

    this.tui.setAgentRunning(true);
    this.tui.resetAbort();
    const signal = this.tui.getAbortSignal();

    let summary = "";
    try {
      for await (const event of this.llm.stream(
        this.systemPrompt,
        this.messages,
        signal,
      )) {
        if (this.tui.isAborted()) break;
        if (event.type === "text") {
          summary += event.text ?? "";
          this.tui.streamText(event.text ?? "");
        }
      }
    } catch (e: unknown) {
      if (!this.tui.isAborted()) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.tui.error(`LLM error during handover summary: ${errMsg}`);
      }
    }

    if (summary) this.tui.endStream();
    this.tui.setAgentRunning(false);

    if (this.tui.isAborted() || !summary.trim()) {
      this.tui.info("handover cancelled");
      // Remove the summarize prompt we injected
      this.messages.pop();
      return;
    }

    // Clear context and rebuild system prompt
    this.messages = [];
    this.systemPrompt = buildSystemPrompt(this.cwd);

    // Generate a fresh file tree for orientation
    const tree = generateProjectTree(this.cwd);

    // Build the handover prompt
    let prompt = `Continue working on the task. Here's a summary of what was done previously:\n\n${summary.trim()}`;
    if (userInstructions) {
      prompt += `\n\nAdditional instructions: ${userInstructions}`;
    }
    prompt += `\n\nCurrent project structure:\n${tree}`;

    // Run with fresh context
    await this.run(prompt);
  }

  /** Run a single user prompt through the agent loop until completion. */
  async run(userPrompt: string): Promise<void> {
    this.logger.logUserMessage(userPrompt);
    this.messages.push({ role: "user", content: userPrompt });

    this.tui.setAgentRunning(true);
    this.tui.resetAbort();
    const signal = this.tui.getAbortSignal();

    try {
      await this.agentLoop(signal);
    } finally {
      this.tui.setAgentRunning(false);
    }
  }

  private async agentLoop(signal: AbortSignal): Promise<void> {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.tui.isAborted()) break;

      // Check for pending user input between steps
      this.injectPendingInput();

      const startTime = performance.now();
      let assistantText = "";
      const toolCalls: ToolCallInfo[] = [];
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      // Stream LLM response
      try {
        for await (const event of this.llm.stream(
          this.systemPrompt,
          this.messages,
          signal,
        )) {
          if (this.tui.isAborted()) break;
          switch (event.type) {
            case "text":
              assistantText += event.text ?? "";
              this.tui.streamText(event.text ?? "");
              break;
            case "tool_call":
              if (event.toolCall) toolCalls.push(event.toolCall);
              break;
            case "done":
              usage = event.usage;
              break;
          }
        }
      } catch (e: unknown) {
        if (this.tui.isAborted()) break;
        const errMsg = e instanceof Error ? e.message : String(e);
        this.tui.error(`LLM error: ${errMsg}`);
        this.logger.logError(errMsg);
        break;
      }

      if (this.tui.isAborted()) break;

      const durationMs = Math.round(performance.now() - startTime);

      // Finish the streamed text line
      if (assistantText) {
        this.tui.endStream();
        this.logger.logAssistantMessage(assistantText);
      }

      // Show usage in verbose mode
      if (usage) {
        this.logger.logUsage({ ...usage, durationMs });
        if (this.logger.verbose) {
          this.tui.info(
            `tokens: ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out (${(durationMs / 1000).toFixed(1)}s)`,
          );
        }
      }

      // No tool calls — the model is done
      if (toolCalls.length === 0) {
        if (!assistantText) {
          this.tui.info("(no response)");
        }

        // Even after the model is "done", if the user queued a message,
        // inject it and keep going
        if (this.tui.hasPendingInput()) {
          this.injectPendingInput();
          continue;
        }

        break;
      }

      // Add assistant message with tool calls to history
      const assistantMsg: AssistantToolCallMessage = {
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls,
      };
      this.messages.push(assistantMsg);

      // Execute tool calls
      for (const tc of toolCalls) {
        if (this.tui.isAborted()) break;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
          this.tui.error(`Failed to parse tool args for ${tc.name}`);
        }

        this.logger.logToolCall(tc.name, args);

        if (this.logger.verbose) {
          this.tui.toolCall(tc.name, args);
        } else {
          this.tui.toolCallCompact(tc.name, args);
        }

        const result = await executeTool(
          tc.name,
          args,
          this.cwd,
          this.logger,
          this.processManager,
        );

        // Show result in TUI
        this.tui.toolResult(result.displaySummary, !!result.displayDiff);
        if (result.displayDiff && this.logger.verbose) {
          this.tui.diff(result.displayDiff);
        }

        // Add tool result to history
        const toolMsg: ToolResultMessage = {
          role: "tool",
          tool_call_id: tc.id,
          content: result.output,
        };
        this.messages.push(toolMsg);
      }

      // After executing all tool calls, check for user interjections
      // and inject them before the next LLM call
      this.injectPendingInput();
    }
  }

  /**
   * Check for queued user input and inject it into the conversation.
   * Multiple queued messages get joined into one.
   */
  private injectPendingInput(): void {
    const pending: string[] = [];
    let input: string | null;
    while ((input = this.tui.getPendingInput()) !== null) {
      pending.push(input);
    }

    if (pending.length === 0) return;

    const combined = pending.join("\n");
    this.tui.userInterjection(combined);
    this.logger.logUserMessage(`[interjection] ${combined}`);
    this.messages.push({ role: "user", content: combined });
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
