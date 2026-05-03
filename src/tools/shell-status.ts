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
        const info = processManager.getStatus(p.pid);
        if (!info) {
          const status = p.exitCode === null ? "running" : `exited (${p.exitCode})`;
          const secs = Math.round((Date.now() - p.startedAt) / 1000);
          return `pid ${p.pid}: ${p.command.slice(0, 60)} [${status}, ${secs}s]`;
        }
        const status = info.running ? "running" : `exited (${info.exitCode})`;
        return `pid ${p.pid}: ${p.command.slice(0, 60)} [${status}, ${info.runningSecs}s]`;
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
    "Bg processes: no pid = list; pid = status + recent output. action: status|output|tail|kill.",
  parameters: {
    type: "object" as const,
    properties: {
      pid: {
        type: "number" as const,
        description: "Pid to inspect; omit = list all.",
      },
      action: {
        type: "string" as const,
        enum: ["status", "output", "tail", "kill"],
        description: "status (default): status+recent; output: full; tail: last KB; kill.",
      },
    },
    required: [] as const,
  },
};
