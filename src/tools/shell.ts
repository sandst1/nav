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
    "Run a shell command. If it doesn't finish within wait_ms, it gets backgrounded automatically — use shell_status to check on it. Set wait_ms to 0 to background immediately (useful for dev servers).",
  parameters: {
    type: "object" as const,
    properties: {
      command: {
        type: "string" as const,
        description: "Shell command to run",
      },
      wait_ms: {
        type: "number" as const,
        description:
          "How long to wait for the command to finish before backgrounding it (ms). Default: 30000. Set to 0 to immediately background (useful for dev servers, watch mode, etc.)",
      },
    },
    required: ["command"] as const,
  },
};
