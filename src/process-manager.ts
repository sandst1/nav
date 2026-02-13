/**
 * Process manager — tracks long-running background processes.
 *
 * When a shell command doesn't finish within `waitMs`, it gets backgrounded:
 * the process keeps running, output is buffered, and the agent can check on
 * it later via the shell_status tool.
 */

const MAX_OUTPUT = 256 * 1024; // 256KB per process

export interface BackgroundProcess {
  pid: number;
  command: string;
  startedAt: number;
  exitCode: number | null;
}

interface ProcessEntry {
  pid: number;
  command: string;
  startedAt: number;
  outputChunks: string[];
  outputLen: number;
  exitCode: number | null;
  proc: ReturnType<typeof Bun.spawn>;
}

export class ProcessManager {
  private processes = new Map<number, ProcessEntry>();

  /**
   * Run a command. If it finishes within `waitMs`, return the output directly.
   * Otherwise, background it and return a status message.
   */
  async run(
    command: string,
    cwd: string,
    waitMs: number,
  ): Promise<{
    completed: boolean;
    output: string;
    exitCode: number | null;
    pid: number;
  }> {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb" },
    });

    const pid = proc.pid;
    const outputChunks: string[] = [];
    let outputLen = 0;

    // Helper to read a stream into the shared chunk buffer
    const readStream = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (outputLen < MAX_OUTPUT) {
            outputChunks.push(text);
            outputLen += text.length;
          }
        }
      } catch {
        // Stream closed
      }
    };

    const stdoutPromise = readStream(proc.stdout as ReadableStream<Uint8Array>);
    const stderrPromise = readStream(proc.stderr as ReadableStream<Uint8Array>);

    // Race: process exits vs timeout
    const exitPromise = proc.exited.then((code) => ({
      type: "exit" as const,
      code,
    }));
    const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ type: "timeout" }), waitMs),
    );

    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (result.type === "exit") {
      // Process finished in time — collect remaining output and return
      await Promise.all([stdoutPromise, stderrPromise]);
      const output = truncate(outputChunks.join(""));
      return {
        completed: true,
        output: output || "(no output)",
        exitCode: result.code,
        pid,
      };
    }

    // Timeout — background the process
    const entry: ProcessEntry = {
      pid,
      command,
      startedAt: Date.now(),
      outputChunks,
      outputLen,
      exitCode: null,
      proc,
    };
    this.processes.set(pid, entry);

    // Keep reading output in background, update exitCode when done
    Promise.all([stdoutPromise, stderrPromise]).then(async () => {
      const e = this.processes.get(pid);
      if (e) {
        e.exitCode = await proc.exited;
      }
    });

    const partialOutput = truncate(outputChunks.join(""));
    return {
      completed: false,
      output: partialOutput,
      exitCode: null,
      pid,
    };
  }

  /** Get status and output for a background process. */
  getStatus(pid: number): {
    running: boolean;
    output: string;
    exitCode: number | null;
    command: string;
    runningSecs: number;
  } | null {
    const entry = this.processes.get(pid);
    if (!entry) return null;
    return {
      running: entry.exitCode === null,
      output: truncate(entry.outputChunks.join("")),
      exitCode: entry.exitCode,
      command: entry.command,
      runningSecs: Math.round((Date.now() - entry.startedAt) / 1000),
    };
  }

  /** List all tracked background processes. */
  list(): BackgroundProcess[] {
    return [...this.processes.values()].map((e) => ({
      pid: e.pid,
      command: e.command,
      startedAt: e.startedAt,
      exitCode: e.exitCode,
    }));
  }

  /** Kill a background process. */
  kill(pid: number): boolean {
    const entry = this.processes.get(pid);
    if (!entry) return false;
    try {
      entry.proc.kill();
      return true;
    } catch {
      return false;
    }
  }

  /** Read only the tail of the output (last N bytes). */
  tailOutput(pid: number, bytes = 4096): string | null {
    const entry = this.processes.get(pid);
    if (!entry) return null;
    const full = entry.outputChunks.join("");
    if (full.length <= bytes) return full;
    return "...\n" + full.slice(-bytes);
  }

  /** Clean up exited processes. */
  cleanup(): void {
    for (const [pid, entry] of this.processes) {
      if (entry.exitCode !== null) {
        this.processes.delete(pid);
      }
    }
  }

  /** Kill all background processes (for clean shutdown). */
  killAll(): void {
    for (const entry of this.processes.values()) {
      if (entry.exitCode === null) {
        try {
          entry.proc.kill();
        } catch {}
      }
    }
    this.processes.clear();
  }
}

function truncate(s: string, max = 64 * 1024): string {
  if (s.length > max) return s.slice(0, max) + "\n[truncated]";
  return s;
}
