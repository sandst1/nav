# Plans & Tasks

nav has a two-level planning system: **plans** capture the high-level design, **tasks** are the concrete units of work.

nav supports two planning modes controlled by the `planMode` config option:

- **`specs`** (default) — Tasks describe *how* to implement, with optional acceptance criteria
- **`goals`** — Goals describe *what* success looks like, with required acceptance criteria that are verified after implementation

## Plans

Plans are stored in `.nav/plans.json`. Start a plan with `/plan`:

```
> /plan add dark mode to the settings screen
```

nav enters plan mode — it discusses the idea with you, asking one clarifying question at a time. When the plan is ready, the model writes **YAML frontmatter** (`name`, `description`) between `---` lines, then the full plan as **markdown** (saved as `approach`). That shape is parsed deterministically when you confirm:


```
[y]es to save plan, type feedback to refine, [a]bandon
> y
Plan #1 saved: Dark mode settings
  Use /plans split 1 to generate implementation tasks.
```

### Splitting plans into tasks

Once saved, split it into tasks:

```
> /plans split 1
```

The agent reads the plan, explores the codebase, then writes an ordered **markdown task list** (`##` task titles, optional `**Files:**`, description text, optional `**Criteria:**` with one `-` bullet per criterion). nav parses that into tasks and saves them with IDs like `1-1`, `1-2`, etc. (the prefix is the plan ID). **`/plans microsplit`** still uses a fenced **JSON** array (with `codeContext` for small models).

### Working a plan

To work through all tasks in a plan:

```
> /plans run 1
Working plan #1: Dark mode settings
Working on task #1-1: Add theme state to settings store
...
```

### Listing plans

```
> /plans
Plans:
  #1  Dark mode settings  [0/5 done, 5 planned]
```

## Standalone tasks

Tasks without a plan use IDs like `0-1`, `0-2`, etc.

```
> /tasks add implement rate limiting for the API
```

The agent drafts a name and description, shows a preview, and asks for confirmation. Reply `y` to save, `n` (optionally with more instructions) to revise, or `a` to abandon.

```
> /tasks
Tasks:
  #0-1   [planned  ]  Rate limiting
               Add token-bucket rate limiting to the API middleware

> /tasks run 0-1
Working on task #0-1: Rate limiting
...
Task #0-1 marked as done.
```

### Auto-pick next task

Running `/tasks run` without an ID picks the next workable task automatically — `in_progress` tasks first, then `planned` ones, across all plans.

## Task statuses

Tasks cycle through three statuses: `planned` -> `in_progress` -> `done`.

When working plan-linked tasks, the plan's description and approach are included in the agent's context alongside the status of all sibling tasks.

## Goals mode

Goals mode (`planMode: "goals"`) changes how plans are discussed, split, and executed. Instead of prescribing *how* to implement, you define *what* success looks like.

### Enabling goals mode

```json
{
  "planMode": "goals"
}
```

### How it differs from specs mode

| Aspect | Specs mode (default) | Goals mode |
|--------|---------------------|------------|
| Plan discussion | Focus on implementation approach | Focus on outcomes and criteria |
| Split output | Tasks with descriptions of HOW | Goals with criteria of WHAT |
| Execution prompt | "Do this, then that" | "Achieve these criteria, figure out how" |
| Verification | Trust completion message | Dedicated verification phase |
| microsplit | Available | Not available |

### Planning in goals mode

When you enter `/plan` in goals mode, the agent focuses on outcomes:

```
> /plan add user authentication
[goals] Goals mode — define outcomes and criteria, then confirm to save.
```

The agent asks about what success looks like rather than implementation details.

### Splitting into goals

`/plans split` in goals mode produces goals with **required** acceptance criteria:

```
> /plans split 1
```

Each goal has:
- **Name** — the outcome (e.g., "Users can log in with email/password")
- **Criteria** — checkable items that define success (required, at least 2)
- **Description** — minimal context hints, not implementation steps
- **Files** — optional hints about relevant files

Example goal:

```markdown
## Users can register with email

**Files:** src/auth.ts, src/routes/register.ts

Context: See existing login flow for patterns.

**Criteria:**
- POST /api/register creates a new user in the database
- Duplicate emails return 409 Conflict
- Password is hashed before storage
- Success returns 201 with user ID
```

### Verification and fix loop

After all goals in a plan are implemented (`/plans run` or `/tasks run`), a **verification phase** runs:

1. For each goal with acceptance criteria:
   - A verification agent checks all criteria
   - Agent can read code, run commands, inspect output
   - Results are stored as pass/fail with evidence

2. If any criteria fail:
   - Failed criteria are stored in `failedCriteria` on the task
   - A **fix cycle** begins — the agent reworks tasks with failures
   - After fixes, verification runs again
   - This repeats until all pass or max attempts reached (default: 3, configurable via `taskImplementationMaxAttempts`)

3. Summary shows which criteria passed/failed
4. `planDone` hooks fire with verification results

```
Verification phase: checking 4 goal(s)...
─────────────────────────────────────────
Verifying Goal #1-1: Users can register with email
  ✓ POST /api/register creates a new user in the database
  ✗ Duplicate emails return 409 Conflict
  ✓ Password is hashed before storage
  ✓ Success returns 201 with user ID
─────────────────────────────────────────
Verification complete: 3/4 criteria passed
─────────────────────────────────────────
Fix cycle 1/3: 1 goal(s) need fixes
Fixing Goal #1-1: Users can register with email (1 failed criteria)
...
Verification phase: checking 1 goal(s)...
─────────────────────────────────────────
Verifying Goal #1-1: Users can register with email
  ✓ Duplicate emails return 409 Conflict
─────────────────────────────────────────
Verification complete: 1/1 criteria passed
```

If criteria still fail after all fix attempts, the remaining failures are reported and saved to the task.

### When to use goals mode

Goals mode is best when:
- You want the agent to figure out *how* to implement something
- You have clear success criteria that can be verified
- You're working with capable models that can reason about implementation
- You want automated verification of acceptance criteria

Specs mode is better when:
- You have a specific implementation approach in mind
- You're using smaller models that need detailed guidance
- You want to use microsplit for very granular tasks
