import { Agent } from "./agent";
import { buildSystemPromptWithOptionalRolePrefix, type BuildSystemPromptOptions } from "./prompt";
import { ProcessManager } from "./process-manager";
import { createLLMClient } from "./llm";
import { loadCustomCommands } from "./custom-commands";
import { loadSkills, type Skill } from "./skills";
import { handleCommand, type CommandIO } from "./commands";
import { expandAtMentions } from "./at-mention";
import type { Config } from "./config";
import { runStopHooks, type HookRunCompleteMeta } from "./hooks";
import type { Logger } from "./logger";
import type { UiServerMessage, ThreadInfo } from "./ui-protocol";
import { WsAgentIO } from "./ws-agent-io";
import { loadTasks, saveTasks, parsePlanTasks, taskFromPlanDraft, type Task } from "./tasks";
import { buildMicrosplitPrompt, buildSplitPrompt } from "./plan-split-prompts";
import {
  loadPlans,
  savePlans,
  nextPlanId,
  nextStandaloneId,
  nextPlanTaskId,
  type Plan,
} from "./plans";
import type { CustomCommand } from "./custom-commands";

type EmitMessage = (msg: UiServerMessage) => void;

export interface AgentThread {
  id: string;
  agent: Agent;
  io: WsAgentIO;
  processManager: ProcessManager;
  runQueue: Promise<void>;
  createdAt: Date;
  /** Trimmed ui-server role prefix from `thread.create`, if any; used when rebuilding the system prompt. */
  systemPromptPrefix?: string;
  customCommands: Map<string, CustomCommand>;
  skills: Map<string, Skill>;
  pendingUserInputResolve: ((value: string | null) => void) | null;
}

class WsCommandIO implements CommandIO {
  constructor(
    private readonly emit: EmitMessage,
    private readonly threadId: string,
  ) {}

  info(msg: string): void {
    this.emit({ type: "status", payload: { threadId: this.threadId, phase: "info", message: msg } });
  }

  success(msg: string): void {
    this.emit({ type: "status", payload: { threadId: this.threadId, phase: "success", message: msg } });
  }

  error(msg: string): void {
    this.emit({ type: "error", payload: { threadId: this.threadId, message: msg } });
  }

  print(line: string): void {
    this.emit({ type: "status", payload: { threadId: this.threadId, phase: "print", message: line } });
  }
}

export interface ThreadManagerOptions {
  config: Config;
  logger: Logger;
  emit: EmitMessage;
}

export class ThreadManager {
  private threads = new Map<string, AgentThread>();
  private config: Config;
  private logger: Logger;
  private emit: EmitMessage;

  private systemPromptOptions(): BuildSystemPromptOptions {
    return { allowedToolNames: this.config.allowedTools };
  }

  constructor(opts: ThreadManagerOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.emit = opts.emit;
  }

  setEmitter(emit: EmitMessage): void {
    this.emit = emit;
    for (const thread of this.threads.values()) {
      thread.io.setEmitter(emit);
    }
  }

  create(threadId?: string, systemPromptPrefix?: string): string {
    const id = threadId ?? crypto.randomUUID();
    
    if (this.threads.has(id)) {
      return id;
    }

    const processManager = new ProcessManager();
    const llm = createLLMClient(this.config, { allowedToolNames: this.config.allowedTools });
    const trimmedPrefix = systemPromptPrefix?.trim();
    const systemPrompt = buildSystemPromptWithOptionalRolePrefix(
      this.config.cwd,
      this.config.editMode,
      systemPromptPrefix,
      this.systemPromptOptions(),
    );
    
    const io = new WsAgentIO(this.emit, id);

    const agent = new Agent({
      llm,
      systemPrompt,
      cwd: this.config.cwd,
      logger: this.logger,
      io,
      processManager,
      contextWindow: this.config.contextWindow,
      handoverThreshold: this.config.handoverThreshold,
      editMode: this.config.editMode,
      runtimeConfig: this.config,
      onRunComplete: async (meta: HookRunCompleteMeta) => {
        if (meta.aborted) return;
        await runStopHooks(
          this.config.cwd,
          this.config.hookTimeoutMs,
          this.config.hooks,
          (msg) => {
            this.emit({
              type: "status",
              payload: { threadId: id, phase: "info", message: `hook: ${msg}` },
            });
          },
          (shell, i, n) => {
            this.emit({
              type: "status",
              payload: { threadId: id, phase: "info", message: `hook stop [${i}/${n}]: ${shell}` },
            });
          },
        );
      },
    });

    const customCommands = loadCustomCommands(this.config.cwd);
    const skills = loadSkills(this.config.cwd);

    const thread: AgentThread = {
      id,
      agent,
      io,
      processManager,
      runQueue: Promise.resolve(),
      createdAt: new Date(),
      systemPromptPrefix: trimmedPrefix || undefined,
      customCommands,
      skills,
      pendingUserInputResolve: null,
    };

    this.threads.set(id, thread);
    return id;
  }

  get(threadId: string): AgentThread | undefined {
    return this.threads.get(threadId);
  }

  delete(threadId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) return false;

    thread.processManager.killAll();
    if (thread.io.isRunning()) {
      thread.io.abortRun();
    }
    if (thread.pendingUserInputResolve) {
      thread.pendingUserInputResolve(null);
    }
    this.threads.delete(threadId);
    return true;
  }

  list(): ThreadInfo[] {
    return Array.from(this.threads.values()).map((thread) => ({
      threadId: thread.id,
      createdAt: thread.createdAt.toISOString(),
      messageCount: thread.agent.getMessageCount(),
      isRunning: thread.io.isRunning(),
    }));
  }

  cleanup(): void {
    for (const thread of this.threads.values()) {
      thread.processManager.killAll();
      if (thread.io.isRunning()) {
        thread.io.abortRun();
      }
    }
    this.threads.clear();
  }

  async runInput(threadId: string, text: string): Promise<void> {
    const thread = this.get(threadId);
    if (!thread) {
      this.emit({ type: "error", payload: { threadId, message: `Thread ${threadId} not found.` } });
      return;
    }

    const commandIo = new WsCommandIO(this.emit, threadId);

    if (text.startsWith("/")) {
      const result = handleCommand(text, {
        tui: commandIo,
        config: this.config,
        agent: thread.agent,
        createLLMClient: (c) => createLLMClient(c, { allowedToolNames: c.allowedTools }),
        customCommands: thread.customCommands,
        skills: thread.skills,
      });

      if (!result.handled) return;

      if (result.taskAddMode) {
        await this.runTaskAddMode(thread, result.taskAddMode.userText);
        return;
      }
      if (result.planDiscussionMode) {
        await this.runPlanMode(thread, result.planDiscussionMode.userText);
        return;
      }
      if (result.planSplitMode) {
        await this.runPlanSplitMode(thread, result.planSplitMode.planId, false);
        return;
      }
      if (result.planMicrosplitMode) {
        await this.runPlanSplitMode(thread, result.planMicrosplitMode.planId, true);
        return;
      }
      if (result.workTask !== undefined || result.workPlan !== undefined) {
        this.emit({
          type: "error",
          payload: { threadId, message: "Task-run loops are currently terminal-only; use /tasks run or /plans run in terminal." },
        });
        return;
      }

      if (result.newLLMClient) {
        thread.agent.setLLM(result.newLLMClient);
      }
      if (result.handoverArgs !== undefined) {
        await thread.agent.handover(result.handoverArgs || undefined);
      }
      if (result.runPrompt !== undefined) {
        await thread.agent.run(result.runPrompt);
      }
      if (result.reloadSystemPrompt) {
        const systemPrompt = buildSystemPromptWithOptionalRolePrefix(
          this.config.cwd,
          this.config.editMode,
          thread.systemPromptPrefix,
          this.systemPromptOptions(),
        );
        thread.agent.setSystemPrompt(systemPrompt);
        thread.customCommands = loadCustomCommands(this.config.cwd);
        thread.skills = loadSkills(this.config.cwd);
      }

      return;
    }

    const expanded = await expandAtMentions(text, this.config.cwd, this.config.editMode);
    await thread.agent.run(expanded);
  }

  enqueue(threadId: string, task: () => Promise<void>): void {
    const thread = this.get(threadId);
    if (!thread) return;

    thread.runQueue = thread.runQueue.then(task).catch((err: unknown) => {
      this.emit({
        type: "error",
        payload: { threadId, message: err instanceof Error ? err.message : String(err) },
      });
    });
  }

  private async promptUser(thread: AgentThread, prompt: string): Promise<string | null> {
    this.emit({ type: "status", payload: { threadId: thread.id, phase: "prompt", message: prompt } });
    return new Promise((resolve) => {
      thread.pendingUserInputResolve = resolve;
    });
  }

  private async runTaskAddMode(thread: AgentThread, userText: string): Promise<void> {
    let draftPrompt =
      `The user wants to add a task to their task list. Here is their description:\n\n"${userText}"\n\n` +
      `Based on this, create a concise task with a short name, a clear description, a list of related files (if applicable), and acceptance criteria. ` +
      `Respond with ONLY a JSON object in this exact format (no other text):\n` +
      `{"name": "short task name", "description": "clear description of what needs to be done", "relatedFiles": ["src/foo.ts"], "acceptanceCriteria": ["criterion one", "criterion two"]}\n` +
      `relatedFiles and acceptanceCriteria may be empty arrays if not applicable.`;

    let confirmed = false;
    while (!confirmed) {
      thread.agent.clearHistory();
      await thread.agent.run(draftPrompt);
      const lastText = thread.agent.getLastAssistantText();
      const draft = lastText ? parseTaskDraft(lastText) : null;

      if (!draft) {
        this.emit({
          type: "error",
          payload: { threadId: thread.id, message: "Could not parse task from agent response. Try /tasks add again." },
        });
        break;
      }

      this.emit({ type: "status", payload: { threadId: thread.id, phase: "info", message: "Task preview:" } });
      this.emit({
        type: "status",
        payload: { threadId: thread.id, phase: "info", message: `Name: ${draft.name}\nDescription: ${draft.description}` },
      });
      if (draft.relatedFiles?.length) {
        this.emit({
          type: "status",
          payload: { threadId: thread.id, phase: "info", message: `Files: ${draft.relatedFiles.join(", ")}` },
        });
      }
      if (draft.acceptanceCriteria?.length) {
        this.emit({
          type: "status",
          payload: {
            threadId: thread.id,
            phase: "info",
            message: `Acceptance:\n${draft.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
          },
        });
      }

      const answer = await this.promptUser(thread, "[y]es to save, [n]o to revise, [a]bandon");
      if (answer === null) break;
      const normalized = answer.trim().toLowerCase();
      if (normalized === "a" || normalized === "abandon") {
        this.emit({ type: "status", payload: { threadId: thread.id, phase: "info", message: "Task creation abandoned." } });
        break;
      }
      if (normalized === "y" || normalized === "yes") {
        const tasks = loadTasks(this.config.cwd);
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
        saveTasks(this.config.cwd, tasks);
        this.emit({
          type: "status",
          payload: { threadId: thread.id, phase: "success", message: `Task #${newTask.id} added: ${newTask.name}` },
        });
        confirmed = true;
      } else {
        const feedback = answer.replace(/^n\s*/i, "").trim();
        const moreInstructions = feedback || (await this.promptUser(thread, "Provide more instructions:")) || "";
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
    thread.agent.clearHistory();
  }

  private async runPlanMode(thread: AgentThread, userText: string): Promise<void> {
    thread.agent.clearHistory();
    this.emit({
      type: "status",
      payload: {
        threadId: thread.id,
        phase: "info",
        message:
          "Plan mode started. Discuss the idea, then confirm to save. Use /plan exit to leave plan mode.",
      },
    });

    thread.agent.setLLM(
      createLLMClient(this.config, {
        includeAskUserTool: true,
        allowedToolNames: this.config.allowedTools,
      }),
    );
    try {
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

      await thread.agent.run(planModePrompt);
      let lastPlanText = thread.agent.getLastAssistantText() ?? "";
      let hasDraft = !!parsePlanDraft(lastPlanText);
      let exitPlanMode = false;

      while (!exitPlanMode) {
        if (hasDraft) {
          const draft = parsePlanDraft(lastPlanText);
          const answer = await this.promptUser(thread, "[y]es to save plan, send feedback to refine, [a]bandon");
          if (answer === null) break;
          const normalized = answer.toLowerCase();

          if (normalized === "a" || normalized === "abandon") {
            this.emit({ type: "status", payload: { threadId: thread.id, phase: "info", message: "Planning abandoned." } });
            exitPlanMode = true;
            break;
          }

          if (normalized === "y" || normalized === "yes" || normalized === "accept") {
            if (!draft) {
              this.emit({
                type: "error",
                payload: { threadId: thread.id, message: "Could not parse plan from model response. Send feedback to revise." },
              });
              continue;
            }
            const plans = loadPlans(this.config.cwd);
            const newPlan: Plan = {
              id: nextPlanId(plans),
              name: draft.name,
              description: draft.description,
              approach: draft.approach,
              createdAt: new Date().toISOString(),
            };
            savePlans(this.config.cwd, [...plans, newPlan]);
            this.emit({
              type: "status",
              payload: { threadId: thread.id, phase: "success", message: `Plan #${newPlan.id} saved: ${newPlan.name}` },
            });
            this.emit({
              type: "status",
              payload: {
                threadId: thread.id,
                phase: "info",
                message: `Use /plans split ${newPlan.id} to generate implementation tasks.`,
              },
            });
            exitPlanMode = true;
            break;
          }

          await thread.agent.run(
            `${answer}\n\n` +
              `Please revise the plan based on this feedback. End with fenced JSON:\n` +
              `{"name": "...", "description": "...", "approach": "..."}`,
          );
          lastPlanText = thread.agent.getLastAssistantText() ?? "";
          hasDraft = !!parsePlanDraft(lastPlanText);
        } else {
          const planInput = await this.promptUser(thread, "Plan mode: continue discussion or send /plan exit");
          if (planInput === null) break;
          if (planInput.toLowerCase() === "/plan exit") {
            this.emit({ type: "status", payload: { threadId: thread.id, phase: "info", message: "Exiting plan mode." } });
            exitPlanMode = true;
            break;
          }
          await thread.agent.run(planInput);
          lastPlanText = thread.agent.getLastAssistantText() ?? "";
          hasDraft = !!parsePlanDraft(lastPlanText);
        }
      }
    } finally {
      thread.agent.setLLM(createLLMClient(this.config, { allowedToolNames: this.config.allowedTools }));
      thread.agent.clearHistory();
    }
  }

  private async runPlanSplitMode(thread: AgentThread, planId: number, micro = false): Promise<void> {
    const plans = loadPlans(this.config.cwd);
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
      this.emit({ type: "error", payload: { threadId: thread.id, message: `Plan #${planId} not found.` } });
      return;
    }
    const existingTasks = loadTasks(this.config.cwd).filter((t) => t.plan === planId);

    const restorePrompt = (): void => {
      thread.agent.clearHistory();
      thread.agent.setSystemPrompt(
        buildSystemPromptWithOptionalRolePrefix(
          this.config.cwd,
          this.config.editMode,
          thread.systemPromptPrefix,
          this.systemPromptOptions(),
        ),
      );
    };

    thread.agent.clearHistory();
    thread.agent.setSystemPrompt(
      buildSystemPromptWithOptionalRolePrefix(
        this.config.cwd,
        this.config.editMode,
        thread.systemPromptPrefix,
        this.systemPromptOptions(),
      ),
    );

    const splitUserPrompt = micro
      ? buildMicrosplitPrompt(plan, existingTasks)
      : buildSplitPrompt(plan, existingTasks);

    try {
      await thread.agent.run(splitUserPrompt);
      const responseText = thread.agent.getLastAssistantText() ?? "";
      const parsedTasks = parsePlanTasks(responseText);
      if (!parsedTasks || parsedTasks.length === 0) {
        this.emit({
          type: "error",
          payload: {
            threadId: thread.id,
            message: `Could not parse tasks from agent response. Try /plans ${micro ? "microsplit" : "split"} again.`,
          },
        });
        return;
      }

      this.emit({
        type: "status",
        payload: {
          threadId: thread.id,
          phase: "info",
          message: `Tasks to create (${parsedTasks.length}):\n${parsedTasks
            .map((t, i) => `${i + 1}. ${t.name} — ${t.description}`)
            .join("\n")}`,
        },
      });

      const answer = await this.promptUser(thread, "[y]es to save tasks, [a]bandon");
      if (!answer || !["y", "yes"].includes(answer.toLowerCase())) {
        this.emit({ type: "status", payload: { threadId: thread.id, phase: "info", message: "Task creation abandoned." } });
        return;
      }

      const allTasks = loadTasks(this.config.cwd);
      const created: Task[] = parsedTasks.map((draft) => {
        const id = nextPlanTaskId(allTasks, planId);
        const task = taskFromPlanDraft(draft, id, planId);
        allTasks.push(task);
        return task;
      });
      saveTasks(this.config.cwd, allTasks);
      this.emit({
        type: "status",
        payload: {
          threadId: thread.id,
          phase: "success",
          message: `Created ${created.length} task${created.length === 1 ? "" : "s"} for plan #${planId}.`,
        },
      });
    } finally {
      restorePrompt();
    }
  }
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

