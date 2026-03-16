# Commands

Type these in interactive mode. Typing `/` shows all available commands with real-time filtering. Press **Tab** to autocomplete when there's a single match.

## Built-in commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/model [name]` | Show or switch the current model |
| `/handover [prompt]` | Summarize progress and continue in a fresh context |
| `/init` | Generate an `AGENTS.md` for the current project |
| `/plan` | Enter plan mode: discuss an idea, then save a named plan |
| `/plans` | List all plans with task status summary |
| `/plans split <id>` | Generate implementation + test tasks from a plan |
| `/plans microsplit <id>` | Generate micro-tasks optimized for small LLMs |
| `/plans run <id>` | Work through all tasks belonging to a plan |
| `/tasks` | List planned and in-progress tasks |
| `/tasks add <description>` | Add a new task (agent drafts name/description for confirmation) |
| `/tasks run [id]` | Work on a specific task, or pick the next planned one |
| `/tasks rm <id>` | Remove a task |
| `/skills` | List available skills |
| `/create-skill` | Create a new skill interactively |
| `/help` | List available commands |

## Custom commands

You can create custom slash commands by adding markdown files:

| Location | Scope |
|----------|-------|
| `.nav/commands/*.md` | Project-level (takes precedence) |
| `~/.config/nav/commands/*.md` | User-level |

The filename (minus `.md`) becomes the command name. The markdown content is sent to the agent as a prompt.

### Example

Create `.nav/commands/review.md`:

```markdown
Review the code I've changed. Focus on correctness, edge cases, and readability.
Check for common bugs and suggest improvements.
```

Then use it with `/review`.

### Argument placeholder

Use `{input}` as a placeholder for arguments:

```markdown
Review the following file for issues: {input}
```

```
> /review src/auth.ts
```

Custom commands appear in `/help` and in the autocomplete suggestions.
