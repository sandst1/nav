/**
 * Configurable hooks — deterministic shell steps (and optional custom-command steps)
 * at stop, task completion, and plan completion.
 */

import type { Agent } from "./agent";
import type { AgentIO } from "./agent-io";
import type { Task } from "./tasks";
import type { Plan } from "./plans";
import type { CustomCommand } from "./custom-commands";

const MAX_HOOK_OUTPUT = 256 * 1024;

/** Default max time for a single shell hook (10 minutes). */
export const DEFAULT_HOOK_TIMEOUT_MS = 10 * 60 * 1000;

export type HookEvent = "stop" | "taskDone" | "planDone";

export interface ShellHookStep {
  shell: string;
}

export interface CommandHookStep {
  command: string;
  /**
   * Substituted into the custom command markdown `{input}` placeholder.
   * `${VAR}` expands to hook env (e.g. NAV_TASK_ID) or process.env (hook wins); unknown names become "".
   */
  args?: string;
}

export type HookStep = ShellHookStep | CommandHookStep;

export interface HookGroup {
  maxAttempts: number;
  steps: HookStep[];
}

export interface HooksConfig {
  stop?: HookStep[];
  taskDone?: HookGroup[];
  planDone?: HookGroup[];
}

export interface HookRunCompleteMeta {
  aborted: boolean;
}

export interface RunShellHookResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut?: boolean;
}

function truncate(s: string, max = MAX_HOOK_OUTPUT): string {
  if (s.length > max) return s.slice(0, max) + "\n[truncated]";
  return s;
}

function parseStep(raw: unknown, context: string): HookStep | null {
  if (typeof raw !== "object" || raw === null) {
    console.warn(`nav hooks: invalid ${context} step (not an object)`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const hasShell = typeof o.shell === "string";
  const hasCommand = typeof o.command === "string";
  if (hasShell && hasCommand) {
    console.warn(`nav hooks: ${context} step has both shell and command — use one`);
    return null;
  }
  if (hasShell) {
    if (o.args !== undefined) {
      console.warn(`nav hooks: ${context} step "args" is only valid with "command" — ignoring args`);
    }
    return { shell: o.shell as string };
  }
  if (hasCommand) {
    let args: string | undefined;
    if (o.args !== undefined) {
      if (typeof o.args === "string") args = o.args;
      else console.warn(`nav hooks: ${context} command step "args" must be a string — omitting`);
    }
    return args !== undefined ? { command: o.command as string, args } : { command: o.command as string };
  }
  console.warn(`nav hooks: ${context} step must have "shell" or "command"`);
  return null;
}

function parseHookGroup(raw: unknown, groupName: string): HookGroup | null {
  if (typeof raw !== "object" || raw === null) {
    console.warn(`nav hooks: invalid ${groupName} entry`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const stepsRaw = o.steps;
  if (!Array.isArray(stepsRaw)) {
    console.warn(`nav hooks: ${groupName} entry must have "steps" array`);
    return null;
  }
  const steps: HookStep[] = [];
  for (const item of stepsRaw) {
    const s = parseStep(item, groupName);
    if (s) steps.push(s);
  }
  if (steps.length === 0) {
    console.warn(`nav hooks: ${groupName} has no valid steps`);
    return null;
  }
  let maxAttempts = 1;
  if (o.maxAttempts !== undefined) {
    if (typeof o.maxAttempts !== "number" || !Number.isFinite(o.maxAttempts) || o.maxAttempts < 1) {
      console.warn(`nav hooks: ${groupName} maxAttempts must be a positive number — using 1`);
    } else {
      maxAttempts = Math.floor(o.maxAttempts);
    }
  }
  return { maxAttempts, steps };
}

/** Parse and validate `hooks` from nav.config.json. */
export function parseHooksConfig(raw: unknown): HooksConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("nav hooks: \"hooks\" must be an object");
    return undefined;
  }
  const h = raw as Record<string, unknown>;
  const result: HooksConfig = {};

  if (h.stop !== undefined) {
    if (!Array.isArray(h.stop)) {
      console.warn("nav hooks: stop must be an array");
    } else {
      const stop: HookStep[] = [];
      for (const item of h.stop) {
        const s = parseStep(item, "stop");
        if (!s) continue;
        if ("command" in s) {
          console.warn("nav hooks: stop hooks only support shell steps — skipping a command step");
          continue;
        }
        stop.push(s);
      }
      if (stop.length) result.stop = stop;
    }
  }

  for (const key of ["taskDone", "planDone"] as const) {
    const v = h[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      console.warn(`nav hooks: ${key} must be an array`);
      continue;
    }
    const groups: HookGroup[] = [];
    for (const item of v) {
      const g = parseHookGroup(item, key);
      if (g) groups.push(g);
    }
    if (groups.length) result[key] = groups;
  }

  return Object.keys(result).length ? result : undefined;
}

export function mergeHookGroups(groups: HookGroup[]): HookGroup {
  if (groups.length === 0) {
    return { maxAttempts: 1, steps: [] };
  }
  return {
    maxAttempts: Math.max(...groups.map((g) => g.maxAttempts), 1),
    steps: groups.flatMap((g) => g.steps),
  };
}

export async function runShellHook(
  command: string,
  cwd: string,
  extraEnv: Record<string, string>,
  timeoutMs: number,
): Promise<RunShellHookResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv, TERM: "dumb" },
  });

  const outputChunks: string[] = [];
  let outputLen = 0;

  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (outputLen < MAX_HOOK_OUTPUT) {
          outputChunks.push(text);
          outputLen += text.length;
        }
      }
    } catch {
      // ignore
    }
  };

  const stdoutPromise = readStream(proc.stdout as ReadableStream<Uint8Array>);
  const stderrPromise = readStream(proc.stderr as ReadableStream<Uint8Array>);

  const exitPromise = proc.exited.then((code) => ({ type: "exit" as const, code }));
  const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) =>
    setTimeout(() => resolve({ type: "timeout" }), timeoutMs),
  );

  const raced = await Promise.race([exitPromise, timeoutPromise]);

  if (raced.type === "timeout") {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    await Promise.all([stdoutPromise, stderrPromise]);
    const output = truncate(outputChunks.join(""));
    return {
      ok: false,
      output: output + `\n[hook timed out after ${Math.round(timeoutMs / 1000)}s]`,
      exitCode: null,
      timedOut: true,
    };
  }

  await Promise.all([stdoutPromise, stderrPromise]);
  const code = raced.code;
  const output = truncate(outputChunks.join(""));
  const ok = code === 0;
  const withExit = ok ? output : output + `\nexit code: ${code}`;
  return { ok, output: withExit || "(no output)", exitCode: code };
}

function baseHookEnv(cwd: string, event: HookEvent): Record<string, string> {
  return {
    NAV_HOOK: event,
    NAV_CWD: cwd,
  };
}

export function taskDoneEnv(
  cwd: string,
  task: Task,
  plan: Plan | undefined,
  attempt: number,
): Record<string, string> {
  const env: Record<string, string> = {
    ...baseHookEnv(cwd, "taskDone"),
    NAV_TASK_ID: task.id,
    NAV_TASK_NAME: task.name,
    NAV_ATTEMPT: String(attempt),
  };
  if (plan) {
    env.NAV_PLAN_ID = String(plan.id);
    env.NAV_PLAN_NAME = plan.name;
  }
  return env;
}

export function planDoneEnv(cwd: string, plan: Plan, planTaskCount: number, attempt: number): Record<string, string> {
  return {
    ...baseHookEnv(cwd, "planDone"),
    NAV_PLAN_ID: String(plan.id),
    NAV_PLAN_NAME: plan.name,
    NAV_PLAN_TASK_COUNT: String(planTaskCount),
    NAV_ATTEMPT: String(attempt),
  };
}

export interface HookRunContext {
  cwd: string;
  hookTimeoutMs: number;
  io: AgentIO;
  agent: Agent;
  customCommands: Map<string, CustomCommand>;
}

/** Hook env layered on process.env for `${VAR}` expansion in command `args`. */
function envForInterpolation(hookEnv: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...hookEnv };
}

const HOOK_ARG_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolateHookArgs(template: string, lookup: Record<string, string>): string {
  return template.replace(HOOK_ARG_VAR, (_m, name: string) => lookup[name] ?? "");
}

function resolveCommandPrompt(
  step: CommandHookStep,
  customCommands: Map<string, CustomCommand>,
  hookEnv: Record<string, string>,
): string | null {
  const cmd = customCommands.get(step.command);
  if (!cmd) {
    console.warn(`nav hooks: unknown custom command "${step.command}"`);
    return null;
  }
  const lookup = envForInterpolation(hookEnv);
  const input = step.args !== undefined ? interpolateHookArgs(step.args, lookup) : "";
  return cmd.prompt.replace(/\{input\}/g, input);
}

export interface RunHookGroupResult {
  ok: boolean;
  output: string;
  failedLabel?: string;
}

/**
 * Run all steps in order. Command steps run `agent.run(prompt)` (LLM).
 */
export async function runHookGroup(
  event: "taskDone" | "planDone",
  group: HookGroup,
  env: Record<string, string>,
  ctx: HookRunContext,
): Promise<RunHookGroupResult> {
  if (group.steps.length === 0) {
    return { ok: true, output: "" };
  }
  const outputs: string[] = [];
  let stepIndex = 0;
  const totalSteps = group.steps.length;
  for (const step of group.steps) {
    stepIndex++;
    if ("shell" in step) {
      ctx.io.info(`hook ${event} [${stepIndex}/${totalSteps}]: ${step.shell}`);
      const r = await runShellHook(step.shell, ctx.cwd, env, ctx.hookTimeoutMs);
      outputs.push(`[${event} shell ${stepIndex}] ${step.shell}\n${r.output}`);
      if (!r.ok) {
        return {
          ok: false,
          output: outputs.join("\n\n"),
          failedLabel: `shell: ${step.shell}`,
        };
      }
    } else {
      const cmdLabel =
        step.args !== undefined && step.args.length > 0
          ? `/${step.command} ${step.args}`
          : `/${step.command}`;
      ctx.io.info(`hook ${event} [${stepIndex}/${totalSteps}]: ${cmdLabel} (custom command)`);
      const prompt = resolveCommandPrompt(step, ctx.customCommands, env);
      if (!prompt) {
        return {
          ok: false,
          output: outputs.join("\n\n") + `\nUnknown command /${step.command}`,
          failedLabel: `command: ${step.command}`,
        };
      }
      await ctx.agent.run(prompt);
      if (ctx.io.isAborted()) {
        return {
          ok: false,
          output: outputs.join("\n\n") + "\n[aborted during hook command]",
          failedLabel: `command: ${step.command}`,
        };
      }
      outputs.push(`[${event} command ${stepIndex}] /${step.command} (completed)`);
    }
  }
  return { ok: true, output: outputs.join("\n\n") };
}

export function buildHookRetryPrompt(task: Task, plan: Plan | undefined, result: RunHookGroupResult): string {
  let ctx = `Task #${task.id}: ${task.name}\n`;
  if (plan) ctx += `Plan #${plan.id}: ${plan.name}\n`;
  return (
    `${ctx}\n` +
    `The task-done verification hook failed (${result.failedLabel ?? "hook"}).\n` +
    `Fix the issues, then finish the task again.\n\n` +
    `--- hook output ---\n${result.output}\n--- end ---`
  );
}

export function buildPlanHookRetryPrompt(plan: Plan, result: RunHookGroupResult): string {
  return (
    `Plan #${plan.id}: ${plan.name}\n\n` +
    `The plan-done verification hook failed (${result.failedLabel ?? "hook"}).\n` +
    `Fix the issues affecting the whole plan.\n\n` +
    `--- hook output ---\n${result.output}\n--- end ---`
  );
}

/** Optional: called before each stop shell step (1-based index, shell-only count). */
export type StopHookOnStepStart = (shell: string, stepIndex: number, totalShellSteps: number) => void;

export async function runStopHooks(
  cwd: string,
  hookTimeoutMs: number,
  hooks: HooksConfig | undefined,
  log: (msg: string) => void,
  onStepStart?: StopHookOnStepStart,
): Promise<void> {
  const steps = hooks?.stop;
  if (!steps?.length) return;

  const shellSteps = steps.filter((s): s is ShellHookStep => !("command" in s));
  const totalShell = shellSteps.length;
  let shellIndex = 0;

  const env = { ...baseHookEnv(cwd, "stop") };
  for (const step of steps) {
    if ("command" in step) continue;
    shellIndex++;
    onStepStart?.(step.shell, shellIndex, totalShell);
    const r = await runShellHook(step.shell, cwd, env, hookTimeoutMs);
    if (!r.ok) {
      log(
        `stop hook failed: ${step.shell} (exit ${r.exitCode ?? "?"})${r.timedOut ? " [timed out]" : ""}`,
      );
    }
  }
}
