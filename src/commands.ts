/**
 * Slash commands — quick actions handled directly in the main loop.
 */

import type { TUI } from "./tui";
import type { Config } from "./config";
import { detectProvider, detectBaseUrl, findApiKey, getKnownContextWindow } from "./config";
import type { Agent } from "./agent";
import type { LLMClient } from "./llm";
import type { CustomCommand } from "./custom-commands";
import { buildInitPrompt } from "./init";

// ── Command registry ───────────────────────────────────────────────

export interface CommandInfo {
  name: string;
  description: string;
}

/** Built-in commands (used for /help and autocompletion). */
export const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "clear",    description: "Clear conversation history" },
  { name: "init",     description: "Create or update AGENTS.md" },
  { name: "model",    description: "Show or switch model" },
  { name: "handover", description: "Summarize & continue in fresh context" },
  { name: "help",     description: "Show this help" },
];

// ── Command handling ───────────────────────────────────────────────

export interface CommandContext {
  tui: TUI;
  config: Config;
  agent: Agent;
  createLLMClient: (config: Config) => LLMClient;
  customCommands: Map<string, CustomCommand>;
}

export interface CommandResult {
  handled: boolean;
  newLLMClient?: LLMClient;
  /** If set, trigger a handover with these user instructions. */
  handoverArgs?: string;
  /** If set, run this prompt through the agent (custom commands). */
  runPrompt?: string;
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult {
  if (!input.startsWith("/")) return { handled: false };

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "clear":
      return cmdClear(ctx);
    case "init":
      return cmdInit(ctx);
    case "model":
      return cmdModel(args, ctx);
    case "handover":
      return cmdHandover(args, ctx);
    case "help":
      return cmdHelp(ctx);
    default: {
      // Check custom commands
      const custom = ctx.customCommands.get(cmd!);
      if (custom) {
        const userInput = args.join(" ").trim();
        const prompt = custom.prompt.replace(/\{input\}/g, userInput);
        return { handled: true, runPrompt: prompt };
      }
      ctx.tui.error(`Unknown command: /${cmd}. Type /help for available commands.`);
      return { handled: true };
    }
  }
}

function cmdClear(ctx: CommandContext): CommandResult {
  ctx.agent.clearHistory();
  ctx.tui.success("conversation cleared");
  return { handled: true };
}

function cmdInit(ctx: CommandContext): CommandResult {
  const prompt = buildInitPrompt(ctx.config.cwd);
  return { handled: true, runPrompt: prompt };
}

function cmdModel(args: string[], ctx: CommandContext): CommandResult {
  if (args.length === 0) {
    const ctxStr = ctx.config.contextWindow
      ? `, ctx: ${ctx.config.contextWindow >= 1000 ? `${Math.round(ctx.config.contextWindow / 1000)}k` : ctx.config.contextWindow}`
      : "";
    ctx.tui.info(`current model: ${ctx.config.model} (${ctx.config.provider}${ctxStr})`);
    return { handled: true };
  }

  const newModel = args[0]!;
  ctx.config.model = newModel;
  ctx.config.provider = detectProvider(newModel);
  ctx.config.baseUrl = ctx.config.baseUrl || detectBaseUrl(ctx.config.provider, newModel);
  ctx.config.apiKey = findApiKey(ctx.config.provider);

  // Update context window for the new model
  const knownCtx = getKnownContextWindow(newModel);
  if (knownCtx) ctx.config.contextWindow = knownCtx;

  const newClient = ctx.createLLMClient(ctx.config);
  const ctxStr = ctx.config.contextWindow
    ? `, ctx: ${ctx.config.contextWindow >= 1000 ? `${Math.round(ctx.config.contextWindow / 1000)}k` : ctx.config.contextWindow}`
    : "";
  ctx.tui.success(`switched to ${newModel} (${ctx.config.provider}${ctxStr})`);
  return { handled: true, newLLMClient: newClient };
}

function cmdHandover(args: string[], ctx: CommandContext): CommandResult {
  if (ctx.agent.getMessageCount() === 0) {
    ctx.tui.error("Nothing to hand over — conversation is empty.");
    return { handled: true };
  }
  const userInstructions = args.join(" ").trim() || undefined;
  return { handled: true, handoverArgs: userInstructions ?? "" };
}

function cmdHelp(ctx: CommandContext): CommandResult {
  ctx.tui.info("Commands:");
  for (const cmd of BUILTIN_COMMANDS) {
    ctx.tui.info(`  /${cmd.name.padEnd(20)} ${cmd.description}`);
  }

  if (ctx.customCommands.size > 0) {
    ctx.tui.info("");
    ctx.tui.info("Custom commands:");
    for (const [name, cmd] of ctx.customCommands) {
      const src = cmd.source === "project" ? "project" : "user";
      ctx.tui.info(`  /${name.padEnd(20)} ${cmd.description} (${src})`);
    }
  }

  return { handled: true };
}
