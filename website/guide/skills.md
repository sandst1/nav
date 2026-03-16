# Skills

Skills are reusable agent capabilities defined in `SKILL.md` files. They provide specialized knowledge or workflows that nav can use automatically based on the skill's description.

## Skill locations

| Location | Scope |
|----------|-------|
| `.nav/skills/<skill-name>/SKILL.md` | Project-level (takes precedence) |
| `.claude/skills/<skill-name>/SKILL.md` | Project-level (Claude compatibility) |
| `~/.config/nav/skills/<skill-name>/SKILL.md` | User-level |

Each skill lives in its own directory and has a `SKILL.md` file with YAML frontmatter.

## Skill format

```markdown
---
name: docx-creator
description: "Use this skill when the user wants to create Word documents (.docx files)"
---

# Word Document Creator

## Overview

This skill creates .docx files using...

## Instructions

1. Install the required package...
2. Use the following template...
```

The `description` field tells nav when to use the skill. Write it as a trigger condition, not just what the skill does.

## How skills work

Skills are automatically detected and injected into the system prompt. When nav sees a task matching a skill's description, it uses that skill's instructions. No manual activation needed.

## Commands

- `/skills` — list all available skills
- `/create-skill` — interactively create a new skill

## Precedence

Project-level skills (`.nav/skills/` and `.claude/skills/`) take precedence over user-level skills (`~/.config/nav/skills/`) with the same name.
