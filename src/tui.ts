/**
 * Terminal UI — minimal readline-based interface with themed colors.
 *
 * Supports capturing user input even while the agent is running,
 * so the user can send follow-up messages mid-execution.
 */

import * as readline from "node:readline";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { theme, RESET, BOLD } from "./theme";

/** Strip ANSI escape codes for visible-length calculation. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Indentation applied to all agent response lines. */
const INDENT = "    ";

/** Current terminal width (columns), updated on SIGWINCH. */
let terminalWidth = process.stdout.columns || 80;
process.stdout.on("resize", () => {
  terminalWidth = process.stdout.columns || 80;
});

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

  /** Whether the next character written is at the start of a new line. */
  private streamAtLineStart = true;
  /** Visible column position within the current line (after indent). */
  private streamCol = 0;

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

  // ── @-mention file picker state ──

  /** Project root for scanning files. Set via setProjectRoot(). */
  private projectRoot = "";

  /** Cached list of project-relative file paths for the @ picker. */
  private projectFiles: string[] = [];

  /** Whether the file cache is stale and should be rebuilt next time. */
  private projectFilesDirty = true;

  /** Currently shown @-mention matches (kept in sync with the rendered menu). */
  private atMentionMatches: string[] = [];

  /** Index of the highlighted row in the @-mention menu (-1 = none). */
  private atMentionSelectedIndex = -1;

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

    // Wrap readline's internal _ttyWrite so we can intercept keypresses BEFORE
    // readline processes them (and before any line/keypress events fire).
    // This is the only reliable way to swallow Enter when a menu item is selected.
    const origTtyWrite = (this.rl as any)._ttyWrite.bind(this.rl);
    (this.rl as any)._ttyWrite = (s: string, key: readline.Key) => {
      if (this.promptResolve && key) {
        // Enter with a menu item selected → complete, don't submit
        if ((key.name === "return" || key.name === "enter") &&
            this.atMentionSelectedIndex >= 0 && this.atMentionMatches.length > 0) {
          this.completeAtMentionSelection();
          return; // swallow — readline never sees this Enter
        }

        // Up/Down while menu is open → navigate the menu
        if ((key.name === "up" || key.name === "down") && this.atMentionMatches.length > 0) {
          const savedLine: string = (this.rl as any).line ?? "";
          const savedCursor: number = (this.rl as any).cursor ?? 0;
          const delta = key.name === "up" ? -1 : 1;
          // Let readline handle the key first (may trigger history nav), then restore
          origTtyWrite(s, key);
          (this.rl as any).line = savedLine;
          (this.rl as any).cursor = savedCursor;
          (this.rl as any)._refreshLine();
          this.moveAtMentionSelection(delta);
          return;
        }
      }
      origTtyWrite(s, key);
    };

    // Listen for keypress events (for ESC and menu updates only — no longer handles Enter/arrows)
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
          // User submitted (no menu item selected) — clear menu before readline processes the Enter
          this.clearMenu();
        } else if (key.name === "tab") {
          this.handleTabComplete();
        } else if (key.name === "up" || key.name === "down") {
          // Handled in _ttyWrite above; nothing to do here
        } else {
          // Any other key resets the selection and updates the menu
          this.atMentionSelectedIndex = -1;
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

  /**
   * Write a chunk of text to the terminal with:
   * - 4-space indent at the start of each line
   * - Soft word-wrap to keep lines within terminal width (re-indenting wrapped segments)
   *
   * ANSI codes are passed through without counting toward column width.
   */
  private writeIndented(text: string): void {
    const usableWidth = Math.max(20, terminalWidth - INDENT.length);

    // Walk character by character so we handle ANSI escapes, newlines,
    // and visible chars in one pass.
    let i = 0;
    while (i < text.length) {
      // Emit indent at the start of a fresh line
      if (this.streamAtLineStart) {
        process.stdout.write(INDENT);
        this.streamAtLineStart = false;
        this.streamCol = 0;
      }

      // Check for ANSI escape sequence — pass through without counting width
      if (text[i] === "\x1b" && text[i + 1] === "[") {
        const end = text.indexOf("m", i + 2);
        if (end !== -1) {
          process.stdout.write(text.slice(i, end + 1));
          i = end + 1;
          continue;
        }
      }

      // Newline — move to next line
      if (text[i] === "\n") {
        process.stdout.write("\n");
        this.streamAtLineStart = true;
        this.streamCol = 0;
        i++;
        continue;
      }

      // Regular character — check if we need to soft-wrap first.
      // Look ahead to find the end of the current word so we can wrap whole words.
      if (this.streamCol >= usableWidth) {
        process.stdout.write("\n");
        this.streamAtLineStart = true;
        this.streamCol = 0;
        // Emit indent immediately (we know we're not at line start anymore after this)
        process.stdout.write(INDENT);
        this.streamAtLineStart = false;
      }

      process.stdout.write(text[i]!);
      this.streamCol++;
      i++;
    }
  }

  /** Stream text incrementally (assistant response). */
  streamText(text: string): void {
    if (!this.isStreaming) {
      this.stopSpinner();
      this.isStreaming = true;
      this.streamAtLineStart = true;
      this.streamCol = 0;
      process.stdout.write(`\n${theme.text}`);
    }

    if (!this.streamFilterEnabled) {
      this.writeIndented(text);
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
          this.writeIndented(line);
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
        this.writeIndented(this.streamFilterBuffer);
        this.streamFilterBuffer = "";
      }
    }
  }

  /** End the current streaming text. */
  endStream(): void {
    if (this.isStreaming) {
      process.stdout.write(`${RESET}\n`);
      this.isStreaming = false;
      this.streamAtLineStart = true;
      this.streamCol = 0;
    }
  }

  /** Show a tool call (verbose mode). */
  toolCall(name: string, args: Record<string, unknown>): void {
    this.stopSpinner();
    this.endStream();
    const argsStr = JSON.stringify(args, null, 2)
      .split("\n")
      .map((l) => `${INDENT}  ${theme.dim}${l}${RESET}`)
      .join("\n");
    console.log(`\n${INDENT}${theme.tool}◆${RESET} ${BOLD}${name}${RESET}`);
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
      `${theme.dim}${INDENT}${name}${summary ? ` ${summary}` : ""}${RESET}\n`,
    );
  }

  /** Show tool result summary. */
  toolResult(summary: string, hasDiff: boolean): void {
    // The summary already has ANSI codes for +/- counts from diffSummary
    console.log(`${theme.dim}${INDENT}→ ${summary}${RESET}`);
  }

  /** Show a full diff (verbose mode). */
  diff(colorizedDiff: string): void {
    const lines = colorizedDiff.split("\n");
    for (const line of lines) {
      console.log(`    ${line}`);
    }
  }

  /**
   * Core line printer: write `line` to stdout prefixed with INDENT, then a newline.
   * Word-wraps at terminal width; continuation lines are indented by `hangIndent` spaces
   * (in addition to INDENT) so they align under the content, not column 0.
   * The string may contain ANSI codes — they are stripped only for width measurement,
   * and the active color is re-applied at the start of each continuation line so colors
   * don't bleed or vanish across wrap boundaries.
   */
  private printLine(line: string, hangIndent: number): void {
    const usableWidth = Math.max(20, terminalWidth - INDENT.length);
    let remaining = line;
    let first = true;
    // Track the last color/style escape seen so we can re-open it on wrapped lines
    let activeColor = "";

    while (remaining.length > 0 || first) {
      const hang = first ? 0 : hangIndent;
      const budget = usableWidth - hang;
      const visibleRemaining = stripAnsi(remaining);

      if (visibleRemaining.length <= budget) {
        const pad = first ? "" : " ".repeat(hang);
        process.stdout.write(`${INDENT}${pad}${activeColor}${remaining}${RESET}\n`);
        break;
      }

      // Break at last space within budget
      let breakAt = budget;
      const spaceIdx = visibleRemaining.lastIndexOf(" ", budget);
      if (spaceIdx > 0) breakAt = spaceIdx;

      // Walk byte-by-byte counting visible chars to find the split point,
      // collecting all ANSI escape codes seen along the way.
      let byteIdx = 0;
      let visibleCount = 0;
      while (byteIdx < remaining.length && visibleCount < breakAt) {
        if (remaining[byteIdx] === "\x1b" && remaining[byteIdx + 1] === "[") {
          const end = remaining.indexOf("m", byteIdx + 2);
          if (end !== -1) {
            const code = remaining.slice(byteIdx, end + 1);
            // Reset clears active color; any other code becomes the active color
            if (code === RESET) {
              activeColor = "";
            } else {
              activeColor = code;
            }
            byteIdx = end + 1;
            continue;
          }
        }
        byteIdx++;
        visibleCount++;
      }

      const segment = remaining.slice(0, byteIdx).trimEnd();
      remaining = remaining.slice(byteIdx).trimStart();

      const pad = first ? "" : " ".repeat(hang);
      process.stdout.write(`${INDENT}${pad}${segment}${RESET}\n`);
      first = false;
    }
  }

  /** Show an info message (dim), wrapping at terminal width. */
  info(msg: string): void {
    this.stopSpinner();
    this.endStream();
    for (const para of msg.split("\n")) {
      if (para === "") { process.stdout.write("\n"); continue; }
      this.printLine(`${theme.dim}${para}`, 0);
    }
  }

  /**
   * Print a pre-colored line (may contain ANSI codes) with INDENT and word-wrap.
   * `hangIndent` is the number of visible spaces continuation lines are indented
   * relative to INDENT — use this to align wrapped text under a column in the line.
   */
  print(line: string, hangIndent = 0): void {
    this.stopSpinner();
    this.endStream();
    this.printLine(line, hangIndent);
  }

  /** Show an error message. */
  error(msg: string): void {
    this.stopSpinner();
    this.endStream();
    this.printLine(`${theme.error}✗ ${msg}`, 2);
  }

  /** Show a success message. */
  success(msg: string): void {
    this.stopSpinner();
    this.endStream();
    this.printLine(`${theme.success}✓ ${msg}`, 2);
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

  // ── @-mention file picker ─────────────────────────────────────────

  /** Set the project root directory. Invalidates the file cache. */
  setProjectRoot(root: string): void {
    if (this.projectRoot !== root) {
      this.projectRoot = root;
      this.projectFilesDirty = true;
    }
  }

  /** Directories to skip when scanning for files. */
  private static readonly SCAN_SKIP = new Set([
    ".git", "node_modules", ".next", ".nuxt", ".svelte-kit",
    "__pycache__", ".pytest_cache", ".mypy_cache",
    "dist", "build", "out", ".turbo", ".cache", ".DS_Store", "coverage",
  ]);

  /** Recursively collect relative file paths under `dir`, up to `maxFiles`. */
  private scanFiles(dir: string, rel: string, results: string[], maxFiles: number): void {
    if (results.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (TUI.SCAN_SKIP.has(entry)) continue;
      const fullPath = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (isDir) {
        this.scanFiles(fullPath, relPath, results, maxFiles);
      } else {
        results.push(relPath);
      }
    }
  }

  /** Get (and cache) the sorted list of project-relative file paths. */
  private getProjectFiles(): string[] {
    if (this.projectFilesDirty && this.projectRoot) {
      const files: string[] = [];
      this.scanFiles(this.projectRoot, "", files, 2000);
      this.projectFiles = files.sort();
      this.projectFilesDirty = false;
    }
    return this.projectFiles;
  }

  /**
   * Detect the @-mention token the cursor is currently within.
   * Returns the partial path after `@` (may be empty string), or null if cursor
   * is not inside an @-mention.
   */
  private getAtMentionAtCursor(): string | null {
    const line: string = (this.rl as any).line ?? "";
    const cursor: number = (this.rl as any).cursor ?? 0;

    // Walk backwards from cursor to find a leading @
    let i = cursor - 1;
    while (i >= 0 && line[i] !== "@" && !/\s/.test(line[i]!)) {
      i--;
    }
    if (i < 0 || line[i] !== "@") return null;

    // Check the char before @ is either start-of-string or whitespace
    if (i > 0 && !/\s/.test(line[i - 1]!)) return null;

    // Everything from i+1 to cursor is the partial path
    return line.slice(i + 1, cursor);
  }

  /** Filter project files by a partial path prefix (case-insensitive substring). */
  private matchFiles(partial: string): string[] {
    if (!partial && partial !== "") return [];
    const files = this.getProjectFiles();
    const lower = partial.toLowerCase();
    // Score: starts-with-partial gets priority, then substring matches
    const startsWith: string[] = [];
    const contains: string[] = [];
    for (const f of files) {
      const lf = f.toLowerCase();
      if (lf.startsWith(lower)) startsWith.push(f);
      else if (lf.includes(lower)) contains.push(f);
      if (startsWith.length + contains.length >= 8) break;
    }
    return [...startsWith, ...contains].slice(0, 8);
  }

  /** Render the @-mention file picker menu with optional highlighted row. */
  private renderAtMentionMenu(matches: string[], selectedIndex: number): void {
    if (matches.length === 0) return;
    const n = matches.length;
    let seq = "";
    for (let i = 0; i < n; i++) {
      if (i === selectedIndex) {
        seq += `\n${theme.prompt}▸ @${matches[i]}${RESET}`;
      } else {
        seq += `\n${theme.dim}  @${matches[i]}${RESET}`;
      }
    }
    seq += `\x1b[${n}A`;
    process.stdout.write(seq);
    this.shownMenuLines = n;
    this.restoreCursorColumn();
  }

  /** Compute matching files for current cursor position and redraw the menu. */
  private updateAtMentionMenu(): boolean {
    const partial = this.getAtMentionAtCursor();
    if (partial === null) {
      this.atMentionMatches = [];
      this.atMentionSelectedIndex = -1;
      return false;
    }

    const matches = this.matchFiles(partial);
    this.atMentionMatches = matches;

    if (matches.length === 0) {
      this.clearMenu();
      return true;
    }

    this.clearMenu();
    this.renderAtMentionMenu(matches, this.atMentionSelectedIndex);
    return true;
  }

  /** Move the @-mention menu selection up (-1) or down (+1), wrapping around. */
  private moveAtMentionSelection(delta: number): void {
    const n = this.atMentionMatches.length;
    if (n === 0) return;

    if (this.atMentionSelectedIndex < 0) {
      // First navigation: down goes to first item, up goes to last
      this.atMentionSelectedIndex = delta > 0 ? 0 : n - 1;
    } else {
      this.atMentionSelectedIndex = (this.atMentionSelectedIndex + delta + n) % n;
    }

    // Redraw menu with new highlight
    this.clearMenu();
    this.renderAtMentionMenu(this.atMentionMatches, this.atMentionSelectedIndex);
  }

  /** Complete the currently selected @-mention menu item into the prompt. */
  private completeAtMentionSelection(): void {
    const match = this.atMentionMatches[this.atMentionSelectedIndex];
    if (!match) return;

    const line: string = (this.rl as any).line ?? "";
    const cursor: number = (this.rl as any).cursor ?? 0;

    // Find the @ that starts this mention
    let atIdx = cursor - 1;
    while (atIdx >= 0 && line[atIdx] !== "@") atIdx--;
    if (atIdx < 0) return;

    const before = line.slice(0, atIdx + 1); // up to and including @
    const after = line.slice(cursor);         // everything after cursor
    const completed = before + match;
    const newLine = completed + after;

    (this.rl as any).line = newLine;
    (this.rl as any).cursor = completed.length;
    (this.rl as any)._refreshLine();
    this.clearMenu();
    this.atMentionMatches = [];
    this.atMentionSelectedIndex = -1;
  }

  /** Tab-complete an @-mention if the cursor is inside one and there are matches. */
  private handleAtMentionTabComplete(): boolean {
    const partial = this.getAtMentionAtCursor();
    if (partial === null) return false;

    const matches = this.atMentionMatches.length > 0
      ? this.atMentionMatches
      : this.matchFiles(partial);

    if (matches.length === 0) return false;

    // If a row is highlighted, select it; otherwise only complete on single match
    const selectedIdx = this.atMentionSelectedIndex >= 0
      ? this.atMentionSelectedIndex
      : matches.length === 1 ? 0 : -1;

    if (selectedIdx < 0) return false;

    const line: string = (this.rl as any).line ?? "";
    const cursor: number = (this.rl as any).cursor ?? 0;

    // Find the @ that starts this mention
    let atIdx = cursor - 1;
    while (atIdx >= 0 && line[atIdx] !== "@") atIdx--;
    if (atIdx < 0) return false;

    const before = line.slice(0, atIdx + 1); // up to and including @
    const after = line.slice(cursor);         // everything after cursor
    const completed = before + matches[selectedIdx]!;
    const newLine = completed + after;

    (this.rl as any).line = newLine;
    (this.rl as any).cursor = completed.length;
    (this.rl as any)._refreshLine();
    this.clearMenu();
    this.atMentionMatches = [];
    this.atMentionSelectedIndex = -1;
    return true;
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
    // Don't reset atMentionMatches/atMentionSelectedIndex here —
    // callers that want to redraw will set those themselves.
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

  /** Compute matching commands or @-mention files and redraw the menu. */
  private updateMenu(): void {
    if (!this.promptResolve) return;

    const line: string = (this.rl as any).line ?? "";

    // Try @ picker first — it takes priority if cursor is in an @-mention
    if (this.updateAtMentionMenu()) return;

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
   *   "tasks"   → tasks, tasks add, tasks rm, tasks run
   *   "tasks "  → tasks add, tasks rm, tasks run
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

  /** Tab-complete: try @-mention first, then slash commands. */
  private handleTabComplete(): void {
    // Try @-mention tab complete first
    if (this.handleAtMentionTabComplete()) return;

    const line: string = (this.rl as any).line ?? "";
    if (!line.startsWith("/")) return;

    const input = line.slice(1).toLowerCase();
    const matches = this.matchCommands(input);

    if (matches.length === 1) {
      const completed = "/" + matches[0]!.name + " ";
      (this.rl as any).line = completed;
      (this.rl as any).cursor = completed.length;
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
