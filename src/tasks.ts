/**
 * Task management — persistent task list stored in .nav/tasks.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TaskStatus = "planned" | "in_progress" | "done";

export interface Task {
  id: number;
  name: string;
  description: string;
  status: TaskStatus;
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
    return parsed as Task[];
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

export function nextId(tasks: Task[]): number {
  if (tasks.length === 0) return 1;
  return Math.max(...tasks.map((t) => t.id)) + 1;
}

/** Returns in_progress tasks first, then planned, excluding done. */
export function getWorkableTasks(tasks: Task[]): Task[] {
  return [
    ...tasks.filter((t) => t.status === "in_progress"),
    ...tasks.filter((t) => t.status === "planned"),
  ];
}
