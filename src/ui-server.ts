import { Agent } from "./agent";
import { buildSystemPrompt } from "./prompt";
import { ProcessManager } from "./process-manager";
import { createLLMClient } from "./llm";
import { loadCustomCommands } from "./custom-commands";
import { loadSkills, type Skill } from "./skills";
import { SkillWatcher } from "./skill-watcher";
import { handleCommand, type CommandIO } from "./commands";
import { expandAtMentions } from "./at-mention";
import type { Config } from "./config";
import { runStopHooks, type HookRunCompleteMeta } from "./hooks";
import type { Logger } from "./logger";
import { UI_PROTOCOL_VERSION, type UiClientMessage, type UiServerMessage } from "./ui-protocol";
import { WsAgentIO } from "./ws-agent-io";
import { loadTasks, saveTasks, type Task } from "./tasks";
import {
  loadPlans,
  savePlans,
  nextPlanId,
  nextStandaloneId,
  nextPlanTaskId,
  type Plan,
} from "./plans";

interface UiServerOptions {
  config: Config;
  logger: Logger;
  host: string;
  port: number;
}

class WsCommandIO implements CommandIO {
  constructor(private readonly emit: (msg: UiServerMessage) => void) {}

  info(msg: string): void {
    this.emit({ type: "status", payload: { phase: "info", message: msg } });
  }

  success(msg: string): void {
    this.emit({ type: "status", payload: { phase: "success", message: msg } });
  }

  error(msg: string): void {
    this.emit({ type: "error", payload: { message: msg } });
  }

  print(line: string): void {
    this.emit({ type: "status", payload: { phase: "print", message: line } });
  }
}

export async function runUiServer(opts: UiServerOptions): Promise<void> {
  const { config, logger, host, port } = opts;

  const processManager = new ProcessManager();
  let llm = createLLMClient(config);
  let systemPrompt = buildSystemPrompt(config.cwd);
  const wsIo = new WsAgentIO(() => {
    // no-op until a socket is connected
  });

  const agent = new Agent({
    llm,
    systemPrompt,
    cwd: config.cwd,
    logger,
    io: wsIo,
    processManager,
    contextWindow: config.contextWindow,
    handoverThreshold: config.handoverThreshold,
    onRunComplete: async (meta: HookRunCompleteMeta) => {
      if (meta.aborted) return;
      await runStopHooks(config.cwd, config.hookTimeoutMs, config.hooks, (msg) => {
        sendToActive({
          type: "status",
          payload: { phase: "info", message: `hook: ${msg}` },
        });
      });
    },
  });

  let customCommands = loadCustomCommands(config.cwd);
  let skills: Map<string, Skill> = loadSkills(config.cwd);
  const skillWatcher = new SkillWatcher();
  skillWatcher.start(config.cwd);

  let activeSocket: Bun.ServerWebSocket<unknown> | null = null;
  let runQueue: Promise<void> = Promise.resolve();
  let pendingUserInputResolve: ((value: string | null) => void) | null = null;

  const sendToActive = (msg: UiServerMessage) => {
    if (!activeSocket) return;
    activeSocket.send(JSON.stringify(msg));
  };

  // Late-bind emitter so we can keep one Agent instance.
  wsIo.setEmitter(sendToActive);

  const commandIo = new WsCommandIO(sendToActive);

  const cleanup = () => {
    processManager.killAll();
    skillWatcher.stop();
  };

  const promptUser = async (prompt: string): Promise<string | null> => {
    sendToActive({ type: "status", payload: { phase: "prompt", message: prompt } });
    return new Promise((resolve) => {
      pendingUserInputResolve = resolve;
    });
  };

  const runTaskAddMode = async (userText: string): Promise<void> => {
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
        sendToActive({
          type: "error",
          payload: { message: "Could not parse task from agent response. Try /tasks add again." },
        });
        break;
      }

      sendToActive({ type: "status", payload: { phase: "info", message: "Task preview:" } });
      sendToActive({
        type: "status",
        payload: { phase: "info", message: `Name: ${draft.name}\nDescription: ${draft.description}` },
      });
      if (draft.relatedFiles?.length) {
        sendToActive({
          type: "status",
          payload: { phase: "info", message: `Files: ${draft.relatedFiles.join(", ")}` },
        });
      }
      if (draft.acceptanceCriteria?.length) {
        sendToActive({
          type: "status",
          payload: {
            phase: "info",
            message: `Acceptance:\n${draft.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
          },
        });
      }

      const answer = await promptUser("[y]es to save, [n]o to revise, [a]bandon");
      if (answer === null) break;
      const normalized = answer.trim().toLowerCase();
      if (normalized === "a" || normalized === "abandon") {
        sendToActive({ type: "status", payload: { phase: "info", message: "Task creation abandoned." } });
        break;
      }
      if (normalized === "y" || normalized === "yes") {
        const tasks = loadTasks(config.cwd);
        const newTask: Task = {
          id: nextStandaloneId(tasks),
          name: draft.name,
          description: draft.description,
          status: "planned",
          ...(draft.relatedFiles?.length ? { relatedFiles: draft.relatedFiles } : {}),
          ...(draft.acceptanceCriteria?.length
            ? { acceptanceCriteria: draft.acceptanceCriteria }
            : {}),
        };
        tasks.push(newTask);
        saveTasks(config.cwd, tasks);
        sendToActive({
          type: "status",
          payload: { phase: "success", message: `Task #${newTask.id} added: ${newTask.name}` },
        });
        confirmed = true;
      } else {
        const feedback = answer.replace(/^n\s*/i, "").trim();
        const moreInstructions = feedback || (await promptUser("Provide more instructions:")) || "";
        draftPrompt =
          `The user wants to add a task. Original description: "${userText}"\n\n` +
          `Previous draft was:\n${JSON.stringify(
            {
              name: draft.name,
              description: draft.description,
              relatedFiles: draft.relatedFiles ?? [],
              acceptanceCriteria: draft.acceptanceCriteria ?? [],
            },
            null,
            2,
          )}\n\n` +
          `User feedback / additional instructions: "${moreInstructions}"\n\n` +
          `Revise the task and respond with ONLY a JSON object:\n` +
          `{"name": "short task name", "description": "clear description", "relatedFiles": [...], "acceptanceCriteria": [...]}`;
      }
    }
    agent.clearHistory();
  };

  const runPlanMode = async (userText: string): Promise<void> => {
    agent.clearHistory();
    sendToActive({
      type: "status",
      payload: {
        phase: "info",
        message:
          "Plan mode started. Discuss the idea, then confirm to save. Use /plan exit to leave plan mode.",
      },
    });

    const planModePrompt =
      `You are in plan mode. Your job is to help the user think through and design an idea before any code is written.\n\n` +
      `How to behave:\n` +
      `1. Discuss the idea conversationally. Ask clarifying questions ONE AT A TIME — do not dump a list.\n` +
      `2. Once there is enough clarity, produce a formal plan in prose.\n` +
      `3. End with a fenced JSON block only:\n` +
      "```json\n" +
      `{"name": "short plan name", "description": "one-sentence summary", "approach": "high-level implementation strategy"}\n` +
      "```\n\n" +
      `4. Do not implement anything. Do not create tasks. Only plan.\n\n` +
      (userText
        ? `The user's idea: "${userText}"`
        : `The user has entered plan mode. Ask what they'd like to plan.`);

    await agent.run(planModePrompt);
    let lastPlanText = agent.getLastAssistantText() ?? "";
    let hasDraft = !!parsePlanDraft(lastPlanText);
    let exitPlanMode = false;

    while (!exitPlanMode) {
      if (hasDraft) {
        const draft = parsePlanDraft(lastPlanText);
        const answer = await promptUser("[y]es to save plan, send feedback to refine, [a]bandon");
        if (answer === null) break;
        const normalized = answer.toLowerCase();

        if (normalized === "a" || normalized === "abandon") {
          sendToActive({ type: "status", payload: { phase: "info", message: "Planning abandoned." } });
          exitPlanMode = true;
          break;
        }

        if (normalized === "y" || normalized === "yes" || normalized === "accept") {
          if (!draft) {
            sendToActive({
              type: "error",
              payload: { message: "Could not parse plan from model response. Send feedback to revise." },
            });
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
          sendToActive({
            type: "status",
            payload: { phase: "success", message: `Plan #${newPlan.id} saved: ${newPlan.name}` },
          });
          sendToActive({
            type: "status",
            payload: {
              phase: "info",
              message: `Use /plans split ${newPlan.id} to generate implementation tasks.`,
            },
          });
          exitPlanMode = true;
          break;
        }

        await agent.run(
          `${answer}\n\n` +
            `Please revise the plan based on this feedback. End with fenced JSON:\n` +
            `{"name": "...", "description": "...", "approach": "..."}`,
        );
        lastPlanText = agent.getLastAssistantText() ?? "";
        hasDraft = !!parsePlanDraft(lastPlanText);
      } else {
        const planInput = await promptUser("Plan mode: continue discussion or send /plan exit");
        if (planInput === null) break;
        if (planInput.toLowerCase() === "/plan exit") {
          sendToActive({ type: "status", payload: { phase: "info", message: "Exiting plan mode." } });
          exitPlanMode = true;
          break;
        }
        await agent.run(planInput);
        lastPlanText = agent.getLastAssistantText() ?? "";
        hasDraft = !!parsePlanDraft(lastPlanText);
      }
    }

    agent.clearHistory();
  };

  const runPlanSplitMode = async (planId: number, micro = false): Promise<void> => {
    const plans = loadPlans(config.cwd);
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
      sendToActive({ type: "error", payload: { message: `Plan #${planId} not found.` } });
      return;
    }
    const existingTasks = loadTasks(config.cwd).filter((t) => t.plan === planId);

    agent.clearHistory();
    agent.setSystemPrompt(buildSystemPrompt(config.cwd));

    const prompt = micro
      ? buildMicrosplitPrompt(plan, existingTasks)
      : buildSplitPrompt(plan, existingTasks);

    await agent.run(prompt);
    const responseText = agent.getLastAssistantText() ?? "";
    const parsedTasks = parsePlanTasks(responseText);
    if (!parsedTasks || parsedTasks.length === 0) {
      sendToActive({
        type: "error",
        payload: { message: `Could not parse tasks from agent response. Try /plans ${micro ? "microsplit" : "split"} again.` },
      });
      return;
    }

    sendToActive({
      type: "status",
      payload: {
        phase: "info",
        message: `Tasks to create (${parsedTasks.length}):\n${parsedTasks
          .map((t, i) => `${i + 1}. ${t.name} — ${t.description}`)
          .join("\n")}`,
      },
    });

    const answer = await promptUser("[y]es to save tasks, [a]bandon");
    if (!answer || !["y", "yes"].includes(answer.toLowerCase())) {
      sendToActive({ type: "status", payload: { phase: "info", message: "Task creation abandoned." } });
      return;
    }

    const allTasks = loadTasks(config.cwd);
    const created: Task[] = parsedTasks.map((t) => {
      const withFiles = t as { name: string; description: string; relatedFiles?: string[] };
      const id = nextPlanTaskId(allTasks, planId);
      const task: Task = {
        id,
        name: withFiles.name,
        description: withFiles.description,
        status: "planned",
        plan: planId,
        ...(withFiles.relatedFiles?.length ? { relatedFiles: withFiles.relatedFiles } : {}),
      };
      allTasks.push(task);
      return task;
    });
    saveTasks(config.cwd, allTasks);
    sendToActive({
      type: "status",
      payload: {
        phase: "success",
        message: `Created ${created.length} task${created.length === 1 ? "" : "s"} for plan #${planId}.`,
      },
    });
  };

  const runInput = async (text: string): Promise<void> => {
    if (text.startsWith("/")) {
      const result = handleCommand(text, {
        tui: commandIo,
        config,
        agent,
        createLLMClient,
        customCommands,
        skills,
      });

      if (!result.handled) return;

      if (result.taskAddMode) {
        await runTaskAddMode(result.taskAddMode.userText);
        return;
      }
      if (result.planDiscussionMode) {
        await runPlanMode(result.planDiscussionMode.userText);
        return;
      }
      if (result.planSplitMode) {
        await runPlanSplitMode(result.planSplitMode.planId, false);
        return;
      }
      if (result.planMicrosplitMode) {
        await runPlanSplitMode(result.planMicrosplitMode.planId, true);
        return;
      }
      if (result.workTask !== undefined || result.workPlan !== undefined) {
        sendToActive({
          type: "error",
          payload: { message: "Task-run loops are currently terminal-only; use /tasks run or /plans run in terminal." },
        });
        return;
      }

      if (result.newLLMClient) {
        llm = result.newLLMClient;
        agent.setLLM(llm);
      }
      if (result.handoverArgs !== undefined) {
        await agent.handover(result.handoverArgs || undefined);
      }
      if (result.runPrompt !== undefined) {
        await agent.run(result.runPrompt);
      }
      if (result.reloadSystemPrompt) {
        systemPrompt = buildSystemPrompt(config.cwd);
        agent.setSystemPrompt(systemPrompt);
        customCommands = loadCustomCommands(config.cwd);
        skills = loadSkills(config.cwd);
      }

      return;
    }

    const expanded = await expandAtMentions(text, config.cwd);
    await agent.run(expanded);

    if (skillWatcher.needsReload) {
      skills = loadSkills(config.cwd);
      customCommands = loadCustomCommands(config.cwd);
      systemPrompt = buildSystemPrompt(config.cwd);
      agent.setSystemPrompt(systemPrompt);
      skillWatcher.clearReloadFlag();
      sendToActive({
        type: "status",
        payload: { phase: "info", message: "skills reloaded" },
      });
    }
  };

  const enqueue = (task: () => Promise<void>) => {
    runQueue = runQueue.then(task).catch((err: unknown) => {
      sendToActive({
        type: "error",
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    });
  };

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req, serverRef) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            protocolVersion: UI_PROTOCOL_VERSION,
            cwd: config.cwd,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname === "/ws" && serverRef.upgrade(req)) {
        return;
      }

      return new Response("nav ui-server", { status: 200 });
    },
    websocket: {
      open(ws) {
        if (activeSocket && activeSocket !== ws) {
          ws.send(
            JSON.stringify({
              type: "error",
              payload: { message: "Another client is already connected." },
            } satisfies UiServerMessage),
          );
          ws.close(1013, "session in use");
          return;
        }

        activeSocket = ws;
        sendToActive({
          type: "session.ready",
          payload: {
            protocolVersion: UI_PROTOCOL_VERSION,
            model: config.model,
            provider: config.provider,
            cwd: config.cwd,
            sandbox: config.sandbox,
          },
        });
      },
      message(ws, raw) {
        let msg: UiClientMessage;
        try {
          const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
          msg = JSON.parse(text) as UiClientMessage;
        } catch {
          sendToActive({ type: "error", payload: { message: "Invalid JSON message." } });
          return;
        }

        switch (msg.type) {
          case "session.start":
            sendToActive({
              type: "session.ready",
              payload: {
                protocolVersion: UI_PROTOCOL_VERSION,
                model: config.model,
                provider: config.provider,
                cwd: config.cwd,
                sandbox: config.sandbox,
              },
            });
            break;

          case "message.user": {
            const text = msg.payload.text?.trim();
            if (!text) return;
            if (pendingUserInputResolve) {
              const resolve = pendingUserInputResolve;
              pendingUserInputResolve = null;
              resolve(text);
              return;
            }
            if (wsIo.isRunning()) {
              wsIo.enqueueInput(text);
              sendToActive({
                type: "status",
                payload: { phase: "queued", message: "Message queued while run is active." },
              });
              return;
            }
            enqueue(() => runInput(text));
            break;
          }

          case "run.cancel":
            wsIo.abortRun();
            break;

          case "session.stop":
            ws.close(1000, "client closed session");
            break;
        }
      },
      close(ws) {
        if (activeSocket === ws) {
          activeSocket = null;
          if (pendingUserInputResolve) {
            const resolve = pendingUserInputResolve;
            pendingUserInputResolve = null;
            resolve(null);
          }
          if (wsIo.isRunning()) wsIo.abortRun();
        }
      },
    },
  });

  console.log(`ui-server listening on http://${server.hostname}:${server.port} (ws: /ws)`);

  const stop = () => {
    cleanup();
    server.stop(true);
  };

  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(143);
  });
}

function parseTaskDraft(
  text: string,
): { name: string; description: string; relatedFiles?: string[]; acceptanceCriteria?: string[] } | null {
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStr = codeBlock ? codeBlock[1] : text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    if (typeof obj.name === "string" && typeof obj.description === "string") {
      const relatedFiles = Array.isArray(obj.relatedFiles)
        ? (obj.relatedFiles as unknown[]).filter((f): f is string => typeof f === "string")
        : undefined;
      const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria)
        ? (obj.acceptanceCriteria as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;
      return {
        name: obj.name,
        description: obj.description,
        ...(relatedFiles?.length ? { relatedFiles } : {}),
        ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parsePlanDraft(text: string): { name: string; description: string; approach: string } | null {
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStr = codeBlock ? codeBlock[1] : text.match(/\{[\s\S]*\}/)?.[0];
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
    return null;
  }
  return null;
}

function parsePlanTasks(text: string): Array<{ name: string; description: string }> | null {
  const codeBlock = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const jsonStr = codeBlock ? codeBlock[1] : text.match(/\[[\s\S]*\]/)?.[0];
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
    return null;
  }
}

function buildSplitPrompt(plan: Plan, existingPlanTasks: Task[]): string {
  return (
    `You are generating implementation tasks for the following plan.\n\n` +
    `Plan #${plan.id}: ${plan.name}\n` +
    `Description: ${plan.description}\n` +
    `Approach: ${plan.approach}\n\n` +
    (existingPlanTasks.length > 0
      ? `Existing tasks for this plan (do not duplicate):\n` +
        existingPlanTasks.map((t) => `  - #${t.id}: ${t.name}`).join("\n") +
        "\n\n"
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
    `relatedFiles is optional. Do not include any other JSON outside the code block.`
  );
}

function buildMicrosplitPrompt(plan: Plan, existingPlanTasks: Task[]): string {
  return (
    `You are generating MICRO-TASKS for small language models (7B-30B params).\n\n` +
    `Plan #${plan.id}: ${plan.name}\n` +
    `Description: ${plan.description}\n` +
    `Approach: ${plan.approach}\n\n` +
    (existingPlanTasks.length > 0
      ? `Existing tasks for this plan (do not duplicate):\n` +
        existingPlanTasks.map((t) => `  - #${t.id}: ${t.name}`).join("\n") +
        "\n\n"
      : "") +
    `CONSTRAINTS for small model compatibility:\n` +
    `- Each task must be completable in ONE file (two files max if tightly coupled)\n` +
    `- Each task should require reading <300 lines of code total\n` +
    `- Each task should produce <50 lines of changes\n` +
    `- No exploration needed — specify exact files in relatedFiles\n` +
    `- Task description must be unambiguous — SLMs can't infer intent\n\n` +
    `TASK PATTERNS (pick one per task):\n` +
    `- "Add function X to file Y that does Z"\n` +
    `- "Modify function X in file Y to handle Z"\n` +
    `- "Add import and wire up X in file Y"\n` +
    `- "Add test for X in test file Y"\n\n` +
    `TOOL-USE RECIPES:\n` +
    `Each task description MUST end with a concrete recipe telling the SLM exactly how to navigate to the right code.\n` +
    `Use skim(path, start_line, end_line) and filegrep(path, pattern).\n\n` +
    `End with a fenced JSON array:\n\n` +
    "```json\n" +
    `[\n` +
    `  {"name": "add parseConfig to config.ts", "description": "Add parseConfig() function. Start: filegrep('src/config.ts', 'loadConfig') then skim nearby lines.", "relatedFiles": ["src/config.ts"]},\n` +
    `  ...\n` +
    `]\n` +
    "```"
  );
}
