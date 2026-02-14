/**
 * Session logger — JSONL file logging + verbose TUI helpers.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
  type:
    | "config"
    | "system_prompt"
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "tool_result"
    | "error"
    | "usage";
  timestamp: string;
  data: unknown;
}

export class Logger {
  readonly logPath: string;
  readonly verbose: boolean;

  constructor(cwd: string, verbose: boolean) {
    this.verbose = verbose;
    const dir = join(cwd, ".nav", "logs");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.logPath = join(dir, `${ts}.jsonl`);
  }

  log(entry: Omit<LogEntry, "timestamp">): void {
    const full: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    try {
      appendFileSync(this.logPath, JSON.stringify(full) + "\n");
    } catch {
      // Silently ignore log write failures
    }
  }

  logConfig(data: unknown): void {
    this.log({ type: "config", data });
  }

  logSystemPrompt(systemPrompt: string): void {
    this.log({ type: "system_prompt", data: { systemPrompt } });
  }

  logUserMessage(content: string): void {
    this.log({ type: "user_message", data: { content } });
  }

  logAssistantMessage(content: string): void {
    this.log({ type: "assistant_message", data: { content } });
  }

  logToolCall(name: string, args: unknown): void {
    this.log({ type: "tool_call", data: { name, args } });
  }

  logToolResult(name: string, result: string, durationMs: number): void {
    this.log({ type: "tool_result", data: { name, result: result.slice(0, 5000), durationMs } });
  }

  logError(error: string): void {
    this.log({ type: "error", data: { error } });
  }

  logUsage(usage: { inputTokens: number; outputTokens: number; durationMs: number }): void {
    this.log({ type: "usage", data: usage });
  }
}
