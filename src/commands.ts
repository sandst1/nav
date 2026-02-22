/**
 * Slash commands — quick actions handled directly in the main loop.
 */

import type { TUI } from "./tui";
import type { Config } from "./config";
import { detectProvider, detectBaseUrl, findApiKey, getKnownContextWindow } from "./config";
import type { Agent } from "./agent";
import type { LLMClient } from "./llm";
import type { CustomCommand } from "./custom-commands";
import type { Skill } from "./skills";
import { buildInitPrompt } from "./init";
import { buildCreateSkillPrompt } from "./create-skill";
import { loadTasks, saveTasks, type Task } from "./tasks";
import { loadPlans, type Plan } from "./plans";
import { theme, RESET, BOLD } from "./theme";

// ── Command registry ───────────────────────────────────────────────

export interface CommandInfo {
  name: string;
  description: string;
}

/** Built-in commands (used for /help and autocompletion). */
export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "clear",        description: "Clear history and reload system prompt" },
  { name: "create-skill", description: "Create a new skill" },
  { name: "init",         description: "Create or update AGENTS.md" },
  { name: "model",        description: "Show or switch model" },
  { name: "plan",          description: "Enter planning mode — discuss and create a plan" },
  { name: "plans",         description: "List all plans with task status summary" },
  { name: "plans split",   description: "Generate implementation tasks from a plan" },
  { name: "plans run",    description: "Work through all tasks belonging to a plan" },
  { name: "skills",       description: "List available skills" },
  { name: "tasks",        description: "List planned and in-progress tasks" },
  { name: "tasks add",    description: "Add a new task (freeform description)" },
  { name: "tasks done",   description: "List completed tasks" },
  { name: "tasks rm",     description: "Remove a task by id" },
  { name: "tasks run",   description: "Work on next (or specific) task" },
  { name: "handover",     description: "Summarize & continue in fresh context" },
  { name: "help",         description: "Show this help" },
];

// ── Command handling ───────────────────────────────────────────────

export interface CommandContext {
  tui: TUI;
  config: Config;
  agent: Agent;
  createLLMClient: (config: Config) => LLMClient;
  customCommands: Map<string, CustomCommand>;
  skills: Map<string, Skill>;
}

export interface CommandResult {
  handled: boolean;
  newLLMClient?: LLMClient;
  /** If set, trigger a handover with these user instructions. */
  handoverArgs?: string;
  /** If set, run this prompt through the agent (custom commands). */
  runPrompt?: string;
  /** If true, rebuild the system prompt after runPrompt completes. */
  reloadSystemPrompt?: boolean;
  /** If set, enter the interactive task-add confirmation loop. */
  taskAddMode?: { userText: string };
  /** If set, work on the given task id, or "next" to pick automatically. */
  workTask?: string | "next";
  /** If set, enter plan mode. */
  planDiscussionMode?: { userText: string };
  /** If set, generate tasks from this plan id. */
  planSplitMode?: { planId: number };
  /** If set, work through all tasks for this plan id. */
  workPlan?: number;
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult {
  if (!input.startsWith("/")) return { handled: false };

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "clear":
      return cmdClear(ctx);
    case "create-skill":
      return cmdCreateSkill(args, ctx);
    case "init":
      return cmdInit(ctx);
    case "model":
      return cmdModel(args, ctx);
    case "plan":
      return cmdPlan(args, ctx);
    case "plans":
      return cmdPlans(args, ctx);
    case "skills":
      return cmdSkills(ctx);
    case "tasks":
      return cmdTasks(args, ctx);
    case "handover":
      return cmdHandover(args, ctx);
    case "help":
      return cmdHelp(ctx);
    default: {
      // Check custom commands
      const custom = ctx.customCommands.get(cmd!);
      if (custom) {
        const userInput = args.join(" ").trim();
        const prompt = custom.prompt.replace(/\{input\}/g, userInput);
        return { handled: true, runPrompt: prompt };
      }
      ctx.tui.error(`Unknown command: /${cmd}. Type /help for available commands.`);
      return { handled: true };
    }
  }
}

function cmdClear(ctx: CommandContext): CommandResult {
  ctx.agent.clearHistory();
  ctx.tui.success("conversation cleared");
  // Also reload system prompt to pick up any changes
  return { handled: true, reloadSystemPrompt: true };
}

function cmdCreateSkill(args: string[], ctx: CommandContext): CommandResult {
  const skillName = args[0];
  const location = args[1] as "project" | "user" | undefined;
  const description = args.slice(location ? 2 : 1).join(" ").trim() || undefined;

  const prompt = buildCreateSkillPrompt(skillName, location, description, ctx.config.cwd);
  // Don't auto-reload - the agent will tell user to run /reload after skill is created
  return { handled: true, runPrompt: prompt };
}

function cmdInit(ctx: CommandContext): CommandResult {
  const prompt = buildInitPrompt(ctx.config.cwd);
  return { handled: true, runPrompt: prompt, reloadSystemPrompt: true };
}

function cmdModel(args: string[], ctx: CommandContext): CommandResult {
  if (args.length === 0) {
    const ctxStr = ctx.config.contextWindow
      ? `, ctx: ${ctx.config.contextWindow >= 1000 ? `${Math.round(ctx.config.contextWindow / 1000)}k` : ctx.config.contextWindow}`
      : "";
    ctx.tui.info(`current model: ${ctx.config.model} (${ctx.config.provider}${ctxStr})`);
    return { handled: true };
  }

  const newModel = args[0]!;
  ctx.config.model = newModel;
  ctx.config.provider = detectProvider(newModel);
  ctx.config.baseUrl = ctx.config.baseUrl || detectBaseUrl(ctx.config.provider, newModel);
  ctx.config.apiKey = findApiKey(ctx.config.provider);

  // Update context window for the new model
  const knownCtx = getKnownContextWindow(newModel);
  if (knownCtx) ctx.config.contextWindow = knownCtx;

  const newClient = ctx.createLLMClient(ctx.config);
  const ctxStr = ctx.config.contextWindow
    ? `, ctx: ${ctx.config.contextWindow >= 1000 ? `${Math.round(ctx.config.contextWindow / 1000)}k` : ctx.config.contextWindow}`
    : "";
  ctx.tui.success(`switched to ${newModel} (${ctx.config.provider}${ctxStr})`);
  return { handled: true, newLLMClient: newClient };
}

function cmdSkills(ctx: CommandContext): CommandResult {
  if (ctx.skills.size === 0) {
    ctx.tui.info("No skills available.");
    ctx.tui.info("Use /create-skill to create one, or add SKILL.md files to:");
    ctx.tui.info("  - .nav/skills/<skill-name>/SKILL.md (project)");
    ctx.tui.info("  - ~/.config/nav/skills/<skill-name>/SKILL.md (user)");
    return { handled: true };
  }

  ctx.tui.info("Skills:");
  for (const [, skill] of ctx.skills) {
    const src = skill.source === "project" ? "project" : "user";
    ctx.tui.info(`${skill.name.padEnd(20)} ${skill.description} (${src})`);
  }

  return { handled: true };
}

function cmdTasks(args: string[], ctx: CommandContext): CommandResult {
  const sub = args[0];

  if (!sub) {
    return cmdTasksList(ctx);
  }

  if (sub === "add") {
    const userText = args.slice(1).join(" ").trim();
    if (!userText) {
      ctx.tui.error("Usage: /tasks add <description of what to do>");
      return { handled: true };
    }
    return { handled: true, taskAddMode: { userText } };
  }

  if (sub === "rm") {
    const id = args[1];
    if (!id) {
      ctx.tui.error("Usage: /tasks rm <task_id>");
      return { handled: true };
    }
    return cmdTasksRm(id, ctx);
  }

  if (sub === "run") {
    const idArg = args[1];
    if (idArg !== undefined) {
      return { handled: true, workTask: idArg };
    }
    return { handled: true, workTask: "next" };
  }

  if (sub === "done") {
    return cmdTasksDone(ctx);
  }

  ctx.tui.error(`Unknown tasks subcommand: ${sub}. Use /tasks, /tasks add, /tasks done, /tasks rm, /tasks run`);
  return { handled: true };
}

function printTask(tui: TUI, task: Task): void {
  const statusLabel = task.status === "in_progress" ? "in progress"
    : task.status === "done" ? "done      "
    : "planned  ";
  // Build the row prefix: "#1-1   [planned  ]  "
  const idPart = `#${task.id.padEnd(6)}`;
  const statusPart = ` [${statusLabel}]  `;
  // hangIndent = visible width of everything before the task name
  const hangIndent = idPart.length + statusPart.length;

  tui.print(
    `${theme.dim}${idPart}${statusPart}${RESET}${BOLD}${task.name}${RESET}`,
    hangIndent,
  );
  if (task.description) {
    tui.print(`${theme.dim}${" ".repeat(hangIndent)}${task.description}${RESET}`, hangIndent);
  }
  if (task.relatedFiles?.length) {
    tui.print(`${theme.dim}${" ".repeat(hangIndent)}Files: ${task.relatedFiles.join(", ")}${RESET}`, hangIndent);
  }
  if (task.acceptanceCriteria?.length) {
    tui.print(`${theme.dim}${" ".repeat(hangIndent)}Acceptance:${RESET}`, hangIndent);
    for (const criterion of task.acceptanceCriteria) {
      tui.print(`${theme.dim}${" ".repeat(hangIndent + 2)}- ${criterion}${RESET}`, hangIndent + 4);
    }
  }
}

function cmdTasksList(ctx: CommandContext): CommandResult {
  const tasks = loadTasks(ctx.config.cwd);
  const active = tasks.filter((t) => t.status !== "done");

  if (active.length === 0) {
    ctx.tui.info("No tasks. Use /tasks add <description> to create one.");
    return { handled: true };
  }

  ctx.tui.info("Tasks:");
  for (const task of active) {
    printTask(ctx.tui, task);
  }
  return { handled: true };
}

function cmdTasksRm(id: string, ctx: CommandContext): CommandResult {
  const tasks = loadTasks(ctx.config.cwd);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    ctx.tui.error(`Task #${id} not found.`);
    return { handled: true };
  }
  const [removed] = tasks.splice(idx, 1) as [Task];
  saveTasks(ctx.config.cwd, tasks);
  ctx.tui.success(`Removed task #${id}: ${removed.name}`);
  return { handled: true };
}

function cmdTasksDone(ctx: CommandContext): CommandResult {
  const tasks = loadTasks(ctx.config.cwd);
  const done = tasks.filter((t) => t.status === "done");

  if (done.length === 0) {
    ctx.tui.info("No completed tasks yet.");
    return { handled: true };
  }

  ctx.tui.info("Completed tasks:");
  for (const task of done) {
    printTask(ctx.tui, task);
  }
  return { handled: true };
}

function cmdPlans(args: string[], ctx: CommandContext): CommandResult {
  const sub = args[0];

  if (!sub) {
    return cmdPlanList(ctx);
  }

  if (sub === "split") {
    const planId = parseInt(args[1] ?? "", 10);
    if (isNaN(planId)) {
      ctx.tui.error("Usage: /plans split <plan-id>");
      return { handled: true };
    }
    const plans = loadPlans(ctx.config.cwd);
    if (!plans.find((p) => p.id === planId)) {
      ctx.tui.error(`Plan #${planId} not found. Use /plans to see available plans.`);
      return { handled: true };
    }
    return { handled: true, planSplitMode: { planId } };
  }

  if (sub === "run") {
    const planId = parseInt(args[1] ?? "", 10);
    if (isNaN(planId)) {
      ctx.tui.error("Usage: /plans run <plan-id>");
      return { handled: true };
    }
    const plans = loadPlans(ctx.config.cwd);
    if (!plans.find((p) => p.id === planId)) {
      ctx.tui.error(`Plan #${planId} not found. Use /plans to see available plans.`);
      return { handled: true };
    }
    return { handled: true, workPlan: planId };
  }

  ctx.tui.error(`Unknown plans subcommand: ${sub}. Use /plans, /plans split, /plans run`);
  return { handled: true };
}

function cmdPlan(args: string[], ctx: CommandContext): CommandResult {
  // /plan [optional description] — enter conversational plan mode
  const userText = args.join(" ").trim();
  return { handled: true, planDiscussionMode: { userText } };
}

function cmdPlanList(ctx: CommandContext): CommandResult {
  const plans = loadPlans(ctx.config.cwd);
  if (plans.length === 0) {
    ctx.tui.info("No plans yet. Use /plan to start one.");
    return { handled: true };
  }

  const tasks = loadTasks(ctx.config.cwd);

  ctx.tui.info("Plans:");
  for (const plan of plans) {
    const planTasks = tasks.filter((t) => t.plan === plan.id);
    const total = planTasks.length;
    const done = planTasks.filter((t) => t.status === "done").length;
    const inProgress = planTasks.filter((t) => t.status === "in_progress").length;
    const planned = planTasks.filter((t) => t.status === "planned").length;

    const statusSummary = total === 0
      ? "no tasks"
      : `${done}/${total} done${inProgress ? `, ${inProgress} in progress` : ""}${planned ? `, ${planned} planned` : ""}`;

    // "#1  " = 4 chars before name
    const idPart = `#${String(plan.id).padEnd(3)} `;
    const hangIndent = idPart.length;
    ctx.tui.print(
      `${theme.dim}${idPart}${RESET}${BOLD}${plan.name}${RESET}${theme.dim}  [${statusSummary}]${RESET}`,
      hangIndent,
    );
    if (plan.description) {
      ctx.tui.print(`${theme.dim}${" ".repeat(hangIndent)}${plan.description}${RESET}`, hangIndent);
    }
  }
  return { handled: true };
}

function cmdHandover(args: string[], ctx: CommandContext): CommandResult {
  if (ctx.agent.getMessageCount() === 0) {
    ctx.tui.error("Nothing to hand over — conversation is empty.");
    return { handled: true };
  }
  const userInstructions = args.join(" ").trim() || undefined;
  return { handled: true, handoverArgs: userInstructions ?? "" };
}

function cmdHelp(ctx: CommandContext): CommandResult {
  ctx.tui.info("Commands:");
  for (const cmd of BUILTIN_COMMANDS) {
    ctx.tui.info(`/${cmd.name.padEnd(20)} ${cmd.description}`);
  }

  if (ctx.customCommands.size > 0) {
    ctx.tui.info("");
    ctx.tui.info("Custom commands:");
    for (const [name, cmd] of ctx.customCommands) {
      const src = cmd.source === "project" ? "project" : "user";
      ctx.tui.info(`/${name.padEnd(20)} ${cmd.description} (${src})`);
    }
  }

  return { handled: true };
}
