/**
 * Handover tool — allows the model to self-segment work by clearing context
 * and passing notes to a fresh conversation.
 */

export const handoverToolDef = {
  name: "handover" as const,
  description: `Signal that you have completed a self-contained step and want to hand over to a fresh context.
Use this when:
- You've completed a logical unit of work (e.g., implemented a function, fixed a bug, set up a file)
- The context is getting long and you want a clean slate for the next step
- You want to leave notes for the next step about what was done and what comes next

The current conversation will be cleared and a new one will start with your notes.`,
  parameters: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of what was accomplished in this step",
      },
      next_steps: {
        type: "string",
        description:
          "What should be done next — be specific about files, functions, and remaining work",
      },
      context: {
        type: "string",
        description:
          "Any important context the next step needs (file paths modified, decisions made, errors encountered)",
      },
    },
    required: ["summary", "next_steps"] as const,
  },
};
