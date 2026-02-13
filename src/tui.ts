/**
 * Terminal UI — minimal readline-based interface with ANSI colors.
 *
 * Supports capturing user input even while the agent is running,
 * so the user can send follow-up messages mid-execution.
 */

import * as readline from "node:readline";

// ANSI color codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const GRAY = "\x1b[90m";

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

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
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
        // Save cursor, move to new line, print feedback, restore
        if (this.isStreaming) {
          process.stdout.write(RESET);
          this.isStreaming = false;
        }
        console.log(
          `\n${YELLOW}▸${RESET} ${DIM}queued message: "${trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed}"${RESET}`,
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
  banner(model: string, provider: string, logPath: string): void {
    console.log(`${BOLD}${CYAN}nav${RESET} ${DIM}— coding agent${RESET}`);
    console.log(`${DIM}model: ${model} (${provider})${RESET}`);
    console.log(`${DIM}log: ${logPath}${RESET}`);
    console.log(
      `${DIM}type your request, or "exit" to quit${RESET}`,
    );
    console.log(
      `${DIM}tip: you can type messages while the agent is working${RESET}`,
    );
    console.log();
  }

  /** Show the prompt marker (without setting up the resolve). */
  private showPromptMarker(): void {
    process.stdout.write(`${CYAN}>${RESET} `);
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
      process.stdout.write(`\n${WHITE}`);
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
      .map((l) => `  ${DIM}${l}${RESET}`)
      .join("\n");
    console.log(`\n${MAGENTA}◆${RESET} ${BOLD}${name}${RESET}`);
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
      `${DIM}  ${name}${summary ? ` ${summary}` : ""}${RESET}\n`,
    );
  }

  /** Show tool result summary. */
  toolResult(summary: string, hasDiff: boolean): void {
    // The summary already has ANSI codes for +/- counts from diffSummary
    console.log(`${DIM}  → ${summary}${RESET}`);
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
    console.log(`${DIM}  ${msg}${RESET}`);
  }

  /** Show an error message. */
  error(msg: string): void {
    this.endStream();
    console.log(`${RED}  ✗ ${msg}${RESET}`);
  }

  /** Show a success message. */
  success(msg: string): void {
    this.endStream();
    console.log(`${GREEN}  ✓ ${msg}${RESET}`);
  }

  /** Print a separator. */
  separator(): void {
    console.log();
  }

  /** Show notice about user input being injected. */
  userInterjection(text: string): void {
    this.endStream();
    console.log(
      `\n${YELLOW}▸${RESET} ${BOLD}you:${RESET} ${text}`,
    );
  }

  /** Clean shutdown. */
  close(): void {
    this.rl.close();
  }
}
