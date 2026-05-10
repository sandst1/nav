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
    `End your response with the task list in this markdown format (ordered). Separate tasks with a line containing only \`---\`.\n\n` +
    "## Task name\n" +
    "**Files:** src/foo.ts, src/bar.ts\n\n" +
    "Description of what needs to be done.\n\n" +
    "**Criteria:**\n" +
    "- First acceptance criterion\n" +
    "- Second criterion (omit the entire **Criteria:** block if none)\n\n" +
    "---\n\n" +
    "## Next task name\n" +
    "**Files:** src/other.ts\n\n" +
    "...\n\n" +
    `**Files:** is optional (omit the line if not applicable). Each criterion is its own \`- \` bullet line under **Criteria:** (never comma-separate multiple criteria on one line).`
  );
}

/** Prompt for /plans split in goals mode — outcome-focused goals with verifiable criteria. */
export function buildGoalsSplitPrompt(plan: Plan, existingPlanTasks: Task[]): string {
  return (
    `You are generating GOALS for the following plan. Goals define WHAT success looks like, not HOW to implement.\n\n` +
    `Plan #${plan.id}: ${plan.name}\n` +
    `Description: ${plan.description}\n` +
    (plan.approach ? `Context: ${plan.approach}\n\n` : "\n") +
    (existingPlanTasks.length > 0
      ? `Existing goals for this plan (do not duplicate):\n` +
        existingPlanTasks.map((t) => `  - #${t.id}: ${t.name}`).join("\n") +
        "\n\n"
      : "") +
    `GOALS MODE PRINCIPLES:\n` +
    `- Each goal is an OUTCOME to achieve, not a step-by-step implementation\n` +
    `- Acceptance criteria are REQUIRED and must be checkable (can be verified by reading code or running commands)\n` +
    `- Description is minimal — context hints only, not implementation instructions\n` +
    `- The executor will figure out HOW to achieve the goal; you define WHAT success looks like\n` +
    `- Order goals by dependency (what must exist before what)\n\n` +
    `GOOD GOAL EXAMPLE:\n` +
    `  Name: "CLI accepts --dry-run flag"\n` +
    `  Criteria:\n` +
    `    - nav --dry-run "echo test" parses without error\n` +
    `    - nav --dry-run "echo test" does NOT execute the command\n` +
    `    - nav "echo test" still executes normally (no regression)\n` +
    `  Description: "See src/config.ts for CLI parsing"\n\n` +
    `BAD GOAL (too prescriptive):\n` +
    `  Name: "Add --dry-run flag to config.ts"\n` +
    `  Description: "In config.ts, add a dryRun boolean to CliFlags, parse it in parseArgs, pass to shell.ts..."\n\n` +
    `Explore the codebase as needed to understand what's possible and define realistic criteria.\n\n` +
    `End your response with the goal list in this markdown format. Separate goals with a line containing only \`---\`.\n\n` +
    "## Goal name (outcome statement)\n" +
    "**Files:** src/foo.ts, src/bar.ts (optional hints)\n\n" +
    "Brief context or hints (NOT implementation steps).\n\n" +
    "**Criteria:**\n" +
    "- First checkable criterion\n" +
    "- Second checkable criterion\n" +
    "- Third criterion (minimum 2 criteria per goal)\n\n" +
    "---\n\n" +
    "## Next goal name\n" +
    "...\n\n" +
    `**Criteria:** is REQUIRED for every goal. Each criterion must be verifiable (code inspection or command output).`
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
