import type { Plan } from "./plans";
import type { Task } from "./tasks";

/** Prompt for /plans split — ordered implementation + test tasks. */
export function buildSplitPrompt(plan: Plan, existingPlanTasks: Task[]): string {
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

/** Prompt for /plans microsplit — one clear objective per task with inline code context for small LLMs. */
export function buildMicrosplitPrompt(plan: Plan, existingPlanTasks: Task[]): string {
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
    `- Each task must have ONE clear objective (one logical change). Multiple files are OK when they are one atomic change (e.g. interface + implementation, handler + test).\n` +
    `- Each task should require reading <300 lines of code total when executing (the description should minimize exploration).\n` +
    `- Each task should produce <50 lines of net changes unless the plan requires more.\n` +
    `- List every file the executor must touch in relatedFiles.\n` +
    `- Task description must be unambiguous — SLMs can't infer intent.\n\n` +
    `INLINE CONTEXT (required for each task):\n` +
    `- Explore the codebase NOW and copy short snippets into codeContext so the executor does not need to search the repo.\n` +
    `- insertionPoint: 3–12 lines showing where to edit (or "// INSERT HERE" after the anchor).\n` +
    `- patternExample: optional nearby code to mirror (imports, error handling, style).\n` +
    `- signature: optional function/type signature or interface the new code must satisfy.\n` +
    `- The description should still state the goal in one sentence, then reference codeContext.\n\n` +
    `OPTIONAL navigation hint: you may append a short "Start: skim(...) or filegrep(...)" line if it helps verify anchors; line numbers may drift — codeContext is authoritative.\n\n` +
    `End with a fenced JSON array. Each object MUST include name, description, relatedFiles, and codeContext:\n\n` +
    "```json\n" +
    `[\n` +
    `  {\n` +
    `    "name": "add parseConfig to config.ts",\n` +
    `    "description": "Add parseConfig(raw) after loadConfig; mirror loadConfig's error handling. See codeContext for anchor and signature.",\n` +
    `    "relatedFiles": ["src/config.ts"],\n` +
    `    "codeContext": {\n` +
    `      "insertionPoint": "export function loadConfig(cwd: string): Config {\\n  const raw = readConfigFile(cwd);\\n  return { ...DEFAULT_CONFIG, ...raw };\\n}\\n// INSERT parseConfig HERE",\n` +
    `      "patternExample": "export function loadConfig(cwd: string): Config { ... }",\n` +
    `      "signature": "export function parseConfig(raw: unknown): Config"\n` +
    `    }\n` +
    `  }\n` +
    `]\n` +
    "```"
  );
}
