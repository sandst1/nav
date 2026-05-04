/**
 * Plan management — persistent plan store in .nav/plans.json
 *
 * Plan IDs start at 1. Standalone task IDs use plan-id 0 ("0-<seq>").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./tasks";

export interface Plan {
  id: number;
  name: string;
  description: string;
  approach: string;
  createdAt: string;
}

/** Shape produced from assistant plan text before assigning an id (same fields as Plan minus id/createdAt). */
export interface PlanDraft {
  name: string;
  description: string;
  approach: string;
}

/**
 * Parse a plan from assistant text: YAML frontmatter between --- lines, then markdown body.
 * If a line is exactly --- but the accumulated frontmatter is not yet valid, the line is treated
 * as content so horizontal rules in the body do not break parsing. When multiple valid documents
 * exist, the last one wins (refinements).
 */
export function parsePlanDraft(text: string): PlanDraft | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let last: PlanDraft | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "---") continue;
    const frontLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "---") {
        const front = frontLines.join("\n");
        const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
        if (name && description) {
          const body = lines.slice(j + 1).join("\n").trim();
          if (body) {
            last = { name, description, approach: body };
          }
          break;
        }
        // Looks like --- but frontmatter not yet valid — keep line (e.g. HR in prose).
      }
      frontLines.push(line);
    }
  }

  return last;
}

function plansPath(cwd: string): string {
  return join(cwd, ".nav", "plans.json");
}

export function loadPlans(cwd: string): Plan[] {
  const path = plansPath(cwd);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Plan[];
  } catch {
    return [];
  }
}

export function savePlans(cwd: string, plans: Plan[]): void {
  const navDir = join(cwd, ".nav");
  if (!existsSync(navDir)) {
    mkdirSync(navDir, { recursive: true });
  }
  writeFileSync(plansPath(cwd), JSON.stringify(plans, null, 2) + "\n", "utf-8");
}

/** Returns the next plan ID (plans start at 1). */
export function nextPlanId(plans: Plan[]): number {
  if (plans.length === 0) return 1;
  return Math.max(...plans.map((p) => p.id)) + 1;
}

/** Returns the next standalone task ID ("0-<seq>"). */
export function nextStandaloneId(tasks: Task[]): string {
  const standalone = tasks
    .map((t) => t.id)
    .filter((id): id is string => typeof id === "string" && id.startsWith("0-"))
    .map((id) => parseInt(id.slice(2), 10))
    .filter((n) => !isNaN(n));
  const next = standalone.length === 0 ? 1 : Math.max(...standalone) + 1;
  return `0-${next}`;
}

/** Returns the next task ID for a given plan ("planId-<seq>"). */
export function nextPlanTaskId(tasks: Task[], planId: number): string {
  const prefix = `${planId}-`;
  const existing = tasks
    .map((t) => t.id)
    .filter((id): id is string => typeof id === "string" && id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .filter((n) => !isNaN(n));
  const next = existing.length === 0 ? 1 : Math.max(...existing) + 1;
  return `${planId}-${next}`;
}
