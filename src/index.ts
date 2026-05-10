#!/usr/bin/env bun
/**
 * nav — minimalist coding agent entry point.
 *
 * Interactive mode:  nav
 * One-shot mode:     nav "fix the bug in main.ts"
 */

import { parseArgs, resolveConfig, loadConfigFiles, effectiveSandbox, HELP_TEXT, type ConfigFileValues, type Config, type EditMode, type PlanMode } from "./config";
import { isAlreadySandboxed, isSandboxAvailable, execSandbox } from "./sandbox";
import { createLLMClient, detectOllamaContextWindow } from "./llm";
import { buildSystemPrompt } from "./prompt";
import { Agent } from "./agent";
import { ProcessManager } from "./process-manager";
import { Logger } from "./logger";
import { TUI } from "./tui";
import { handleCommand, BUILTIN_COMMANDS } from "./commands";
import { loadCustomCommands } from "./custom-commands";
import { loadSkills } from "./skills";
import { SkillWatcher } from "./skill-watcher";
import { theme, RESET, setTheme } from "./theme";
import {
  loadTasks,
  saveTasks,
  getWorkableTasks,
  getWorkableTasksForPlan,
  parsePlanTasks,
  taskFromPlanDraft,
  type Task,
} from "./tasks";
import { buildMicrosplitPrompt, buildSplitPrompt, buildGoalsSplitPrompt } from "./plan-split-prompts";
import { verifyTaskCriteria, summarizeVerification, type VerificationSummary } from "./verify-goals";
import { loadPlans, savePlans, nextPlanId, nextStandaloneId, nextPlanTaskId, parsePlanDraft, type Plan } from "./plans";
import { expandAtMentions } from "./at-mention";
import { runUiServer } from "./ui-server";
import { parseJsonFromAssistantText } from "./json-block";
import type { HookRunCompleteMeta } from "./hooks";
import {
  mergeHookGroups,
  runHookGroup,
  runStopHooks,
  buildHookRetryPrompt,
  buildPlanHookRetryPrompt,
  taskDoneEnv,
  planDoneEnv,
  type HookRunContext,
} from "./hooks";
import type { CustomCommand } from "./custom-commands";

function buildNavSystemPrompt(config: Config): string {
  return buildSystemPrompt(config.cwd, config.editMode, { allowedToolNames: config.allowedTools });
}

function createNavLLMClient(
  config: Config,
  extra?: { includeAskUserTool?: boolean; allowedToolNames?: string[] },
) {
  return createLLMClient(config, {
    allowedToolNames: extra?.allowedToolNames ?? config.allowedTools,
    ...(extra?.includeAskUserTool ? { includeAskUserTool: true } : {}),
  });
}

/** Planning/splitting: allow read tools + shell for exploration, but no edit/write. */
function planningToolAllowlist(config: Config): string[] {
  const planTools = ["read", "skim", "filegrep", "shell", "shell_status"];
  if (!config.allowedTools || config.allowedTools.length === 0) return planTools;
  return planTools.filter((tool) => config.allowedTools!.includes(tool));
}

/**
 * Run verification phase for a set of tasks in goals mode.
 * Verifies each task's acceptance criteria and displays results.
 * Returns summaries for all verified tasks.
 */
async function runVerificationPhase(
  agent: Agent,
  config: Config,
  tasksToVerify: Task[],
  tui: TUI,
): Promise<VerificationSummary[]> {
  const tasksWithCriteria = tasksToVerify.filter(
    (t) => t.acceptanceCriteria && t.acceptanceCriteria.length > 0
  );

  if (tasksWithCriteria.length === 0) {
    return [];
  }

  tui.separator();
  tui.info(`Verification phase: checking ${tasksWithCriteria.length} goal(s)...`);
  tui.separator();

  const summaries: VerificationSummary[] = [];
  let allTasksUpdated = loadTasks(config.cwd);

  for (const taskToVerify of tasksWithCriteria) {
    if (tui.isAborted()) break;

    tui.info(`Verifying Goal #${taskToVerify.id}: ${taskToVerify.name}`);

    agent.clearHistory();
    agent.setSystemPrompt(buildNavSystemPrompt(config));

    const results = await verifyTaskCriteria(taskToVerify, agent);
    const summary = summarizeVerification(taskToVerify, results);
    summaries.push(summary);

    // Update task with verification results and track failures
    const taskIdx = allTasksUpdated.findIndex((t) => t.id === taskToVerify.id);
    if (taskIdx !== -1) {
      const failedCriteria = results.filter((r) => !r.passed);
      allTasksUpdated[taskIdx] = {
        ...allTasksUpdated[taskIdx]!,
        criteriaResults: results,
        failedCriteria: failedCriteria.length > 0 ? failedCriteria : undefined,
      };
    }

    // Display results
    for (const r of results) {
      const icon = r.passed ? theme.success + "✓" : theme.error + "✗";
      tui.print(`  ${icon} ${r.criterion}${RESET}`);
      if (!r.passed || config.verbose) {
        tui.print(`    ${theme.dim}${r.evidence}${RESET}`);
      }
    }

    tui.separator();
  }

  // Save updated tasks with verification results
  saveTasks(config.cwd, allTasksUpdated);

  // Show summary
  const totalPassed = summaries.reduce((sum, s) => sum + s.passed, 0);
  const totalCriteria = summaries.reduce((sum, s) => sum + s.total, 0);
  const allPassed = totalPassed === totalCriteria;

  tui.info(
    allPassed
      ? `${theme.success}Verification complete: ${totalPassed}/${totalCriteria} criteria passed${RESET}`
      : `${theme.warning}Verification complete: ${totalPassed}/${totalCriteria} criteria passed${RESET}`
  );

  return summaries;
}

/**
 * Build a fix-focused prompt for a task that has failed criteria.
 */
function buildFixPrompt(task: Task): string {
  const failedCriteria = task.failedCriteria ?? [];
  if (failedCriteria.length === 0) {
    return `Goal #${task.id}: ${task.name}\n\nNo failed criteria to fix.`;
  }

  let prompt = `Fix the following issues with Goal #${task.id}: ${task.name}\n\n`;

  prompt += `The following acceptance criteria FAILED verification:\n\n`;
  for (let i = 0; i < failedCriteria.length; i++) {
    const fc = failedCriteria[i]!;
    prompt += `${i + 1}. ${fc.criterion}\n`;
    prompt += `   Reason: ${fc.evidence}\n\n`;
  }

  prompt += `Review the implementation and fix these specific issues. `;
  prompt += `Focus only on what's needed to satisfy these criteria.\n`;

  if (task.relatedFiles?.length) {
    prompt += `\nRelated files: ${task.relatedFiles.join(", ")}\n`;
  }

  return prompt;
}

/**
 * Clear failedCriteria from a task after it has been reworked.
 */
function clearTaskFailedCriteria(cwd: string, taskId: string): void {
  const tasks = loadTasks(cwd);
  const taskIdx = tasks.findIndex((t) => t.id === taskId);
  if (taskIdx !== -1) {
    tasks[taskIdx] = { ...tasks[taskIdx]!, failedCriteria: undefined };
    saveTasks(cwd, tasks);
  }
}

/**
 * Run fix-and-reverify loop for tasks with failed criteria.
 * Returns when all criteria pass or max attempts reached.
 */
async function runFixLoop(
  agent: Agent,
  config: Config,
  tasksToCheck: Task[],
  tui: TUI,
): Promise<void> {
  const maxAttempts = config.taskImplementationMaxAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Reload tasks to get current failedCriteria state
    const allTasks = loadTasks(config.cwd);
    const taskIds = tasksToCheck.map((t) => t.id);
    const tasksNeedingFix = allTasks.filter(
      (t) => taskIds.includes(t.id) && t.failedCriteria && t.failedCriteria.length > 0
    );

    if (tasksNeedingFix.length === 0) {
      return; // All criteria passed
    }

    tui.separator();
    tui.info(
      `${theme.warning}Fix cycle ${attempt}/${maxAttempts}: ${tasksNeedingFix.length} goal(s) need fixes${RESET}`
    );

    // Work on each task that needs fixing
    for (const task of tasksNeedingFix) {
      if (tui.isAborted()) return;

      const failedCount = task.failedCriteria?.length ?? 0;
      tui.info(`Fixing Goal #${task.id}: ${task.name} (${failedCount} failed criteria)`);

      agent.clearHistory();
      agent.setSystemPrompt(buildNavSystemPrompt(config));
      await agent.run(buildFixPrompt(task));

      if (tui.isAborted()) return;

      // Clear failedCriteria after rework (will be repopulated by verification)
      clearTaskFailedCriteria(config.cwd, task.id);
    }

    // Re-verify the tasks that were just fixed
    const refreshedTasks = loadTasks(config.cwd).filter((t) => taskIds.includes(t.id));
    await runVerificationPhase(agent, config, refreshedTasks, tui);
  }

  // Check if there are still failures after all attempts
  const finalTasks = loadTasks(config.cwd);
  const taskIds = tasksToCheck.map((t) => t.id);
  const remainingFailures = finalTasks.filter(
    (t) => taskIds.includes(t.id) && t.failedCriteria && t.failedCriteria.length > 0
  );

  if (remainingFailures.length > 0) {
    tui.separator();
    tui.info(
      `${theme.error}Fix attempts exhausted: ${remainingFailures.length} goal(s) still have failing criteria${RESET}`
    );
    for (const task of remainingFailures) {
      tui.print(`  ${theme.error}Goal #${task.id}: ${task.failedCriteria?.length ?? 0} failed criteria${RESET}`);
    }
  }
}


/** Implements `nav config-init` — creates .nav/nav.config.json if absent. */
async function runConfigInit(cwd: string): Promise<void> {
  const { join } = await import("node:path");
  const { existsSync, mkdirSync } = await import("node:fs");

  const navDir = join(cwd, ".nav");
  const configPath = join(navDir, "nav.config.json");

  if (existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    return;
  }

  // Hand-crafted so we can include spacing between logical groups.
  const content = `{
  "model": "gpt-4.1",
  "provider": "openai",

  "verbose": false,
  "sandbox": false,

  "handoverThreshold": 0.8,

  "theme": "nordic"
}
`;

  try {
    if (!existsSync(navDir)) mkdirSync(navDir, { recursive: true });
    await Bun.write(configPath, content);
    console.log(`Created ${configPath}`);
  } catch (err) {
    console.error(`Failed to create config: ${err}`);
    process.exit(1);
  }
}

/** Parse a JSON block from the agent's task-draft response. */
function parseTaskDraft(text: string): { name: string; description: string; relatedFiles?: string[]; acceptanceCriteria?: string[] } | null {
  const parsed = parseJsonFromAssistantText(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  try {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name === "string" && typeof obj.description === "string") {
      const relatedFiles = Array.isArray(obj.relatedFiles) ? (obj.relatedFiles as unknown[]).filter((f): f is string => typeof f === "string") : undefined;
      const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria) ? (obj.acceptanceCriteria as unknown[]).filter((c): c is string => typeof c === "string") : undefined;
      return {
        name: obj.name,
        description: obj.description,
        ...(relatedFiles?.length ? { relatedFiles } : {}),
        ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}),
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Build the work prompt for a task, including optional plan context and sibling task status. */
function buildWorkPrompt(
  task: Task,
  plan?: Plan,
  planTasks?: Task[],
  editMode: EditMode = "hashline",
  planMode: PlanMode = "specs",
): string {
  const isGoals = planMode === "goals";
  const taskLabel = isGoals ? "Goal" : "Task";

  let prompt: string;

  if (isGoals) {
    // Goals mode: lead with criteria, minimal description
    prompt = `You are working on the following goal:\n\n` +
      `${taskLabel} #${task.id}: ${task.name}\n`;

    if (task.acceptanceCriteria?.length) {
      prompt += `\nCriteria to satisfy:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n`;
    }

    if (task.description) {
      prompt += `\nContext hints: ${task.description}\n`;
    }

    if (task.relatedFiles?.length) {
      prompt += `\nRelated files: ${task.relatedFiles.join(", ")}\n`;
    }
  } else {
    // Specs mode: traditional task-focused prompt
    prompt = `You are working on the following task:\n\n` +
      `${taskLabel} #${task.id}: ${task.name}\n${task.description}\n`;

    if (task.relatedFiles?.length) {
      prompt += `\nRelated files:\n${task.relatedFiles.map((f) => `- ${f}`).join("\n")}\n`;
    }
    if (task.acceptanceCriteria?.length) {
      prompt += `\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n`;
    }
  }

  if (task.codeContext) {
    const cc = task.codeContext;
    prompt +=
      `\nInline code context (from task planning — verify anchors with skim if the repo may have changed):\n`;
    if (cc.insertionPoint) {
      prompt += `\nInsertion point:\n${cc.insertionPoint}\n`;
    }
    if (cc.patternExample) {
      prompt += `\nPattern to follow:\n${cc.patternExample}\n`;
    }
    if (cc.signature) {
      prompt += `\nSignature / interface:\n${cc.signature}\n`;
    }
  }

  if (plan) {
    prompt +=
      `\n---\nPlan context (Plan #${plan.id}: ${plan.name})\n` +
      `${plan.description}\n`;
    if (!isGoals && plan.approach) {
      prompt += `\nApproach: ${plan.approach}\n`;
    }
  }

  if (planTasks && planTasks.length > 0) {
    prompt += `\nAll ${isGoals ? "goals" : "tasks"} in this plan:\n`;
    for (const t of planTasks) {
      const marker = t.id === task.id ? "→" : " ";
      const statusLabel = t.status === "in_progress" ? "in progress" : t.status === "done" ? "done" : "planned";
      prompt += `  ${marker} #${t.id}: [${statusLabel}] ${t.name}\n`;
    }
  }

  if (!isGoals && (task.relatedFiles?.length || task.codeContext)) {
    const readHint =
      editMode === "searchReplace"
        ? `- Read ±20 lines around the area you need to modify — enough to copy an exact old_string for the edit tool\n`
        : `- Read ±20 lines around the area you need to modify — enough for context and hashline anchors\n`;
    prompt += `\nTool guidance:\n`;
    if (task.codeContext) {
      prompt +=
        `- Prefer the inline code context above; use skim(path, start, end) only to verify anchors before editing\n` +
        `- Use filegrep(path, "symbol") if line numbers drifted and you need to re-locate code\n`;
    } else {
      prompt +=
        `- Use skim(path, start, end) to read specific line ranges — don't read entire files\n` +
        `- Use filegrep(path, "symbol") to locate functions, classes, or variables by name\n`;
    }
    prompt += readHint + `- Follow any "Start:" recipe in the task description above\n`;
  }

  if (isGoals) {
    prompt +=
      `\nFigure out how to achieve this goal. You decide the implementation approach.\n` +
      `When you are done, say "${taskLabel} #${task.id} complete." so the system can mark it as done.\n` +
      `(Criteria will be verified separately after implementation.)`;
  } else {
    prompt +=
      `\nComplete this task` +
      (task.acceptanceCriteria?.length ? `, ensuring all acceptance criteria are met` : ``) +
      `. When you are done, say "${taskLabel} #${task.id} complete." so the system can mark it as done.`;
  }

  return prompt;
}

function hookRunContext(
  config: Config,
  agent: Agent,
  customCommands: Map<string, CustomCommand>,
  tui: TUI,
): HookRunContext {
  return {
    cwd: config.cwd,
    hookTimeoutMs: config.hookTimeoutMs,
    io: tui,
    agent,
    customCommands,
  };
}

function markTaskDoneOnDisk(cwd: string, taskId: string): void {
  const tasks = loadTasks(cwd);
  const t = tasks.find((x) => x.id === taskId);
  if (t && t.status !== "done") {
    t.status = "done";
    saveTasks(cwd, tasks);
  }
}

type TaskFinalize = "done" | "aborted" | "hook_failed";

/** One full cycle: work prompt + taskDone hooks. Stops after config.taskImplementationMaxAttempts hook failures. */
type ImplementationLoopOutcome = "task_done" | "aborted" | "attempts_exhausted";

async function runTaskImplementationLoop(
  agent: Agent,
  config: Config,
  taskId: string,
  resolvePlan: (task: Task) => { plan: Plan | undefined; siblingTasks: Task[] | undefined },
  customCommands: Map<string, CustomCommand>,
  tui: TUI,
): Promise<ImplementationLoopOutcome> {
  const max = config.taskImplementationMaxAttempts;
  for (let impl = 1; impl <= max; impl++) {
    const tasks = loadTasks(config.cwd);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return "aborted";

    if (impl > 1) {
      tui.taskStart(`Retrying task #${task.id} — implementation attempt ${impl}/${max}`);
    } else {
      tui.taskStart(`Working on task #${task.id}: ${task.name}`);
    }

    task.status = "in_progress";
    saveTasks(config.cwd, tasks);

    const { plan, siblingTasks } = resolvePlan(task);

    agent.clearHistory();
    agent.setSystemPrompt(buildNavSystemPrompt(config));
    await agent.run(buildWorkPrompt(task, plan, siblingTasks, config.editMode, config.planMode));

    if (tui.isAborted()) {
      tui.info(`Task #${task.id} interrupted — left as in_progress.`);
      return "aborted";
    }

    const fin = await finalizeTaskAfterWork(agent, config, task, plan, customCommands, tui);
    if (fin === "done") return "task_done";
    if (fin === "aborted") return "aborted";
    if (fin === "hook_failed") {
      if (impl === max) {
        tui.error(
          `Stopping: task #${task.id} — implementation attempts exhausted (${max}).`,
        );
        return "attempts_exhausted";
      }
    }
  }
  return "attempts_exhausted";
}

async function finalizeTaskAfterWork(
  agent: Agent,
  config: Config,
  task: Task,
  taskPlan: Plan | undefined,
  customCommands: Map<string, CustomCommand>,
  tui: TUI,
): Promise<TaskFinalize> {
  if (tui.isAborted()) return "aborted";

  const groups = config.hooks?.taskDone;
  if (!groups?.length) {
    markTaskDoneOnDisk(config.cwd, task.id);
    tui.success(`Task #${task.id} marked as done.`);
    return "done";
  }

  const merged = mergeHookGroups(groups);
  if (merged.steps.length === 0) {
    markTaskDoneOnDisk(config.cwd, task.id);
    tui.success(`Task #${task.id} marked as done.`);
    return "done";
  }

  const ctx = hookRunContext(config, agent, customCommands, tui);
  let attempt = 0;
  while (true) {
    attempt++;
    const env = taskDoneEnv(config.cwd, task, taskPlan, attempt);
    const result = await runHookGroup("taskDone", merged, env, ctx);
    if (result.ok) {
      markTaskDoneOnDisk(config.cwd, task.id);
      tui.success(`Task #${task.id} marked as done.`);
      return "done";
    }
    if (attempt >= merged.maxAttempts) {
      tui.error(`Task #${task.id} verification failed after ${merged.maxAttempts} attempt(s).`);
      return "hook_failed";
    }
    if (tui.isAborted()) return "aborted";
    await agent.run(buildHookRetryPrompt(task, taskPlan, result));
    if (tui.isAborted()) return "aborted";
  }
}

type PlanFinalize = "ok" | "aborted" | "hook_failed";

async function finalizePlanAfterAllTasks(
  agent: Agent,
  config: Config,
  plan: Plan,
  planTaskCount: number,
  customCommands: Map<string, CustomCommand>,
  tui: TUI,
): Promise<PlanFinalize> {
  if (tui.isAborted()) return "aborted";

  const groups = config.hooks?.planDone;
  if (!groups?.length) return "ok";

  const merged = mergeHookGroups(groups);
  if (merged.steps.length === 0) return "ok";

  const ctx = hookRunContext(config, agent, customCommands, tui);
  let attempt = 0;
  while (true) {
    attempt++;
    const env = planDoneEnv(config.cwd, plan, planTaskCount, attempt);
    const result = await runHookGroup("planDone", merged, env, ctx);
    if (result.ok) return "ok";
    if (attempt >= merged.maxAttempts) {
      tui.error(`Plan #${plan.id} verification failed after ${merged.maxAttempts} attempt(s).`);
      return "hook_failed";
    }
    if (tui.isAborted()) return "aborted";
    await agent.run(buildPlanHookRetryPrompt(plan, result));
    if (tui.isAborted()) return "aborted";
  }
}

function stopHookHandler(config: Config, tui: TUI): (meta: HookRunCompleteMeta) => void | Promise<void> {
  return async (meta: HookRunCompleteMeta) => {
    if (meta.aborted) return;
    await runStopHooks(
      config.cwd,
      config.hookTimeoutMs,
      config.hooks,
      (msg) => {
        tui.info(`${theme.warning}hook: ${msg}${RESET}`);
      },
      (shell, i, n) => {
        tui.info(`hook stop [${i}/${n}]: ${shell}`);
      },
    );
  };
}

/** Show a numbered task list parsed from the plan text. */
function showPlanTaskPreview(tui: TUI, planText: string): void {
  const tasks = parsePlanTasks(planText);
  if (!tasks || tasks.length === 0) return;
  tui.info(`\nTasks (${tasks.length}):`);
  for (let i = 0; i < tasks.length; i++) {
    tui.info(`${i + 1}. ${tasks[i]!.name} — ${tasks[i]!.description}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // config-init subcommand — create .nav/nav.config.json if it doesn't exist yet
  if (flags.subcommand === "config-init") {
    await runConfigInit(process.cwd());
    process.exit(0);
  }

  // Load config files early so sandbox decision can read nav.config.json
  const fileConfig = loadConfigFiles(process.cwd());

  // Sandbox: re-exec under sandbox-exec if requested and not already inside
  if (effectiveSandbox(flags.sandbox, fileConfig.sandbox) && !isAlreadySandboxed()) {
    if (!isSandboxAvailable()) {
      console.error("sandbox: sandbox-exec not found (macOS only)");
      process.exit(1);
    }
    execSandbox(); // re-execs, never returns
  }

  // Apply theme before anything renders
  const fileTheme = process.env.NAV_THEME ?? fileConfig.theme;
  if (fileTheme) setTheme(fileTheme);

  const config = resolveConfig(flags, fileConfig);
  const logger = new Logger(config.cwd, config.verbose);
  const tui = new TUI();
  const llm = createNavLLMClient(config);
  const systemPrompt = buildNavSystemPrompt(config);
  const processManager = new ProcessManager();

  // Detect context window for Ollama models if not already known
  if (config.provider === "ollama" && !config.contextWindow) {
    const detected = await detectOllamaContextWindow(config.model, config.baseUrl);
    if (detected) {
      config.contextWindow = detected;
    } else {
      console.warn(
        `${theme.warning}⚠ Could not reach Ollama — is it running? ` +
        `Context window detection skipped; using default.${RESET}`,
      );
    }
  }

  logger.logConfig({
    model: config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
    verbose: config.verbose,
    cwd: config.cwd,
    contextWindow: config.contextWindow,
    handoverThreshold: config.handoverThreshold,
  });

  logger.logSystemPrompt(systemPrompt);

  // Optional websocket/http backend mode for desktop UI clients.
  if (flags.subcommand === "ui-server") {
    const host = flags.uiHost ?? process.env.NAV_UI_HOST ?? "127.0.0.1";
    const envPort = process.env.NAV_UI_PORT ? parseInt(process.env.NAV_UI_PORT, 10) : undefined;
    const port = flags.uiPort ?? envPort ?? 7777;
    if (!Number.isFinite(port) || port <= 0) {
      console.error("ui-server: invalid port");
      process.exit(1);
    }
    await runUiServer({ config, logger, host, port });
    return;
  }

  const agent = new Agent({
    llm,
    systemPrompt,
    cwd: config.cwd,
    logger,
    io: tui,
    processManager,
    contextWindow: config.contextWindow,
    handoverThreshold: config.handoverThreshold,
    onRunComplete: stopHookHandler(config, tui),
    editMode: config.editMode,
    runtimeConfig: config,
  });

  // Clean shutdown handler
  const cleanup = () => {
    processManager.killAll();
    skillWatcher.stop();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("exit", cleanup);

  // Load custom commands and skills
  const customCommands = loadCustomCommands(config.cwd);
  let skills = loadSkills(config.cwd);

  // Watch skill directories for changes (event-driven, not polling)
  const skillWatcher = new SkillWatcher();
  skillWatcher.start(config.cwd);

  // Build command list for TUI autocompletion
  const allCommands = [
    ...BUILTIN_COMMANDS.map((c) => ({ name: c.name, description: c.description })),
    ...[...customCommands.values()].map((c) => ({ name: c.name, description: c.description })),
  ];
  tui.setCommands(allCommands);
  tui.setProjectRoot(config.cwd);

  // One-shot mode
  if (flags.prompt) {
    // Check if the prompt is a slash command
    if (flags.prompt.startsWith("/")) {
      const result = handleCommand(flags.prompt, {
        tui,
        config,
        agent,
        createLLMClient: createNavLLMClient,
        customCommands,
        skills,
      });
      if (result.handled) {
        if (result.newLLMClient) {
          agent.setLLM(result.newLLMClient);
          if (config.contextWindow) {
            agent.setContextWindow(config.contextWindow);
          }
        }
        if (result.handoverArgs !== undefined) {
          await agent.handover(result.handoverArgs || undefined);
        }
        if (result.runPrompt !== undefined) {
          await agent.run(result.runPrompt);
        }
        // Reload system prompt if requested (e.g., after /clear or /init)
        if (result.reloadSystemPrompt) {
          const newSystemPrompt = buildNavSystemPrompt(config);
          agent.setSystemPrompt(newSystemPrompt);
          skills = loadSkills(config.cwd);
        }
      }
      cleanup();
      process.exit(0);
    }
    const expandedPrompt = await expandAtMentions(flags.prompt, config.cwd, config.editMode);
    await agent.run(expandedPrompt);
    cleanup();
    process.exit(0);
  }

  // Interactive mode
  tui.banner(config.model, config.provider, logger.logPath, config.contextWindow, config.handoverThreshold);

  while (true) {
    const input = await tui.prompt();
    if (input === null) {
      tui.info("bye");
      break;
    }

    // Handle slash commands
    if (input.startsWith("/")) {
      const result = handleCommand(input, {
        tui,
        config,
        agent,
        createLLMClient: createNavLLMClient,
        customCommands,
        skills,
      });
      if (result.handled) {
        if (result.newLLMClient) {
          agent.setLLM(result.newLLMClient);
          // Update context window for new model
          if (config.contextWindow) {
            agent.setContextWindow(config.contextWindow);
          }
        }
        if (result.handoverArgs !== undefined) {
          await agent.handover(result.handoverArgs || undefined);
        }
        if (result.runPrompt !== undefined) {
          await agent.run(result.runPrompt);
        }
        // Reload system prompt if requested (e.g., after /clear or /init)
        if (result.reloadSystemPrompt) {
          const newSystemPrompt = buildNavSystemPrompt(config);
          agent.setSystemPrompt(newSystemPrompt);
          skills = loadSkills(config.cwd);
        }

        // /tasks add confirmation loop
        if (result.taskAddMode) {
          const { userText } = result.taskAddMode;
          let draftPrompt =
            `The user wants to add a task to their task list. Here is their description:\n\n"${userText}"\n\n` +
            `Based on this, create a concise task with a short name, a clear description, a list of related files (if applicable), and acceptance criteria. ` +
            `Respond with ONLY a JSON object in this exact format (no other text):\n` +
            `{"name": "short task name", "description": "clear description of what needs to be done", "relatedFiles": ["src/foo.ts"], "acceptanceCriteria": ["criterion one", "criterion two"]}\n` +
            `relatedFiles and acceptanceCriteria may be empty arrays if not applicable.`;

          let confirmed = false;
          while (!confirmed) {
            agent.clearHistory();
            await agent.run(draftPrompt);
            const lastText = agent.getLastAssistantText();
            const draft = lastText ? parseTaskDraft(lastText) : null;

            if (!draft) {
              tui.error("Could not parse task from agent response. Try again with /tasks add.");
              break;
            }

            tui.info(`\nTask preview:`);
            tui.info(`Name:        ${draft.name}`);
            tui.info(`Description: ${draft.description}`);
            if (draft.relatedFiles?.length) {
              tui.info(`Files:       ${draft.relatedFiles.join(", ")}`);
            }
            if (draft.acceptanceCriteria?.length) {
              tui.info(`Acceptance:`);
              for (const criterion of draft.acceptanceCriteria) {
                tui.info(`  - ${criterion}`);
              }
            }
            tui.info(`\n[y]es to save, [n]o to give more instructions, [a]bandon`);

            const answer = await tui.prompt();
            if (answer === null || answer.toLowerCase() === "a" || answer.toLowerCase() === "abandon") {
              tui.info("Task creation abandoned.");
              break;
            }
            if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
              const tasks = loadTasks(config.cwd);
              const newTask: Task = {
                id: nextStandaloneId(tasks),
                name: draft.name,
                description: draft.description,
                status: "planned",
                ...(draft.relatedFiles?.length ? { relatedFiles: draft.relatedFiles } : {}),
                ...(draft.acceptanceCriteria?.length ? { acceptanceCriteria: draft.acceptanceCriteria } : {}),
              };
              tasks.push(newTask);
              saveTasks(config.cwd, tasks);
              tui.success(`Task #${newTask.id} added: ${newTask.name}`);
              confirmed = true;
            } else {
              // n or anything else: treat the answer as additional instructions
              const moreInstructions = answer.replace(/^n\s*/i, "").trim() || await (async () => {
                tui.info("Provide more instructions:");
                return (await tui.prompt()) ?? "";
              })();
              draftPrompt =
                `The user wants to add a task. Original description: "${userText}"\n\n` +
                `Previous draft was:\n${JSON.stringify({ name: draft.name, description: draft.description, relatedFiles: draft.relatedFiles ?? [], acceptanceCriteria: draft.acceptanceCriteria ?? [] }, null, 2)}\n\n` +
                `User feedback / additional instructions: "${moreInstructions}"\n\n` +
                `Revise the task and respond with ONLY a JSON object:\n` +
                `{"name": "short task name", "description": "clear description", "relatedFiles": [...], "acceptanceCriteria": [...]}`;
            }
          }
          agent.clearHistory();
        }

        // /plan — enter conversational plan mode
        if (result.planDiscussionMode) {
          const { userText } = result.planDiscussionMode;

          agent.clearHistory();
          const isGoalsModeBanner = config.planMode === "goals";
          tui.setPromptPrefix(isGoalsModeBanner ? "[goals]" : "[plan]");
          tui.separator();
          tui.info(
            isGoalsModeBanner
              ? `Goals mode — define outcomes and criteria, then confirm to save. Type /plan exit to leave.`
              : `Plan mode — discuss the idea, then confirm to save the plan. Type /plan exit to leave.`
          );
          tui.separator();

            agent.setLLM(
              createNavLLMClient(config, {
                includeAskUserTool: true,
                allowedToolNames: planningToolAllowlist(config),
              }),
            );
          try {
            const isGoalsMode = config.planMode === "goals";
            const planModePrompt = isGoalsMode
              ? `You are in GOALS mode planning. Your job is to help the user define WHAT success looks like — outcomes and acceptance criteria — not HOW to implement.\n\n` +
                `How to behave:\n` +
                `1. Discuss the idea conversationally. Ask clarifying questions ONE AT A TIME to understand the desired outcome.\n` +
                `   Use shell (ls, find, tree) and read/skim/filegrep to explore the codebase.\n` +
                `2. Focus on OUTCOMES: What should be true when this is done? What can be verified?\n` +
                `3. When the user confirms the outcomes look good, output the plan as TEXT in your response (NOT a file!) with YAML frontmatter:\n\n` +
                "---\n" +
                "name: short plan name (outcome-focused)\n" +
                "description: one-sentence summary of success state\n" +
                "---\n\n" +
                `Then write a brief context section describing the desired outcomes.\n` +
                `The system will parse this from your message and prompt the user to save it.\n\n` +
                `IMPORTANT: Output the plan as text in your message. Do NOT use the write tool to create a file.\n` +
                `Do not describe HOW to implement. Do not create goals or criteria yet — that comes from /plans split AFTER the plan is saved.\n\n` +
                (userText
                  ? `The user's idea: "${userText}"`
                  : `The user has entered goals mode planning. Ask them what outcome they'd like to achieve.`)
              : `You are in plan mode. Your job is to help the user think through and design an idea before any code is written.\n\n` +
                `How to behave:\n` +
                `1. Discuss the idea conversationally. Ask clarifying questions ONE AT A TIME — do not dump a list.\n` +
                `   Use shell (ls, find, tree) and read/skim/filegrep to explore the codebase.\n` +
                `2. Once you and the user have enough clarity, produce a formal plan in markdown below the frontmatter.\n` +
                `3. When ready to present the plan, output it as TEXT in your response (NOT a file!) with YAML frontmatter:\n\n` +
                "---\n" +
                "name: short plan name\n" +
                "description: one-sentence summary\n" +
                "---\n\n" +
                `Then write the full plan in markdown (sections, lists, code fences as needed). The body becomes the stored plan approach.\n` +
                `The system will parse this from your message and prompt the user to save it.\n\n` +
                `IMPORTANT: Output the plan as text in your message. Do NOT use the write tool to create a file.\n` +
                `Do not implement anything. Do not create tasks. Only plan.\n\n` +
                (userText
                  ? `The user's idea: "${userText}"`
                  : `The user has entered plan mode. Ask them what they'd like to plan.`);

            await agent.run(planModePrompt);

            let lastPlanText = agent.getLastAssistantText() ?? "";
            let hasDraft = !!parsePlanDraft(lastPlanText);
            let exitPlanMode = false;

            while (!exitPlanMode) {
              if (hasDraft) {
                // Accept / refine loop
                while (true) {
                  tui.info(`\n[y]es to save plan, type feedback to refine, [a]bandon`);
                  const answer = await tui.prompt();

                  if (answer === null || answer.toLowerCase() === "a" || answer.toLowerCase() === "abandon") {
                    tui.info("Planning abandoned.");
                    exitPlanMode = true;
                    break;
                  }

                  if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes" || answer.toLowerCase() === "accept") {
                    const draft = parsePlanDraft(lastPlanText);
                    if (!draft) {
                      tui.error("Could not parse plan from agent response. Ask the agent to revise.");
                      continue;
                    }
                    const plans = loadPlans(config.cwd);
                    const newPlan: Plan = {
                      id: nextPlanId(plans),
                      name: draft.name,
                      description: draft.description,
                      approach: draft.approach,
                      createdAt: new Date().toISOString(),
                    };
                    savePlans(config.cwd, [...plans, newPlan]);
                    tui.success(`Plan #${newPlan.id} saved: ${newPlan.name}`);
                    tui.info(
                      isGoalsMode
                        ? `Use /plans split ${newPlan.id} to generate goals with acceptance criteria.`
                        : `Use /plans split ${newPlan.id} to generate implementation tasks.`
                    );
                    exitPlanMode = true;
                    break;
                  }

                  // Feedback — refine the plan
                  await agent.run(
                    `${answer}\n\n` +
                      `Please revise the plan based on this feedback. ` +
                      `Write your full updated plan as a markdown document with YAML frontmatter (name and description lines under opening \`---\`), ` +
                      `then closing \`---\`, then the plan body in markdown — same structure as before.`,
                  );
                  lastPlanText = agent.getLastAssistantText() ?? "";
                  hasDraft = !!parsePlanDraft(lastPlanText);
                  if (!hasDraft) break; // back to discussion
                }
              } else {
                // Still discussing — wait for the next user message
                tui.separator();
                const planInput = await tui.prompt();

                if (planInput === null) {
                  exitPlanMode = true;
                  break;
                }

                if (planInput.toLowerCase() === "/plan exit") {
                  tui.info("Exiting plan mode.");
                  exitPlanMode = true;
                  break;
                }

                await agent.run(planInput);
                lastPlanText = agent.getLastAssistantText() ?? "";
                hasDraft = !!parsePlanDraft(lastPlanText);
              }
            }
          } finally {
            agent.setLLM(createNavLLMClient(config));
            agent.clearHistory();
            tui.setPromptPrefix("");
          }
        }

        // /plans split — generate tasks for a plan
        if (result.planSplitMode) {
          const { planId } = result.planSplitMode;
          const plans = loadPlans(config.cwd);
          const plan = plans.find((p) => p.id === planId);
          if (!plan) {
            tui.error(`Plan #${planId} not found.`);
            tui.separator();
            continue;
          }

          const existingTasks = loadTasks(config.cwd);
          const existingPlanTasks = existingTasks.filter((t) => t.plan === planId);

          agent.clearHistory();
          agent.setSystemPrompt(buildNavSystemPrompt(config));
          agent.setLLM(
            createNavLLMClient(config, {
              allowedToolNames: planningToolAllowlist(config),
            }),
          );

          try {
            const isGoalsSplit = config.planMode === "goals";
            const splitPrompt = isGoalsSplit
              ? buildGoalsSplitPrompt(plan, existingPlanTasks)
              : buildSplitPrompt(plan, existingPlanTasks);
            await agent.run(splitPrompt);

            const responseText = agent.getLastAssistantText() ?? "";
            const parsedTasks = parsePlanTasks(responseText);

            if (!parsedTasks || parsedTasks.length === 0) {
              tui.error(`Could not parse ${isGoalsSplit ? "goals" : "tasks"} from agent response. Try /plans split again.`);
            } else {
              tui.info(`\n${isGoalsSplit ? "Goals" : "Tasks"} to create (${parsedTasks.length}):`);
              for (let i = 0; i < parsedTasks.length; i++) {
                const num = `${i + 1}. `;
                tui.print(
                  `${theme.text}${num}${theme.dim}${parsedTasks[i]!.name} — ${parsedTasks[i]!.description}${RESET}`,
                  num.length,
                );
              }
              tui.info(`\n[y]es to save ${isGoalsSplit ? "goals" : "tasks"}, [a]bandon`);
              const answer = await tui.prompt();
              if (answer !== null && (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes")) {
                const allTasks = loadTasks(config.cwd);
                const newTasks: Task[] = parsedTasks.map((draft) => {
                  const id = nextPlanTaskId(allTasks, planId);
                  const task = taskFromPlanDraft(draft, id, planId);
                  allTasks.push(task);
                  return task;
                });
                saveTasks(config.cwd, allTasks);
                const itemLabel = isGoalsSplit ? "goal" : "task";
                tui.success(`Created ${newTasks.length} ${itemLabel}${newTasks.length === 1 ? "" : "s"} for plan #${planId}:`);
                for (const t of newTasks) {
                  tui.info(`#${t.id.padEnd(6)} ${t.name}`);
                }
              } else {
                tui.info(isGoalsSplit ? "Goal creation abandoned." : "Task creation abandoned.");
              }
            }
          } finally {
            agent.setLLM(createNavLLMClient(config));
          }

          agent.clearHistory();
          agent.setSystemPrompt(buildNavSystemPrompt(config));
        }

        // /plans microsplit — generate micro-tasks optimized for small LLMs
        if (result.planMicrosplitMode) {
          const { planId } = result.planMicrosplitMode;
          const plans = loadPlans(config.cwd);
          const plan = plans.find((p) => p.id === planId);
          if (!plan) {
            tui.error(`Plan #${planId} not found.`);
            tui.separator();
            continue;
          }

          const existingTasks = loadTasks(config.cwd);
          const existingPlanTasks = existingTasks.filter((t) => t.plan === planId);

          agent.clearHistory();
          agent.setSystemPrompt(buildNavSystemPrompt(config));
          agent.setLLM(
            createNavLLMClient(config, {
              allowedToolNames: planningToolAllowlist(config),
            }),
          );

          try {
            await agent.run(buildMicrosplitPrompt(plan, existingPlanTasks));

            const responseText = agent.getLastAssistantText() ?? "";
            const parsedTasks = parsePlanTasks(responseText);

            if (!parsedTasks || parsedTasks.length === 0) {
              tui.error("Could not parse tasks from agent response. Try /plans microsplit again.");
            } else {
              tui.info(`\nMicro-tasks to create (${parsedTasks.length}):`);
              for (let i = 0; i < parsedTasks.length; i++) {
                const num = `${i + 1}. `;
                tui.print(
                  `${theme.text}${num}${theme.dim}${parsedTasks[i]!.name} — ${parsedTasks[i]!.description}${RESET}`,
                  num.length,
                );
              }
              tui.info(`\n[y]es to save tasks, [a]bandon`);
              const answer = await tui.prompt();
              if (answer !== null && (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes")) {
                const allTasks = loadTasks(config.cwd);
                const newTasks: Task[] = parsedTasks.map((draft) => {
                  const id = nextPlanTaskId(allTasks, planId);
                  const task = taskFromPlanDraft(draft, id, planId);
                  allTasks.push(task);
                  return task;
                });
                saveTasks(config.cwd, allTasks);
                tui.success(`Created ${newTasks.length} micro-task${newTasks.length === 1 ? "" : "s"} for plan #${planId}:`);
                for (const t of newTasks) {
                  tui.info(`#${t.id.padEnd(6)} ${t.name}`);
                }
              } else {
                tui.info("Task creation abandoned.");
              }
            }
          } finally {
            agent.setLLM(createNavLLMClient(config));
          }

          agent.clearHistory();
          agent.setSystemPrompt(buildNavSystemPrompt(config));
        }

        // /tasks run loop
        if (result.workTask !== undefined) {
          const autoMode = result.workTask === "next";

          if (!autoMode) {
            // Work a specific task by id
            const tasks = loadTasks(config.cwd);
            const task = tasks.find((t) => t.id === result.workTask);
            if (!task) {
              tui.error(`Task #${result.workTask} not found.`);
              tui.separator();
              continue;
            }
            if (task.status === "done") {
              tui.error(`Task #${task.id} is already done.`);
              tui.separator();
              continue;
            }

            await runTaskImplementationLoop(
              agent,
              config,
              task.id,
              (t) => {
                const plans = loadPlans(config.cwd);
                const taskPlan = t.plan !== undefined ? plans.find((p) => p.id === t.plan) : undefined;
                const allTasks = loadTasks(config.cwd);
                const siblingTasks = taskPlan ? allTasks.filter((x) => x.plan === taskPlan.id) : undefined;
                return { plan: taskPlan, siblingTasks };
              },
              customCommands,
              tui,
            );
          } else {
            // Auto mode: keep working tasks until none remain
            const completedTaskIds: string[] = [];

            while (true) {
              const tasks = loadTasks(config.cwd);
              const task = getWorkableTasks(tasks)[0];
              if (!task) {
                tui.info("All tasks complete. Nothing more to work on.");
                break;
              }

              const outcome = await runTaskImplementationLoop(
                agent,
                config,
                task.id,
                (t) => {
                  const plans = loadPlans(config.cwd);
                  const taskPlan = t.plan !== undefined ? plans.find((p) => p.id === t.plan) : undefined;
                  const allTasks = loadTasks(config.cwd);
                  const siblingTasks = taskPlan ? allTasks.filter((x) => x.plan === taskPlan.id) : undefined;
                  return { plan: taskPlan, siblingTasks };
                },
                customCommands,
                tui,
              );
              if (outcome === "aborted" || outcome === "attempts_exhausted") {
                break;
              }
              completedTaskIds.push(task.id);
              tui.separator();
            }

            // Goals mode: run verification for completed tasks
            if (config.planMode === "goals" && completedTaskIds.length > 0) {
              const allTasks = loadTasks(config.cwd);
              const completedTasks = allTasks.filter((t) => completedTaskIds.includes(t.id));

              // Group completed tasks by plan ID
              const byPlan = new Map<number | undefined, Task[]>();
              for (const t of completedTasks) {
                const key = t.plan;
                if (!byPlan.has(key)) byPlan.set(key, []);
                byPlan.get(key)!.push(t);
              }

              // For each plan, verify if ALL its tasks are now done
              for (const [planId, planCompletedTasks] of byPlan) {
                if (planId === undefined) {
                  // Standalone tasks: verify individually if they have criteria
                  await runVerificationPhase(agent, config, planCompletedTasks, tui);
                  await runFixLoop(agent, config, planCompletedTasks, tui);
                } else {
                  // Plan tasks: only verify if ALL tasks for this plan are done
                  const allPlanTasks = allTasks.filter((t) => t.plan === planId);
                  const allDone = allPlanTasks.every((t) => t.status === "done");
                  if (allDone) {
                    const plan = loadPlans(config.cwd).find((p) => p.id === planId);
                    if (plan) {
                      tui.info(`Plan #${plan.id} (${plan.name}) complete — running verification...`);
                    }
                    await runVerificationPhase(agent, config, allPlanTasks, tui);
                    await runFixLoop(agent, config, allPlanTasks, tui);
                  }
                }
              }
            }
          }
        }

        // /plans run loop — work through tasks for a specific plan
        if (result.workPlan !== undefined) {
          const planId = result.workPlan;
          const plans = loadPlans(config.cwd);
          const plan = plans.find((p) => p.id === planId);
          if (!plan) {
            tui.error(`Plan #${planId} not found.`);
            tui.separator();
            continue;
          }

          tui.info(`Working plan #${plan.id}: ${plan.name}`);
          tui.separator();

          while (true) {
            const tasks = loadTasks(config.cwd);
            const task = getWorkableTasksForPlan(tasks, planId)[0];
            if (!task) {
              const allPlanTasks = loadTasks(config.cwd).filter((t) => t.plan === planId);

              // Goals mode: run verification phase before planDone hooks
              if (config.planMode === "goals") {
                await runVerificationPhase(agent, config, allPlanTasks, tui);
                await runFixLoop(agent, config, allPlanTasks, tui);
              }

              const planResult = await finalizePlanAfterAllTasks(
                agent,
                config,
                plan,
                allPlanTasks.length,
                customCommands,
                tui,
              );
              if (planResult === "ok") {
                tui.info(
                  config.planMode === "goals"
                    ? `All goals for plan #${planId} complete.`
                    : `All tasks for plan #${planId} complete.`
                );
              }
              break;
            }

            const outcome = await runTaskImplementationLoop(
              agent,
              config,
              task.id,
              (_t) => {
                const allTasks = loadTasks(config.cwd);
                const siblingTasks = allTasks.filter((x) => x.plan === plan.id);
                return { plan, siblingTasks };
              },
              customCommands,
              tui,
            );
            if (outcome === "aborted" || outcome === "attempts_exhausted") {
              break;
            }
            tui.separator();
          }
        }

        tui.separator();
        continue;
      }
    }

    const expandedInput = await expandAtMentions(input, config.cwd, config.editMode);
    await agent.run(expandedInput);

    // Reload skills if any SKILL.md files changed during the run
    if (skillWatcher.needsReload) {
      skills = loadSkills(config.cwd);
      const newSystemPrompt = buildNavSystemPrompt(config);
      agent.setSystemPrompt(newSystemPrompt);
      skillWatcher.clearReloadFlag();
      tui.info("skills reloaded");
    }

    tui.separator();
  }

  tui.close();
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
