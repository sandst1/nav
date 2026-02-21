#!/usr/bin/env bun
/**
 * nav — minimalist coding agent entry point.
 *
 * Interactive mode:  nav
 * One-shot mode:     nav "fix the bug in main.ts"
 */

import { parseArgs, resolveConfig, loadConfigFiles, HELP_TEXT, type ConfigFileValues } from "./config";
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
import { loadTasks, saveTasks, getWorkableTasks, getWorkableTasksForPlan, type Task } from "./tasks";
import { loadPlans, savePlans, nextPlanId, nextStandaloneId, nextPlanTaskId, type Plan } from "./plans";

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
  // Try to find a JSON code block first
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStr = codeBlock ? codeBlock[1]! : text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
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
function buildWorkPrompt(task: Task, plan?: Plan, planTasks?: Task[]): string {
  let prompt = `You are working on the following task:\n\n` +
    `Task #${task.id}: ${task.name}\n${task.description}\n`;

  if (task.relatedFiles?.length) {
    prompt += `\nRelated files:\n${task.relatedFiles.map((f) => `- ${f}`).join("\n")}\n`;
  }
  if (task.acceptanceCriteria?.length) {
    prompt += `\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n`;
  }

  if (plan) {
    prompt +=
      `\n---\nPlan context (Plan #${plan.id}: ${plan.name})\n` +
      `${plan.description}\n\n` +
      `Approach: ${plan.approach}\n`;
  }

  if (planTasks && planTasks.length > 0) {
    prompt += `\nAll tasks in this plan:\n`;
    for (const t of planTasks) {
      const marker = t.id === task.id ? "→" : " ";
      const statusLabel = t.status === "in_progress" ? "in progress" : t.status === "done" ? "done" : "planned";
      prompt += `  ${marker} #${t.id}: [${statusLabel}] ${t.name}\n`;
    }
  }

  prompt +=
    `\nComplete this task` +
    (task.acceptanceCriteria?.length ? `, ensuring all acceptance criteria are met` : ``) +
    `. When you are done, say "Task #${task.id} complete." so the system can mark it as done.`;
  return prompt;
}

/** Parse a JSON task array from the agent's plan response. */
function parsePlanTasks(text: string): Array<{ name: string; description: string }> | null {
  // Look for a JSON array in a code block first, then inline
  const codeBlock = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const jsonStr = codeBlock ? codeBlock[1]! : text.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonStr) return null;
  try {
    const arr = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(arr)) return null;
    const tasks: Array<{ name: string; description: string }> = [];
    for (const item of arr) {
      if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).description === "string"
      ) {
        tasks.push({
          name: (item as Record<string, unknown>).name as string,
          description: (item as Record<string, unknown>).description as string,
        });
      }
    }
    return tasks.length > 0 ? tasks : null;
  } catch {
    // fall through
  }
  return null;
}

/** Parse a plan object from agent response (name, description, approach). */
function parsePlanDraft(text: string): { name: string; description: string; approach: string } | null {
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStr = codeBlock ? codeBlock[1]! : text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    if (
      typeof obj.name === "string" &&
      typeof obj.description === "string" &&
      typeof obj.approach === "string"
    ) {
      return { name: obj.name, description: obj.description, approach: obj.approach };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Show a numbered task list parsed from the plan text, replacing the raw JSON block. */
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

  // Sandbox: re-exec under sandbox-exec if requested and not already inside
  const wantSandbox =
    flags.sandbox ??
    (process.env.NAV_SANDBOX === "1" || process.env.NAV_SANDBOX === "true");

  if (wantSandbox && !isAlreadySandboxed()) {
    if (!isSandboxAvailable()) {
      console.error("sandbox: sandbox-exec not found (macOS only)");
      process.exit(1);
    }
    execSandbox(); // re-execs, never returns
  }

  // Load config files once; apply theme before anything renders
  const fileConfig = loadConfigFiles(process.cwd());
  const fileTheme = process.env.NAV_THEME ?? fileConfig.theme;
  if (fileTheme) setTheme(fileTheme);

  const config = resolveConfig(flags, fileConfig);
  const logger = new Logger(config.cwd, config.verbose);
  const tui = new TUI();
  const llm = createLLMClient(config);
  const systemPrompt = buildSystemPrompt(config.cwd);
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

  const agent = new Agent({
    llm,
    systemPrompt,
    cwd: config.cwd,
    logger,
    tui,
    processManager,
    contextWindow: config.contextWindow,
    handoverThreshold: config.handoverThreshold,
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

  // One-shot mode
  if (flags.prompt) {
    // Check if the prompt is a slash command
    if (flags.prompt.startsWith("/")) {
      const result = handleCommand(flags.prompt, { tui, config, agent, createLLMClient, customCommands, skills });
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
          const newSystemPrompt = buildSystemPrompt(config.cwd);
          agent.setSystemPrompt(newSystemPrompt);
          skills = loadSkills(config.cwd);
        }
      }
      cleanup();
      process.exit(0);
    }
    
    await agent.run(flags.prompt);
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
      const result = handleCommand(input, { tui, config, agent, createLLMClient, customCommands, skills });
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
          const newSystemPrompt = buildSystemPrompt(config.cwd);
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
          tui.setPromptPrefix("[plan]");
          tui.separator();
          tui.info(`Plan mode — discuss the idea, then confirm to save the plan. Type /plan exit to leave.`);
          tui.separator();

          const planModePrompt =
            `You are in plan mode. Your job is to help the user think through and design an idea before any code is written.\n\n` +
            `How to behave:\n` +
            `1. Discuss the idea conversationally. Ask clarifying questions ONE AT A TIME — do not dump a list.\n` +
            `   Explore the codebase as needed to understand the context.\n` +
            `2. Once you and the user have enough clarity, produce a formal plan. Write it in plain prose:\n` +
            `   - What will be built/changed and why\n` +
            `   - High-level approach (key design decisions, how it fits into the existing architecture)\n` +
            `3. End the plan with a fenced JSON block containing ONLY the plan summary (no tasks yet — tasks come from /plans split):\n\n` +
            "```json\n" +
            `{"name": "short plan name", "description": "one-sentence summary", "approach": "high-level implementation strategy"}\n` +
            "```\n\n" +
            `4. Do not implement anything. Do not create tasks. Only plan.\n\n` +
            (userText
              ? `The user's idea: "${userText}"`
              : `The user has entered plan mode. Ask them what they'd like to plan.`);

          await agent.run(planModePrompt);

          let lastPlanText = agent.getLastAssistantText() ?? "";
          let hasDraft = !!parsePlanDraft(lastPlanText);
          let exitPlanMode = false;

          while (!exitPlanMode) {
            if (hasDraft) {
              const draft = parsePlanDraft(lastPlanText);

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
                  tui.info(`Use /plans split ${newPlan.id} to generate implementation tasks.`);
                  exitPlanMode = true;
                  break;
                }

                // Feedback — refine the plan
                await agent.run(
                  `${answer}\n\n` +
                  `Please revise the plan based on this feedback. ` +
                  `End your response with the updated plan JSON in a fenced \`\`\`json block:\n` +
                  `{"name": "...", "description": "...", "approach": "..."}`,
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

          agent.clearHistory();
          tui.setPromptPrefix("");
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
          agent.setSystemPrompt(buildSystemPrompt(config.cwd));

          const splitPrompt =
            `You are generating implementation tasks for the following plan.\n\n` +
            `Plan #${plan.id}: ${plan.name}\n` +
            `Description: ${plan.description}\n` +
            `Approach: ${plan.approach}\n\n` +
            (existingPlanTasks.length > 0
              ? `Existing tasks for this plan (do not duplicate):\n` +
                existingPlanTasks.map((t) => `  - #${t.id}: ${t.name}`).join("\n") + "\n\n"
              : "") +
            `Create a complete ordered list of tasks to implement this plan. Include:\n` +
            `- Implementation tasks (one concern per task, specific and actionable)\n` +
            `- Test-writing tasks (writing automated tests for the changed code — unit tests, integration tests, etc.)\n\n` +
            `Explore the codebase as needed to understand what files will be affected.\n\n` +
            `End your response with ONLY a fenced JSON array of tasks:\n\n` +
            "```json\n" +
            `[\n` +
            `  {"name": "short task name", "description": "what needs to be done", "relatedFiles": ["src/foo.ts"]},\n` +
            `  ...\n` +
            `]\n` +
            "```\n\n" +
            `relatedFiles is optional. Do not include any other JSON outside the code block.`;

          await agent.run(splitPrompt);

          const responseText = agent.getLastAssistantText() ?? "";
          const parsedTasks = parsePlanTasks(responseText);

          if (!parsedTasks || parsedTasks.length === 0) {
            tui.error("Could not parse tasks from agent response. Try /plans split again.");
          } else {
            tui.info(`\nTasks to create (${parsedTasks.length}):`);
            for (let i = 0; i < parsedTasks.length; i++) {
              tui.info(`${i + 1}. ${parsedTasks[i]!.name} — ${parsedTasks[i]!.description}`);
            }
            tui.info(`\n[y]es to save tasks, [a]bandon`);
            const answer = await tui.prompt();
            if (answer !== null && (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes")) {
              const allTasks = loadTasks(config.cwd);
              const newTasks: Task[] = parsedTasks.map((t) => {
                const taskWithFiles = t as { name: string; description: string; relatedFiles?: string[] };
                const id = nextPlanTaskId(allTasks, planId);
                const task: Task = {
                  id,
                  name: taskWithFiles.name,
                  description: taskWithFiles.description,
                  status: "planned",
                  plan: planId,
                  ...(taskWithFiles.relatedFiles?.length ? { relatedFiles: taskWithFiles.relatedFiles } : {}),
                };
                allTasks.push(task);
                return task;
              });
              saveTasks(config.cwd, allTasks);
              tui.success(`Created ${newTasks.length} task${newTasks.length === 1 ? "" : "s"} for plan #${planId}:`);
              for (const t of newTasks) {
                tui.info(`#${t.id.padEnd(6)} ${t.name}`);
              }
            } else {
              tui.info("Task creation abandoned.");
            }
          }

          agent.clearHistory();
          agent.setSystemPrompt(buildSystemPrompt(config.cwd));
        }

        // /tasks work loop
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

            tui.info(`Working on task #${task.id}: ${task.name}`);
            task.status = "in_progress";
            saveTasks(config.cwd, tasks);

            agent.clearHistory();
            agent.setSystemPrompt(buildSystemPrompt(config.cwd));

            const plans = loadPlans(config.cwd);
            const taskPlan = task.plan !== undefined ? plans.find((p) => p.id === task.plan) : undefined;
            const allTasks = loadTasks(config.cwd);
            const siblingTasks = taskPlan ? allTasks.filter((t) => t.plan === taskPlan.id) : undefined;
            await agent.run(buildWorkPrompt(task, taskPlan, siblingTasks));

            const updatedTasks = loadTasks(config.cwd);
            const doneTask = updatedTasks.find((t) => t.id === task.id);
            if (doneTask && doneTask.status !== "done") {
              doneTask.status = "done";
              saveTasks(config.cwd, updatedTasks);
              tui.success(`Task #${task.id} marked as done.`);
            }
          } else {
            // Auto mode: keep working tasks until none remain
            while (true) {
              const tasks = loadTasks(config.cwd);
              const task = getWorkableTasks(tasks)[0];
              if (!task) {
                tui.info("All tasks complete. Nothing more to work on.");
                break;
              }

              tui.info(`Working on task #${task.id}: ${task.name}`);
              task.status = "in_progress";
              saveTasks(config.cwd, tasks);

              agent.clearHistory();
              agent.setSystemPrompt(buildSystemPrompt(config.cwd));

              const plans = loadPlans(config.cwd);
              const taskPlan = task.plan !== undefined ? plans.find((p) => p.id === task.plan) : undefined;
              const allTasks = loadTasks(config.cwd);
              const siblingTasks = taskPlan ? allTasks.filter((t) => t.plan === taskPlan.id) : undefined;
              await agent.run(buildWorkPrompt(task, taskPlan, siblingTasks));

              const wasAborted = tui.isAborted();

              const updatedTasks = loadTasks(config.cwd);
              const doneTask = updatedTasks.find((t) => t.id === task.id);
              if (!wasAborted && doneTask && doneTask.status !== "done") {
                doneTask.status = "done";
                saveTasks(config.cwd, updatedTasks);
                tui.success(`Task #${task.id} marked as done.`);
              } else if (wasAborted) {
                tui.info(`Task #${task.id} interrupted — left as in_progress.`);
                break;
              }
              tui.separator();
            }
          }
        }

        // /plans work loop — work through tasks for a specific plan
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
              tui.info(`All tasks for plan #${planId} complete.`);
              break;
            }

            tui.info(`Working on task #${task.id}: ${task.name}`);
            task.status = "in_progress";
            saveTasks(config.cwd, tasks);

            agent.clearHistory();
            agent.setSystemPrompt(buildSystemPrompt(config.cwd));

            const allTasks = loadTasks(config.cwd);
            const siblingTasks = allTasks.filter((t) => t.plan === planId);
            await agent.run(buildWorkPrompt(task, plan, siblingTasks));

            const wasAborted = tui.isAborted();

            const updatedTasks = loadTasks(config.cwd);
            const doneTask = updatedTasks.find((t) => t.id === task.id);
            if (!wasAborted && doneTask && doneTask.status !== "done") {
              doneTask.status = "done";
              saveTasks(config.cwd, updatedTasks);
              tui.success(`Task #${task.id} marked as done.`);
            } else if (wasAborted) {
              tui.info(`Task #${task.id} interrupted — left as in_progress.`);
              break;
            }
            tui.separator();
          }
        }

        tui.separator();
        continue;
      }
    }

    await agent.run(input);

    // Reload skills if any SKILL.md files changed during the run
    if (skillWatcher.needsReload) {
      skills = loadSkills(config.cwd);
      const newSystemPrompt = buildSystemPrompt(config.cwd);
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
