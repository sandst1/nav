/**
 * Terminal UI — minimal readline-based interface with themed colors.
 *
 * Supports capturing user input even while the agent is running,
 * so the user can send follow-up messages mid-execution.
 */

import * as readline from "node:readline";
import { theme, RESET, BOLD } from "./theme";

/** Strip ANSI escape codes for visible-length calculation. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export class TUI {
  private isStreaming = false;
  private rl: readline.Interface;

  /** Queue of lines typed while the agent is working. */
  private inputQueue: string[] = [];

  /** Resolve function for the prompt() call, if we're waiting for input. */
  private promptResolve: ((value: string | null) => void) | null = null;

  /** Whether the agent is currently running (enables background input capture). */
  private agentRunning = false;

  /** Whether we've seen EOF. */
  private closed = false;

  /** Abort controller for the current agent run (ESC to stop). */
  private abortController: AbortController | null = null;

  /** Whether the user pressed ESC to abort. */
  private aborted = false;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Enable keypress events for ESC detection
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, this.rl);
    }

    // Listen for keypress events (ESC detection)
    process.stdin.on("keypress", (_str: string | undefined, key: readline.Key) => {
      if (key && key.name === "escape" && this.agentRunning && !this.aborted) {
        this.abortController?.abort();
        this.aborted = true;
        this.endStream();
        console.log(`\n${theme.warning}  ■ stopped${RESET}`);
      }
    });

    // Single unified line handler
    this.rl.on("line", (line) => {
      const trimmed = line.trim();

      if (this.promptResolve) {
        // We're in prompt mode — resolve the pending prompt
        const resolve = this.promptResolve;
        this.promptResolve = null;
        if (
          trimmed === "exit" ||
          trimmed === "quit" ||
          trimmed === "q"
        ) {
          resolve(null);
        } else if (trimmed === "") {
          // Show prompt again for empty input
          this.showPromptMarker();
          this.promptResolve = resolve;
        } else {
          resolve(trimmed);
        }
      } else if (this.agentRunning && trimmed) {
        // Agent is running — queue the input and show feedback
        this.inputQueue.push(trimmed);
        if (this.isStreaming) {
          process.stdout.write(RESET);
          this.isStreaming = false;
        }
        console.log(
          `\n${theme.warning}▸${RESET} ${theme.dim}queued: "${trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed}"${RESET}`,
        );
      }
    });

    // Handle EOF (ctrl-D or piped stdin)
    this.rl.on("close", () => {
      this.closed = true;
      if (this.promptResolve) {
        const resolve = this.promptResolve;
        this.promptResolve = null;
        resolve(null);
      }
    });
  }

  /** Print the startup banner. */
  banner(model: string, provider: string, logPath: string, contextWindow?: number, handoverThreshold?: number): void {
    const ctxStr = contextWindow
      ? `ctx: ${contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}k` : contextWindow}`
      : "";
    const threshStr = contextWindow && handoverThreshold
      ? `auto-handover at ${Math.round(handoverThreshold * 100)}%`
      : "";

    // Box content
    const title = `${BOLD}${theme.brand}nav${RESET} ${theme.dim}— coding agent${RESET}`;
    const infoParts = [`${model} (${provider})`];
    if (ctxStr) infoParts.push(ctxStr);
    if (threshStr) infoParts.push(threshStr);
    const info = `${theme.dim}${infoParts.join(" • ")}${RESET}`;

    // Compute visible widths for box alignment
    const w1 = stripAnsi(title).length;
    const w2 = stripAnsi(info).length;
    const maxW = Math.max(w1, w2);
    const inner = maxW + 2; // 1 char padding each side

    console.log(`${theme.dim}╭${"─".repeat(inner)}╮${RESET}`);
    console.log(`${theme.dim}│${RESET} ${title}${" ".repeat(maxW - w1)} ${theme.dim}│${RESET}`);
    console.log(`${theme.dim}│${RESET} ${info}${" ".repeat(maxW - w2)} ${theme.dim}│${RESET}`);
    console.log(`${theme.dim}╰${"─".repeat(inner)}╯${RESET}`);
    console.log(`${theme.dim}  log: ${logPath}${RESET}`);
    console.log(
      `${theme.dim}  type your request, "exit" to quit, /help for commands${RESET}`,
    );
    console.log(
      `${theme.dim}  tip: you can type while the agent works • ESC to stop${RESET}`,
    );
    console.log();
  }

  /** Show the prompt marker (without setting up the resolve). */
  private showPromptMarker(): void {
    process.stdout.write(`${theme.prompt}>${RESET} `);
  }

  /** Prompt user for input. Returns null on EOF/exit. */
  async prompt(): Promise<string | null> {
    if (this.closed) return null;

    return new Promise((resolve) => {
      this.promptResolve = resolve;
      this.showPromptMarker();
    });
  }

  /** Mark the agent as running (enables background input capture). */
  setAgentRunning(running: boolean): void {
    this.agentRunning = running;
  }

  /** Get the next queued user message, or null if none. */
  getPendingInput(): string | null {
    return this.inputQueue.shift() ?? null;
  }

  /** Check if there's pending user input without consuming it. */
  hasPendingInput(): boolean {
    return this.inputQueue.length > 0;
  }

  /** Stream text incrementally (assistant response). */
  streamText(text: string): void {
    if (!this.isStreaming) {
      this.isStreaming = true;
      process.stdout.write(`\n${theme.text}`);
    }
    process.stdout.write(text);
  }

  /** End the current streaming text. */
  endStream(): void {
    if (this.isStreaming) {
      process.stdout.write(`${RESET}\n`);
      this.isStreaming = false;
    }
  }

  /** Show a tool call (verbose mode). */
  toolCall(name: string, args: Record<string, unknown>): void {
    this.endStream();
    const argsStr = JSON.stringify(args, null, 2)
      .split("\n")
      .map((l) => `  ${theme.dim}${l}${RESET}`)
      .join("\n");
    console.log(`\n${theme.tool}◆${RESET} ${BOLD}${name}${RESET}`);
    console.log(argsStr);
  }

  /** Show a compact tool call (non-verbose). */
  toolCallCompact(name: string, args: Record<string, unknown>): void {
    this.endStream();
    let summary = "";
    if (name === "read" || name === "write" || name === "edit") {
      summary = (args.path as string) ?? "";
    } else if (name === "shell") {
      const cmd = (args.command as string) ?? "";
      summary = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    } else if (name === "shell_status") {
      if (args.pid) summary = `pid:${args.pid}`;
      if (args.action) summary += ` ${args.action}`;
    }
    process.stdout.write(
      `${theme.dim}  ${name}${summary ? ` ${summary}` : ""}${RESET}\n`,
    );
  }

  /** Show tool result summary. */
  toolResult(summary: string, hasDiff: boolean): void {
    // The summary already has ANSI codes for +/- counts from diffSummary
    console.log(`${theme.dim}  → ${summary}${RESET}`);
  }

  /** Show a full diff (verbose mode). */
  diff(colorizedDiff: string): void {
    const lines = colorizedDiff.split("\n");
    for (const line of lines) {
      console.log(`    ${line}`);
    }
  }

  /** Show an info message. */
  info(msg: string): void {
    this.endStream();
    console.log(`${theme.dim}  ${msg}${RESET}`);
  }

  /** Show an error message. */
  error(msg: string): void {
    this.endStream();
    console.log(`${theme.error}  ✗ ${msg}${RESET}`);
  }

  /** Show a success message. */
  success(msg: string): void {
    this.endStream();
    console.log(`${theme.success}  ✓ ${msg}${RESET}`);
  }

  /** Print a separator. */
  separator(): void {
    console.log();
  }

  /** Print a visual separator for handover (context reset). */
  handoverBanner(): void {
    console.log();
    console.log(`${theme.dim}${"─".repeat(48)}${RESET}`);
    console.log(`${theme.brand}  ↻${RESET} ${theme.dim}handover — continuing with fresh context${RESET}`);
    console.log(`${theme.dim}${"─".repeat(48)}${RESET}`);
    console.log();
  }

  /** Show notice about user input being injected. */
  userInterjection(text: string): void {
    this.endStream();
    console.log(
      `\n${theme.warning}▸${RESET} ${BOLD}you:${RESET} ${text}`,
    );
  }

  /** Create a new AbortController for the current agent run. */
  getAbortSignal(): AbortSignal {
    this.abortController = new AbortController();
    this.aborted = false;
    return this.abortController.signal;
  }

  /** Check if the user pressed ESC. */
  isAborted(): boolean {
    return this.aborted;
  }

  /** Reset abort state (called at start of each run). */
  resetAbort(): void {
    this.aborted = false;
    this.abortController = null;
  }

  /** Clean shutdown. */
  close(): void {
    this.rl.close();
  }
}
