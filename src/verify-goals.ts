/**
 * Verification phase for goals mode — checks acceptance criteria after task implementation.
 *
 * One verification agent per task. Agent receives all criteria for the task,
 * checks each one, and returns structured pass/fail results.
 */

import type { Task, CriterionResult } from "./tasks";
import type { Agent } from "./agent";

/** Build the verification prompt for a task's acceptance criteria. */
export function buildVerificationPrompt(task: Task): string {
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    return `Goal #${task.id}: ${task.name}\n\nNo acceptance criteria defined. Mark as PASSED with evidence "No criteria to verify."`;
  }

  let prompt = `Verify Goal #${task.id}: ${task.name}\n\n`;

  if (task.description) {
    prompt += `Context: ${task.description}\n\n`;
  }

  if (task.relatedFiles?.length) {
    prompt += `Related files: ${task.relatedFiles.join(", ")}\n\n`;
  }

  prompt += `Criteria to verify:\n`;
  for (let i = 0; i < criteria.length; i++) {
    prompt += `${i + 1}. ${criteria[i]}\n`;
  }

  prompt += `
For each criterion, check if it is satisfied. You may:
- Read relevant code using the read/skim/filegrep tools
- Run commands using the shell tool and inspect output
- Check for expected behavior or side effects

After checking, respond with a structured result for EACH criterion in this exact format:
CRITERION 1: PASSED | <evidence why it passes>
or
CRITERION 1: FAILED | <evidence why it fails>

Continue for all ${criteria.length} criteria. Be concise but specific with evidence.`;

  return prompt;
}

/** Parse verification results from agent response text. */
export function parseVerificationResults(
  responseText: string,
  criteria: string[],
): CriterionResult[] {
  const results: CriterionResult[] = [];
  const lines = responseText.split("\n");

  for (let i = 0; i < criteria.length; i++) {
    const criterion = criteria[i]!;
    const prefix = `CRITERION ${i + 1}:`;

    let found = false;
    for (const line of lines) {
      const trimmed = line.trim();
      // Strip markdown bold formatting (** or *) from start and end
      const cleaned = trimmed.replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "");
      if (cleaned.toUpperCase().startsWith(prefix.toUpperCase())) {
        const rest = cleaned.slice(prefix.length).trim();
        const pipeIndex = rest.indexOf("|");

        if (pipeIndex !== -1) {
          const statusPart = rest.slice(0, pipeIndex).trim().toUpperCase();
          const evidence = rest.slice(pipeIndex + 1).trim();
          const passed = statusPart === "PASSED";

          results.push({ criterion, passed, evidence });
          found = true;
          break;
        } else {
          const passed = rest.toUpperCase().startsWith("PASSED");
          const evidence = rest.replace(/^(PASSED|FAILED)\s*/i, "").trim() || "No evidence provided";
          results.push({ criterion, passed, evidence });
          found = true;
          break;
        }
      }
    }

    if (!found) {
      results.push({
        criterion,
        passed: false,
        evidence: "Verification result not found in agent response",
      });
    }
  }

  return results;
}

/** Run verification for a single task. Returns the criteria results. */
export async function verifyTaskCriteria(
  task: Task,
  agent: Agent,
): Promise<CriterionResult[]> {
  const criteria = task.acceptanceCriteria ?? [];

  if (criteria.length === 0) {
    return [{
      criterion: "(no criteria defined)",
      passed: true,
      evidence: "No acceptance criteria to verify",
    }];
  }

  const prompt = buildVerificationPrompt(task);
  await agent.run(prompt);

  const responseText = agent.getLastAssistantText() ?? "";
  return parseVerificationResults(responseText, criteria);
}

/** Summary of verification results for display. */
export interface VerificationSummary {
  taskId: string;
  taskName: string;
  total: number;
  passed: number;
  failed: number;
  results: CriterionResult[];
}

/** Generate a summary from verification results. */
export function summarizeVerification(
  task: Task,
  results: CriterionResult[],
): VerificationSummary {
  const passed = results.filter((r) => r.passed).length;
  return {
    taskId: task.id,
    taskName: task.name,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
