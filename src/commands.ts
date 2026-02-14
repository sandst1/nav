/**
 * Slash commands — quick actions handled directly in the main loop.
 */

import type { TUI } from "./tui";
import type { Config } from "./config";
import { detectProvider, detectBaseUrl, findApiKey } from "./config";
import type { Agent } from "./agent";
import type { LLMClient } from "./llm";

export interface CommandContext {
  tui: TUI;
  config: Config;
  agent: Agent;
  createLLMClient: (config: Config) => LLMClient;
}

export interface CommandResult {
  handled: boolean;
  newLLMClient?: LLMClient;
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult {
  if (!input.startsWith("/")) return { handled: false };

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "clear":
      return cmdClear(ctx);
    case "model":
      return cmdModel(args, ctx);
    case "help":
      return cmdHelp(ctx);
    default:
      ctx.tui.error(`Unknown command: /${cmd}. Type /help for available commands.`);
      return { handled: true };
  }
}

function cmdClear(ctx: CommandContext): CommandResult {
  ctx.agent.clearHistory();
  ctx.tui.success("conversation cleared");
  return { handled: true };
}

function cmdModel(args: string[], ctx: CommandContext): CommandResult {
  if (args.length === 0) {
    ctx.tui.info(`current model: ${ctx.config.model} (${ctx.config.provider})`);
    return { handled: true };
  }

  const newModel = args[0]!;
  ctx.config.model = newModel;
  ctx.config.provider = detectProvider(newModel);
  ctx.config.baseUrl = ctx.config.baseUrl || detectBaseUrl(ctx.config.provider, newModel);
  ctx.config.apiKey = findApiKey(ctx.config.provider);

  const newClient = ctx.createLLMClient(ctx.config);
  ctx.tui.success(`switched to ${newModel} (${ctx.config.provider})`);
  return { handled: true, newLLMClient: newClient };
}

function cmdHelp(ctx: CommandContext): CommandResult {
  ctx.tui.info("Commands:");
  ctx.tui.info("  /clear          Clear conversation history");
  ctx.tui.info("  /model [name]   Show or switch model");
  ctx.tui.info("  /help           Show this help");
  return { handled: true };
}
