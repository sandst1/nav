/**
 * Shell tool — run commands with automatic backgrounding for long-running processes.
 *
 * If a command doesn't finish within `wait_ms`, it gets backgrounded and
 * the agent is told to check on it later via the shell_status tool.
 */

import type { ProcessManager } from "../process-manager";

interface ShellArgs {
  command: string;
  /** How long to wait before backgrounding (ms). Default 30000. Set to 0 for immediate background. */
  wait_ms?: number;
  timeout?: number; // legacy alias for wait_ms
}

const DEFAULT_WAIT_MS = 30_000;

export async function shellTool(
  args: ShellArgs,
  cwd: string,
  processManager: ProcessManager,
): Promise<string> {
  const waitMs = args.wait_ms ?? args.timeout ?? DEFAULT_WAIT_MS;

  try {
    const result = await processManager.run(args.command, cwd, waitMs);

    if (result.completed) {
      // Command finished within the wait time
      let output = result.output;
      if (result.exitCode !== 0 && result.exitCode !== null) {
        output += `\nexit code: ${result.exitCode}`;
      }
      return output;
    }

    // Command was backgrounded
    let msg = `Process backgrounded (pid: ${result.pid}). Still running after ${waitMs}ms.`;
    if (result.output.trim()) {
      msg += `\n\nOutput so far:\n${result.output}`;
    }
    msg += `\n\nUse the shell_status tool to check output, or kill the process.`;
    return msg;
  } catch (e) {
    return `Error running command: ${e}`;
  }
}

export const shellToolDef = {
  name: "shell" as const,
  description:
    "Run shell cmd. >wait_ms → background; shell_status for output/kill. wait_ms=0 backgrounds immediately (servers/watchers).",
  parameters: {
    type: "object" as const,
    properties: {
      command: {
        type: "string" as const,
        description: "Shell command to run",
      },
      wait_ms: {
        type: "number" as const,
        description: "Ms to wait before backgrounding (default 30000). 0 = immediate bg.",
      },
    },
    required: ["command"] as const,
  },
};
