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
import { loadTasks, saveTasks, nextId, getWorkableTasks } from "./tasks";

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
  // JSON doesn't support comments, so key names are kept self-explanatory.
  const content = `{
  "_docs": "https://github.com/sandst1/nav — all fields are optional",

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
function parseTaskDraft(text: string): { name: string; description: string } | null {
  // Try to find a JSON code block first
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStr = codeBlock ? codeBlock[1]! : text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    if (typeof obj.name === "string" && typeof obj.description === "string") {
      return { name: obj.name, description: obj.description };
    }
  } catch {
    // fall through
  }
  return null;
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

/** Show a numbered task list parsed from the plan text, replacing the raw JSON block. */
function showPlanTaskPreview(tui: TUI, planText: string): void {
  const tasks = parsePlanTasks(planText);
  if (!tasks || tasks.length === 0) return;
  tui.info(`\nTasks (${tasks.length}):`);
  for (let i = 0; i < tasks.length; i++) {
    tui.info(`  ${i + 1}. ${tasks[i]!.name} — ${tasks[i]!.description}`);
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
            `Based on this, create a concise task with a short name and a clear description. ` +
            `Respond with ONLY a JSON object in this exact format (no other text):\n` +
            `{"name": "short task name", "description": "clear description of what needs to be done"}`;

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
            tui.info(`  Name:        ${draft.name}`);
            tui.info(`  Description: ${draft.description}`);
            tui.info(`\n[y]es to save, [n]o to give more instructions, [a]bandon`);

            const answer = await tui.prompt();
            if (answer === null || answer.toLowerCase() === "a" || answer.toLowerCase() === "abandon") {
              tui.info("Task creation abandoned.");
              break;
            }
            if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
              const tasks = loadTasks(config.cwd);
              const newTask = {
                id: nextId(tasks),
                name: draft.name,
                description: draft.description,
                status: "planned" as const,
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
                `Previous draft was:\n{"name": "${draft.name}", "description": "${draft.description}"}\n\n` +
                `User feedback / additional instructions: "${moreInstructions}"\n\n` +
                `Revise the task and respond with ONLY a JSON object:\n` +
                `{"name": "short task name", "description": "clear description"}`;
            }
          }
          agent.clearHistory();
        }

        // /plan loop
        if (result.planMode) {
          const { userText } = result.planMode;

          const initialPlanPrompt =
            `The user wants to plan the following:\n\n"${userText}"\n\n` +
            `Your job is to help create a solid plan before any code is written.\n\n` +
            `Steps:\n` +
            `1. Explore the codebase as needed to understand the relevant context.\n` +
            `2. If you need clarification, use the ask_user tool with a list of questions — ` +
            `they will be asked to the user one by one and you will receive all answers before continuing.\n` +
            `3. Once you have enough context, write a clear markdown plan describing:\n` +
            `   - What will be built/changed and why\n` +
            `   - Key design decisions and affected files\n` +
            `   - Step-by-step implementation approach\n` +
            `4. End your response with a fenced JSON block containing the ordered list of tasks ` +
            `to implement this plan (each with a short "name" and a clear "description"):\n\n` +
            "```json\n" +
            `[\n` +
            `  {"name": "short task name", "description": "what needs to be done"},\n` +
            `  ...\n` +
            `]\n` +
            "```\n\n" +
            `Do not implement anything yet — just plan.`;

          // Install interactive question handler for plan mode
          agent.setAskUserHandler(async (questions: string[]) => {
            const answers: Record<string, string> = {};
            tui.info("");
            for (const q of questions) {
              tui.info(`  ${q}`);
              const ans = await tui.prompt();
              answers[q] = ans ?? "";
              tui.info("");
            }
            return answers;
          });

          agent.clearHistory();
          let planAccepted = false;
          let lastPlanText: string | null = null;

          tui.enableStreamJsonFilter();
          await agent.run(initialPlanPrompt);
          tui.disableStreamJsonFilter();
          lastPlanText = agent.getLastAssistantText();
          showPlanTaskPreview(tui, lastPlanText ?? "");

          while (!planAccepted) {
            tui.info(`\n[y]es to accept plan and create tasks, or type feedback to refine`);
            const answer = await tui.prompt();

            if (answer === null || answer.toLowerCase() === "a" || answer.toLowerCase() === "abandon") {
              tui.info("Planning abandoned.");
              break;
            }

            if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes" || answer.toLowerCase() === "accept") {
              // Parse tasks from the last plan response
              const planText = lastPlanText ?? "";
              const planTasks = parsePlanTasks(planText);

              if (!planTasks) {
                tui.error("Could not parse tasks from the plan. Ask the agent to include a JSON task list.");
                tui.info(`\n[y]es to accept plan and create tasks, or type feedback to refine`);
                continue;
              }

              // Save all tasks without per-task confirmation — user approved the full plan
              const existingTasks = loadTasks(config.cwd);
              let taskId = nextId(existingTasks);
              const newTasks = planTasks.map((t) => ({
                id: taskId++,
                name: t.name,
                description: t.description,
                status: "planned" as const,
              }));

              saveTasks(config.cwd, [...existingTasks, ...newTasks]);
              tui.success(`Created ${newTasks.length} task${newTasks.length === 1 ? "" : "s"}:`);
              for (const t of newTasks) {
                tui.info(`  #${String(t.id).padEnd(3)} ${t.name}`);
              }
              planAccepted = true;
            } else {
              // User gave feedback — continue conversation so agent retains codebase knowledge
              tui.enableStreamJsonFilter();
              await agent.run(
                `${answer}\n\n` +
                `Please revise the plan based on this feedback. ` +
                `End your response with the updated JSON task list in a fenced \`\`\`json block.`,
              );
              tui.disableStreamJsonFilter();
              lastPlanText = agent.getLastAssistantText();
              showPlanTaskPreview(tui, lastPlanText ?? "");
            }
          }

          agent.setAskUserHandler(undefined);
          agent.clearHistory();
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

            await agent.run(
              `You are working on the following task:\n\n` +
              `Task #${task.id}: ${task.name}\n${task.description}\n\n` +
              `Complete this task. When you are done, say "Task #${task.id} complete." ` +
              `so the system can mark it as done.`,
            );

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

              await agent.run(
                `You are working on the following task:\n\n` +
                `Task #${task.id}: ${task.name}\n${task.description}\n\n` +
                `Complete this task. When you are done, say "Task #${task.id} complete." ` +
                `so the system can mark it as done.`,
              );

              const updatedTasks = loadTasks(config.cwd);
              const doneTask = updatedTasks.find((t) => t.id === task.id);
              if (doneTask && doneTask.status !== "done") {
                doneTask.status = "done";
                saveTasks(config.cwd, updatedTasks);
              }
              tui.success(`Task #${task.id} marked as done.`);
              tui.separator();
            }
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
