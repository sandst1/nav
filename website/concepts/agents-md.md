# AGENTS.md

If an `AGENTS.md` file exists in the working directory, its content is automatically included in nav's system prompt. This is the standard way to give nav project-specific instructions.

## What to include

Use `AGENTS.md` for:

- **Project structure** — key directories, entry points, important files
- **Conventions** — coding style, naming patterns, architecture decisions
- **Build commands** — how to run, test, and deploy
- **Context** — domain knowledge, API patterns, or constraints the agent should know

## Generating AGENTS.md

nav can generate an initial `AGENTS.md` for your project:

```
> /init
```

The agent explores your codebase — reading key files, checking build tools, and inspecting project structure — then produces a tailored `AGENTS.md`. You can review and edit it before saving.

## Tips

- Keep it concise — this file is sent with every request, so it counts against the context window
- Focus on what an agent needs to know, not what a human developer would already understand
- Update it as the project evolves
- Put it in the project root (same directory where you run `nav`)

## Compatibility

The `AGENTS.md` convention is shared across multiple AI coding tools. If you already have one from another tool, nav will pick it up automatically.
