/**
 * Task management — persistent task list stored in .nav/tasks.json
 *
 * Task IDs are strings:
 *   "0-<seq>"        — standalone tasks (no plan)
 *   "<planId>-<seq>" — tasks belonging to a plan (plan IDs start at 1)
 *
 * ID generation helpers live in plans.ts (nextStandaloneId, nextPlanTaskId).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonFromAssistantText } from "./json-block";

export type TaskStatus = "planned" | "in_progress" | "done";

/** Inline snippets from microsplit so executors can avoid broad codebase exploration. */
export interface TaskCodeContext {
  insertionPoint?: string;
  patternExample?: string;
  signature?: string;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  plan?: number;
  relatedFiles?: string[];
  acceptanceCriteria?: string[];
  codeContext?: TaskCodeContext;
}

/** One row from the JSON array produced by /plans split or /plans microsplit (before IDs are assigned). */
export interface PlanTaskDraft {
  name: string;
  description: string;
  relatedFiles?: string[];
  acceptanceCriteria?: string[];
  codeContext?: TaskCodeContext;
}

function parseCodeContext(raw: unknown): TaskCodeContext | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const insertionPoint = typeof o.insertionPoint === "string" ? o.insertionPoint : undefined;
  const patternExample = typeof o.patternExample === "string" ? o.patternExample : undefined;
  const signature = typeof o.signature === "string" ? o.signature : undefined;
  if (insertionPoint === undefined && patternExample === undefined && signature === undefined) {
    return undefined;
  }
  return { insertionPoint, patternExample, signature };
}

/** Build drafts from a parsed JSON array (microsplit or legacy fenced JSON split). */
function planTasksFromParsedJsonArray(arr: unknown[]): PlanTaskDraft[] | null {
  try {
    const tasks: PlanTaskDraft[] = [];
    for (const item of arr) {
      if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).description === "string"
      ) {
        const rec = item as Record<string, unknown>;
        const relatedFiles = Array.isArray(rec.relatedFiles)
          ? (rec.relatedFiles as unknown[]).filter((f): f is string => typeof f === "string")
          : undefined;
        const acceptanceCriteria = Array.isArray(rec.acceptanceCriteria)
          ? (rec.acceptanceCriteria as unknown[]).filter((c): c is string => typeof c === "string")
          : undefined;
        const codeContext = parseCodeContext(rec.codeContext);
        tasks.push({
          name: rec.name as string,
          description: rec.description as string,
          ...(relatedFiles?.length ? { relatedFiles } : {}),
          ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}),
          ...(codeContext ? { codeContext } : {}),
        });
      }
    }
    return tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

/** Split assistant text into per-task sections (--- delimiters or multiple ## headings). */
function markdownPlanTaskSections(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (/\n---\n/.test(normalized)) {
    return normalized.split(/\n---\n/).map((s) => s.trim()).filter(Boolean);
  }
  const parts = normalized.split(/(?=^##\s+)/m).map((s) => s.trim()).filter(Boolean);
  return parts.filter((p) => p.startsWith("##"));
}

/**
 * Parse /plans split markdown task list into drafts.
 * Each section: ## name, optional **Files:**, description, optional **Criteria:** with `-` bullets.
 */
export function parsePlanTasksFromMarkdown(text: string): PlanTaskDraft[] | null {
  const sections = markdownPlanTaskSections(text);
  const tasks: PlanTaskDraft[] = [];
  for (const sec of sections) {
    const draft = parseOneMarkdownTaskSection(sec);
    if (draft) tasks.push(draft);
  }
  return tasks.length > 0 ? tasks : null;
}

function parseOneMarkdownTaskSection(section: string): PlanTaskDraft | null {
  const lines = section.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) return null;
  const heading = lines[i]!.match(/^##+\s+(.+)$/);
  if (!heading) return null;
  const name = heading[1]!.trim();
  if (!name) return null;
  i++;

  let relatedFiles: string[] | undefined;
  const descLines: string[] = [];
  const criteria: string[] = [];
  let inCriteria = false;

  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = raw.trim();

    if (inCriteria) {
      if (t === "") {
        inCriteria = false;
        continue;
      }
      const bullet = raw.match(/^\s*-\s+(.+)$/);
      if (bullet) {
        criteria.push(bullet[1]!.trim());
        continue;
      }
      inCriteria = false;
      descLines.push(raw);
      continue;
    }

    const filesM = raw.match(/^\*\*Files:\*\*\s*(.*)$/);
    if (filesM) {
      const parts = filesM[1]!
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      relatedFiles = parts.length > 0 ? parts : undefined;
      continue;
    }

    if (/^\*\*Criteria:\*\*/.test(raw)) {
      inCriteria = true;
      continue;
    }

    descLines.push(raw);
  }

  const description = descLines.join("\n").trim();
  const draft: PlanTaskDraft = {
    name,
    description,
    ...(relatedFiles?.length ? { relatedFiles } : {}),
    ...(criteria.length > 0 ? { acceptanceCriteria: criteria } : {}),
  };
  return draft;
}

/**
 * Parse tasks from /plans split (markdown) or /plans microsplit (JSON array).
 * JSON is tried first when present; otherwise markdown split format.
 */
export function parsePlanTasks(text: string): PlanTaskDraft[] | null {
  const parsed = parseJsonFromAssistantText(text);
  if (Array.isArray(parsed)) {
    const fromJson = planTasksFromParsedJsonArray(parsed);
    if (fromJson && fromJson.length > 0) return fromJson;
  }
  return parsePlanTasksFromMarkdown(text);
}

/** Build a persisted Task from a parsed plan row (assigns id and plan). */
export function taskFromPlanDraft(draft: PlanTaskDraft, id: string, planId: number): Task {
  return {
    id,
    name: draft.name,
    description: draft.description,
    status: "planned",
    plan: planId,
    ...(draft.relatedFiles?.length ? { relatedFiles: draft.relatedFiles } : {}),
    ...(draft.acceptanceCriteria?.length ? { acceptanceCriteria: draft.acceptanceCriteria } : {}),
    ...(draft.codeContext ? { codeContext: draft.codeContext } : {}),
  };
}

function tasksPath(cwd: string): string {
  return join(cwd, ".nav", "tasks.json");
}

export function loadTasks(cwd: string): Task[] {
  const path = tasksPath(cwd);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Task[]).filter((t) => typeof t.id === "string");
  } catch {
    return [];
  }
}

export function saveTasks(cwd: string, tasks: Task[]): void {
  const navDir = join(cwd, ".nav");
  if (!existsSync(navDir)) {
    mkdirSync(navDir, { recursive: true });
  }
  writeFileSync(tasksPath(cwd), JSON.stringify(tasks, null, 2) + "\n", "utf-8");
}

/** Returns in_progress tasks first, then planned, excluding done. */
export function getWorkableTasks(tasks: Task[]): Task[] {
  return [
    ...tasks.filter((t) => t.status === "in_progress"),
    ...tasks.filter((t) => t.status === "planned"),
  ];
}

/** Returns workable tasks for a specific plan. */
export function getWorkableTasksForPlan(tasks: Task[], planId: number): Task[] {
  return getWorkableTasks(tasks).filter((t) => t.plan === planId);
}
