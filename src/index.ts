#!/usr/bin/env bun
/**
 * nav — minimalist coding agent entry point.
 *
 * Interactive mode:  nav
 * One-shot mode:     nav "fix the bug in main.ts"
 */

import { parseArgs, resolveConfig, loadConfigFiles, HELP_TEXT } from "./config";
import { isAlreadySandboxed, isSandboxAvailable, execSandbox } from "./sandbox";
import { createLLMClient, detectOllamaContextWindow } from "./llm";
import { buildSystemPrompt } from "./prompt";
import { Agent } from "./agent";
import { ProcessManager } from "./process-manager";
import { Logger } from "./logger";
import { TUI } from "./tui";
import { handleCommand, BUILTIN_COMMANDS } from "./commands";
import { loadCustomCommands } from "./custom-commands";
import { theme, RESET, setTheme } from "./theme";

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // Sandbox: re-exec under sandbox-exec if requested and not already inside
  const wantSandbox =
    flags.sandbox ??
    (process.env.NAV_SANDBOX === "1" || process.env.NAV_SANDBOX === "true");

  if (wantSandbox && !isAlreadySandboxed()) {
    if (!isSandboxAvailable()) {
      console.error("sandbox: sandbox-exec not found (macOS only)");
      process.exit(1);
    }
    execSandbox(); // re-execs, never returns
  }

  // Load config files once; apply theme before anything renders
  const fileConfig = loadConfigFiles(process.cwd());
  const fileTheme = process.env.NAV_THEME ?? fileConfig.theme;
  if (fileTheme) setTheme(fileTheme);

  const config = resolveConfig(flags, fileConfig);
  const logger = new Logger(config.cwd, config.verbose);
  const tui = new TUI();
  const llm = createLLMClient(config);
  const { prompt: systemPrompt, projectTree } = buildSystemPrompt(config.cwd);
  const processManager = new ProcessManager();

  // Detect context window for Ollama models if not already known
  if (config.provider === "ollama" && !config.contextWindow) {
    const detected = await detectOllamaContextWindow(config.model, config.baseUrl);
    if (detected) {
      config.contextWindow = detected;
    } else {
      console.warn(
        `${theme.warning}⚠ Could not reach Ollama — is it running? ` +
        `Context window detection skipped; using default.${RESET}`,
      );
    }
  }

  logger.logConfig({
    model: config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
    verbose: config.verbose,
    cwd: config.cwd,
    contextWindow: config.contextWindow,
    handoverThreshold: config.handoverThreshold,
  });

  logger.logSystemPrompt(systemPrompt);

  const agent = new Agent({
    llm,
    systemPrompt,
    cwd: config.cwd,
    logger,
    tui,
    processManager,
    contextWindow: config.contextWindow,
    handoverThreshold: config.handoverThreshold,
  });

  // Clean shutdown handler
  const cleanup = () => {
    processManager.killAll();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("exit", cleanup);

  // Load custom commands
  const customCommands = loadCustomCommands(config.cwd);

  // Build command list for TUI autocompletion
  const allCommands = [
    ...BUILTIN_COMMANDS.map((c) => ({ name: c.name, description: c.description })),
    ...[...customCommands.values()].map((c) => ({ name: c.name, description: c.description })),
  ];
  tui.setCommands(allCommands);

  // One-shot mode
  if (flags.prompt) {
    await agent.run(flags.prompt);
    cleanup();
    process.exit(0);
  }

  // Interactive mode
  tui.banner(config.model, config.provider, logger.logPath, config.contextWindow, config.handoverThreshold);

  while (true) {
    const input = await tui.prompt();
    if (input === null) {
      tui.info("bye");
      break;
    }

    // Handle slash commands
    if (input.startsWith("/")) {
      const result = handleCommand(input, { tui, config, agent, createLLMClient, customCommands });
      if (result.handled) {
        if (result.newLLMClient) {
          agent.setLLM(result.newLLMClient);
          // Update context window for new model
          if (config.contextWindow) {
            agent.setContextWindow(config.contextWindow);
          }
        }
        if (result.handoverArgs !== undefined) {
          await agent.handover(result.handoverArgs || undefined);
        }
        if (result.runPrompt !== undefined) {
          await agent.run(result.runPrompt);
        }
        tui.separator();
        continue;
      }
    }

    await agent.run(input);
    tui.separator();
  }

  tui.close();
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
