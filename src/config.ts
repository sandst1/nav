/**
 * Configuration — resolved from env vars + CLI flags.
 */

export type Provider = "openai" | "anthropic" | "ollama";

export interface Config {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  verbose: boolean;
  enableHandover: boolean;
  cwd: string;
}

/** Known local model name patterns (for Ollama auto-detection). */
const LOCAL_MODEL_PATTERNS = ["llama", "mistral", "qwen", "gemma", "phi", "deepseek", "codellama", "vicuna", "wizardcoder", "starcoder", "yi"];

/** Auto-detect provider from model name. */
export function detectProvider(model: string): Provider {
  const m = model.toLowerCase();
  if (
    m.includes("claude") ||
    m.includes("anthropic") ||
    m.startsWith("claude")
  ) {
    return "anthropic";
  }
  // Known local model names → ollama
  if (LOCAL_MODEL_PATTERNS.some((p) => m.includes(p))) {
    return "ollama";
  }
  // Cloud model patterns → openai
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.includes("openai")) {
    return "openai";
  }
  return "openai";
}

/** Detect base URL for known providers. */
export function detectBaseUrl(provider: Provider, model: string): string | undefined {
  if (provider === "anthropic") return undefined;
  if (provider === "ollama") return "http://127.0.0.1:11434";
  // OpenAI-compatible local models
  const m = model.toLowerCase();
  if (LOCAL_MODEL_PATTERNS.some((p) => m.includes(p))) {
    return "http://127.0.0.1:11434";
  }
  return undefined;
}

/** Find API key from environment. */
export function findApiKey(provider: Provider): string {
  const explicit = process.env.NAV_API_KEY;
  if (explicit) return explicit;

  if (provider === "ollama") return "";
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ?? "";
  }
  return process.env.OPENAI_API_KEY ?? "";
}

export interface CliFlags {
  model?: string;
  provider?: string;
  baseUrl?: string;
  verbose?: boolean;
  enableHandover?: boolean;
  prompt?: string;
  help?: boolean;
}

/** Parse CLI arguments into flags + positional prompt. */
export function parseArgs(args: string[]): CliFlags {
  const flags: CliFlags = {};
  let i = 0;
  const positional: string[] = [];

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      i++;
    } else if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
      i++;
    } else if (arg === "--enable-handover") {
      flags.enableHandover = true;
      i++;
    } else if ((arg === "--model" || arg === "-m") && i + 1 < args.length) {
      flags.model = args[++i];
      i++;
    } else if ((arg === "--provider" || arg === "-p") && i + 1 < args.length) {
      flags.provider = args[++i];
      i++;
    } else if ((arg === "--base-url" || arg === "-b") && i + 1 < args.length) {
      flags.baseUrl = args[++i];
      i++;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
      i++;
    }
  }

  if (positional.length > 0) {
    flags.prompt = positional.join(" ");
  }

  return flags;
}

/** Resolve final config from env + CLI flags. */
export function resolveConfig(flags: CliFlags): Config {
  const model = flags.model ?? process.env.NAV_MODEL ?? "gpt-4o";

  const providerStr = flags.provider ?? process.env.NAV_PROVIDER;
  const provider: Provider = providerStr
    ? (providerStr as Provider)
    : detectProvider(model);

  const baseUrl =
    flags.baseUrl ?? process.env.NAV_BASE_URL ?? detectBaseUrl(provider, model);

  const apiKey = findApiKey(provider);

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    verbose: flags.verbose ?? false,
    enableHandover: flags.enableHandover ?? false,
    cwd: process.cwd(),
  };
}

export const HELP_TEXT = `
nav — minimalist coding agent

Usage:
  nav                         Interactive mode
  nav "fix the bug"           One-shot mode
  nav -m claude-sonnet-4-20250514 "task"  Use specific model

Flags:
  -m, --model <name>     Model name (default: gpt-4o, env: NAV_MODEL)
  -p, --provider <name>  Provider: openai | anthropic | ollama (auto-detected)
  -b, --base-url <url>   API base URL (env: NAV_BASE_URL)
  -v, --verbose          Show diffs, tokens, timing
  --enable-handover      Enable handover mode for context management
  -h, --help             Show this help

Environment:
  NAV_MODEL              Default model
  NAV_PROVIDER           Default provider
  NAV_API_KEY            API key (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
  NAV_BASE_URL           API base URL
`.trim();
