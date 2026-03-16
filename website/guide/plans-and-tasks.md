# Plans & Tasks

nav has a two-level planning system: **plans** capture the high-level design, **tasks** are the concrete units of work.

## Plans

Plans are stored in `.nav/plans.json`. Start a plan with `/plan`:

```
> /plan add dark mode to the settings screen
```

nav enters plan mode — it discusses the idea with you, asking one clarifying question at a time. When the plan is ready, it produces a summary and asks you to confirm:

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

The agent reads the plan, explores the codebase, then creates ordered implementation tasks **and** test-writing tasks. Tasks are saved with IDs like `1-1`, `1-2`, etc. (the prefix is the plan ID).

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
