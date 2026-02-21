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

  /**
   * When set, streamed text chunks are buffered and the JSON task block
   * (``` ```json ... ``` ```) is suppressed from display. Everything before
   * the fence is printed normally; everything inside the fence is silently
   * consumed; everything after the fence is printed again.
   */
  private streamFilterEnabled = false;
  private streamFilterBuffer = "";
  private streamFilterSuppressing = false;

  /** Resolve function for the prompt() call, if we're waiting for input. */
  private promptResolve: ((value: string | null) => void) | null = null;

  /** Whether the agent is currently running (enables background input capture). */
  private agentRunning = false;

  /** Whether we've seen EOF. */
  private closed = false;

  /** Optional prefix shown before the prompt marker (e.g. "[plan]"). */
  private promptPrefix = "";

  /** Abort controller for the current agent run (ESC to stop). */
  private abortController: AbortController | null = null;

  /** Whether the user pressed ESC to abort. */
  private aborted = false;

  // ── Slash command autocomplete state ──

  /** Available commands for autocomplete. */
  private commands: Array<{ name: string; description: string }> = [];

  /** Number of menu lines currently rendered below the prompt. */
  private shownMenuLines = 0;

  // ── Spinner state ──

  /** Spinner animation timer. */
  private spinnerTimer: Timer | null = null;

  /** Current frame index in the spinner animation. */
  private spinnerFrameIndex = 0;

  /** Spinner animation frames (Braille pattern). */
  private readonly spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  /** Whether the spinner is currently visible. */
  private spinnerVisible = false;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: () => [[], ""],   // no-op: prevent Tab from inserting \t
    });

    // Enable keypress events for ESC detection + autocomplete
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, this.rl);
    }

    // Listen for keypress events
    process.stdin.on("keypress", (_str: string | undefined, key: readline.Key) => {
      // ESC — abort running agent
      if (key && key.name === "escape" && this.agentRunning && !this.aborted) {
        this.abortController?.abort();
        this.aborted = true;
        this.stopSpinner();
        this.endStream();
        console.log(`\n${theme.warning}  ■ stopped${RESET}`);
        return;
      }

      // Autocomplete logic (only while prompting)
      if (this.promptResolve && key) {
        if (key.name === "return") {
          // User submitted — clear menu before readline processes the Enter
          this.clearMenu();
        } else if (key.name === "tab") {
          this.handleTabComplete();
        } else {
          // Schedule menu update after readline has processed the keypress
          process.nextTick(() => this.updateMenu());
        }
      }
    });

    // Single unified line handler
    this.rl.on("line", (line) => {
      const trimmed = line.trim();

      if (this.promptResolve) {
        // We're in prompt mode — resolve the pending prompt
        this.clearMenu();
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

  /** Set a prefix label shown before the prompt marker (e.g. "[plan]"). Pass empty string to clear. */
  setPromptPrefix(prefix: string): void {
    this.promptPrefix = prefix;
  }

  /** Show the prompt marker (without setting up the resolve). */
  private showPromptMarker(): void {
    const prefix = this.promptPrefix ? `${theme.dim}${this.promptPrefix}${RESET} ` : "";
    process.stdout.write(`${prefix}${theme.prompt}>${RESET} `);
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

  /** Enable filtering of the JSON task block from streamed plan output. */
  enableStreamJsonFilter(): void {
    this.streamFilterEnabled = true;
    this.streamFilterBuffer = "";
    this.streamFilterSuppressing = false;
  }

  /** Disable the JSON task block filter and flush any remaining buffer. */
  disableStreamJsonFilter(): void {
    if (this.streamFilterEnabled) {
      // Flush whatever's left in the buffer (shouldn't be much after a complete response)
      if (!this.streamFilterSuppressing && this.streamFilterBuffer) {
        process.stdout.write(this.streamFilterBuffer);
      }
      this.streamFilterEnabled = false;
      this.streamFilterBuffer = "";
      this.streamFilterSuppressing = false;
    }
  }

  /** Stream text incrementally (assistant response). */
  streamText(text: string): void {
    if (!this.isStreaming) {
      this.stopSpinner();
      this.isStreaming = true;
      process.stdout.write(`\n${theme.text}`);
    }

    if (!this.streamFilterEnabled) {
      process.stdout.write(text);
      return;
    }

    // Accumulate into buffer and process line by line so we can detect fences
    this.streamFilterBuffer += text;

    // Process complete lines from the buffer
    let newlineIdx: number;
    while ((newlineIdx = this.streamFilterBuffer.indexOf("\n")) !== -1) {
      const line = this.streamFilterBuffer.slice(0, newlineIdx + 1);
      this.streamFilterBuffer = this.streamFilterBuffer.slice(newlineIdx + 1);

      if (!this.streamFilterSuppressing) {
        // Detect the opening fence: ```json or ``` followed by optional whitespace
        if (/^```json\s*$/.test(line.trimEnd())) {
          this.streamFilterSuppressing = true;
          // Don't print this line
        } else {
          process.stdout.write(line);
        }
      } else {
        // Inside suppressed block — detect closing fence
        if (/^```\s*$/.test(line.trimEnd())) {
          this.streamFilterSuppressing = false;
          // Don't print closing fence either
        }
        // Otherwise silently consume the line
      }
    }

    // Remaining buffer has no newline yet — print it only if not suppressing
    // BUT: hold it in the buffer since we can't know if it's a fence line yet
    // (we'll flush it on the next chunk or on disableStreamJsonFilter)
    if (!this.streamFilterSuppressing && this.streamFilterBuffer) {
      // Peek: if the buffer so far couldn't possibly be a fence opener, flush it
      const couldBeFenceStart = "```json".startsWith(this.streamFilterBuffer.trimStart());
      if (!couldBeFenceStart) {
        process.stdout.write(this.streamFilterBuffer);
        this.streamFilterBuffer = "";
      }
    }
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
    this.stopSpinner();
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
    this.stopSpinner();
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
    this.stopSpinner();
    this.endStream();
    console.log(`${theme.dim}  ${msg}${RESET}`);
  }

  /** Show an error message. */
  error(msg: string): void {
    this.stopSpinner();
    this.endStream();
    console.log(`${theme.error}  ✗ ${msg}${RESET}`);
  }

  /** Show a success message. */
  success(msg: string): void {
    this.stopSpinner();
    this.endStream();
    console.log(`${theme.success}  ✓ ${msg}${RESET}`);
  }

  /** Print a separator. */
  separator(): void {
    console.log();
  }

  /** Print a visual separator for handover (context reset). */
  handoverBanner(): void {
    this.stopSpinner();
    console.log();
    console.log(`${theme.dim}${"─".repeat(48)}${RESET}`);
    console.log(`${theme.brand}  ↻${RESET} ${theme.dim}handover — continuing with fresh context${RESET}`);
    console.log(`${theme.dim}${"─".repeat(48)}${RESET}`);
    console.log();
  }

  /** Show notice about user input being injected. */
  userInterjection(text: string): void {
    this.stopSpinner();
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

  // ── Slash command autocomplete ────────────────────────────────────

  /** Set the command list for autocompletion and /help. */
  setCommands(commands: Array<{ name: string; description: string }>): void {
    this.commands = commands;
  }

  /** Restore cursor to the correct column on the prompt line. */
  private restoreCursorColumn(): void {
    // Prompt marker "> " is 2 visible chars; add prefix length if set
    const prefixLen = this.promptPrefix ? this.promptPrefix.length + 1 : 0; // +1 for the space after prefix
    const col = 3 + prefixLen + ((this.rl as any).cursor ?? 0); // 1-based column
    process.stdout.write(`\x1b[${col}G`);
  }

  /** Clear the autocomplete menu rendered below the prompt. */
  private clearMenu(): void {
    if (this.shownMenuLines === 0) return;
    const n = this.shownMenuLines;
    // Move down N lines, clearing each one
    let seq = "";
    for (let i = 0; i < n; i++) {
      seq += "\n\x1b[2K";
    }
    // Move back up N lines (works even if terminal scrolled)
    seq += `\x1b[${n}A`;
    process.stdout.write(seq);
    this.shownMenuLines = 0;
    this.restoreCursorColumn();
  }

  /** Render autocomplete matches below the prompt line. */
  private renderMenu(matches: Array<{ name: string; description: string }>): void {
    if (matches.length === 0) return;
    const n = matches.length;
    // Write each match on a new line below the prompt
    let seq = "";
    for (const m of matches) {
      seq += `\n${theme.dim}  /${m.name.padEnd(18)} ${m.description}${RESET}`;
    }
    // Move back up N lines to the prompt line
    seq += `\x1b[${n}A`;
    process.stdout.write(seq);
    this.shownMenuLines = n;
    this.restoreCursorColumn();
  }

  /** Compute matching commands for current input and redraw the menu. */
  private updateMenu(): void {
    if (!this.promptResolve) return;

    const line: string = (this.rl as any).line ?? "";
    this.clearMenu();

    if (!line.startsWith("/")) return;

    const input = line.slice(1).toLowerCase();
    const matches = this.matchCommands(input);
    this.renderMenu(matches);
  }

  /**
   * Match commands against the typed input (without leading slash).
   *
   * Supports two-word commands like "tasks add": once the user has fully
   * typed the first word and pressed space, we filter by the full input
   * prefix so subcommands stay visible and are filtered as the user types.
   *
   * Examples:
   *   "tasks"   → tasks, tasks add, tasks rm, tasks work
   *   "tasks "  → tasks add, tasks rm, tasks work
   *   "tasks r" → tasks rm
   */
  private matchCommands(input: string): Array<{ name: string; description: string }> {
    if (!input.includes(" ")) {
      // Still typing the first word — prefix match on full command name
      return this.commands.filter((c) =>
        c.name.toLowerCase().startsWith(input),
      );
    }

    // User has typed at least one space.
    // Trim trailing spaces so "/tasks " and "/tasks r" both work:
    // - "/tasks " trimmed → "tasks", matches anything starting with "tasks " (not "tasks" itself)
    // - "/tasks r" trimmed → "tasks r", matches "tasks rm"
    const trimmed = input.trimEnd();
    return this.commands.filter((c) => {
      const name = c.name.toLowerCase();
      return name.startsWith(trimmed) && name !== trimmed;
    });
  }

  /** Tab-complete if there is exactly one matching command. */
  private handleTabComplete(): void {
    const line: string = (this.rl as any).line ?? "";
    if (!line.startsWith("/")) return;

    const input = line.slice(1).toLowerCase();
    const matches = this.matchCommands(input);

    if (matches.length === 1) {
      const completed = "/" + matches[0]!.name + " ";
      (this.rl as any).line = completed;
      (this.rl as any).cursor = completed.length;
      // Force readline to redraw the line with new content
      (this.rl as any)._refreshLine();
      this.clearMenu();
    }
  }

  // ── Spinner ────────────────────────────────────────────────────────

  /** Start the spinner animation. */
  startSpinner(): void {
    if (this.spinnerTimer) return; // Already running

    this.spinnerFrameIndex = 0;
    this.spinnerVisible = true;
    
    // Hide cursor for smoother animation
    process.stdout.write("\x1b[?25l");
    
    // Render initial frame
    this.renderSpinnerFrame();
    
    // Start animation timer
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % this.spinnerFrames.length;
      this.renderSpinnerFrame();
    }, 80);
  }

  /** Stop the spinner and clear the line. */
  stopSpinner(): void {
    if (!this.spinnerTimer) return;

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    
    if (this.spinnerVisible) {
      // Clear the spinner line
      process.stdout.write("\r\x1b[K");
      this.spinnerVisible = false;
    }
    
    // Show cursor again
    process.stdout.write("\x1b[?25h");
  }

  /** Render the current spinner frame. */
  private renderSpinnerFrame(): void {
    const frame = this.spinnerFrames[this.spinnerFrameIndex];
    process.stdout.write(`\r${theme.dim}${frame} thinking...${RESET}`);
  }

  /** Clean shutdown. */
  close(): void {
    this.stopSpinner();
    this.clearMenu();
    this.rl.close();
  }
}
