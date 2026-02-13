/**
 * Shell status tool — check on, read output from, or kill background processes.
 */

import type { ProcessManager } from "../process-manager";

interface ShellStatusArgs {
  /** Process ID to check. Omit to list all background processes. */
  pid?: number;
  /** Action: "status" (default), "output", "tail", "kill" */
  action?: "status" | "output" | "tail" | "kill";
}

export function shellStatusTool(
  args: ShellStatusArgs,
  processManager: ProcessManager,
): string {
  // List all if no pid
  if (args.pid === undefined) {
    const procs = processManager.list();
    if (procs.length === 0) return "No background processes.";
    return procs
      .map((p) => {
        const status = p.exitCode === null ? "running" : `exited (${p.exitCode})`;
        const secs = Math.round((Date.now() - p.startedAt) / 1000);
        return `pid ${p.pid}: ${p.command.slice(0, 60)} [${status}, ${secs}s]`;
      })
      .join("\n");
  }

  const action = args.action ?? "status";
  const pid = args.pid;

  switch (action) {
    case "kill": {
      const killed = processManager.kill(pid);
      return killed ? `Killed process ${pid}.` : `Process ${pid} not found.`;
    }
    case "tail": {
      const tail = processManager.tailOutput(pid);
      if (tail === null) return `Process ${pid} not found.`;
      const status = processManager.getStatus(pid);
      const stateStr = status?.running ? "running" : `exited (${status?.exitCode})`;
      return `[${stateStr}, ${status?.runningSecs ?? 0}s]\n\n${tail || "(no output yet)"}`;
    }
    case "output": {
      const info = processManager.getStatus(pid);
      if (!info) return `Process ${pid} not found.`;
      const stateStr = info.running ? "running" : `exited (${info.exitCode})`;
      return `[${stateStr}, ${info.runningSecs}s]\n\n${info.output || "(no output yet)"}`;
    }
    case "status":
    default: {
      const info = processManager.getStatus(pid);
      if (!info) return `Process ${pid} not found.`;
      const stateStr = info.running ? "running" : `exited (${info.exitCode})`;
      // Return status + tail of output
      const tail = processManager.tailOutput(pid, 2048) || "(no output yet)";
      return `pid ${pid}: ${info.command.slice(0, 60)} [${stateStr}, ${info.runningSecs}s]\n\nRecent output:\n${tail}`;
    }
  }
}

export const shellStatusToolDef = {
  name: "shell_status" as const,
  description:
    "Check on background processes. Without a pid, lists all. With a pid, shows status and recent output. Use action='kill' to stop a process, action='output' for full output, action='tail' for last few KB.",
  parameters: {
    type: "object" as const,
    properties: {
      pid: {
        type: "number" as const,
        description: "Process ID to check. Omit to list all background processes.",
      },
      action: {
        type: "string" as const,
        enum: ["status", "output", "tail", "kill"],
        description:
          "What to do: 'status' (default) shows status + recent output, 'output' shows full output, 'tail' shows last few KB, 'kill' terminates the process.",
      },
    },
    required: [] as const,
  },
};
