/**
 * Configuration — resolved from CLI flags, env vars, and config files.
 *
 * Priority (highest to lowest):
 *   1. CLI flags
 *   2. Environment variables
 *   3. Project config:  <cwd>/.nav/nav.config.json
 *   4. User config:     ~/.config/nav/nav.config.json
 *   5. Auto-detection / defaults
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Provider = "openai" | "anthropic" | "ollama" | "google";

export interface Config {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  verbose: boolean;
  sandbox: boolean;
  cwd: string;
  /** Context window size in tokens (auto-detected or user-supplied). */
  contextWindow?: number;
  /** Fraction of context window that triggers auto-handover (0–1, default 0.8). */
  handoverThreshold: number;
}

/** Known local model name patterns (for Ollama auto-detection). */
const LOCAL_MODEL_PATTERNS = ["llama", "mistral", "qwen", "gemma", "phi", "deepseek", "codellama", "vicuna", "wizardcoder", "starcoder", "yi"];

/** Default auto-handover threshold (fraction of context window). */
const DEFAULT_HANDOVER_THRESHOLD = 0.8;

/**
 * Context window sizes for well-known models (in tokens).
 * Used as a fallback when the provider API doesn't report context size.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4-turbo-preview": 128_000,
  "gpt-4": 8_192,
  "gpt-4-32k": 32_768,
  "gpt-3.5-turbo": 16_385,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o1-preview": 128_000,
  "o3": 200_000,
  "o3-mini": 200_000,
  // Anthropic
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-3-7-sonnet-20250219": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  // Google Gemini
  "gemini-3-flash-preview": 1_000_000,
  "gemini-3-pro-preview": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-pro": 2_000_000,
};

/**
 * Look up context window size for a model.
 * Tries exact match first, then pattern matching for model families.
 */
export function getKnownContextWindow(model: string): number | undefined {
  // Exact match
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];

  const m = model.toLowerCase();

  // All Claude 3+ models: 200K
  if (m.startsWith("claude-")) return 200_000;

  // GPT-4o variants (gpt-4o, gpt-4o-2024-08-06, etc.)
  if (m.startsWith("gpt-4o")) return 128_000;

  // GPT-4 turbo / GPT-4.1 variants
  if (m.startsWith("gpt-4-turbo") || m.startsWith("gpt-4.1") || m.startsWith("gpt-4-1")) return 128_000;

  // o1/o3 model families
  if (m.startsWith("o1") || m.startsWith("o3")) return 200_000;

  // Gemini 3 models: 1M tokens
  if (m.startsWith("gemini-3")) return 1_000_000;

  // Gemini 2.5 models: 1M-2M tokens depending on variant
  if (m.startsWith("gemini-2.5-pro")) return 2_000_000;
  if (m.startsWith("gemini-2.5")) return 1_000_000;

  return undefined;
}

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
  // Gemini models → google
  if (m.includes("gemini")) {
    return "google";
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
  if (provider === "google") return undefined;
  if (provider === "ollama") return "http://127.0.0.1:11434";
  // OpenAI-compatible local models
  const m = model.toLowerCase();
  if (LOCAL_MODEL_PATTERNS.some((p) => m.includes(p))) {
    return "http://127.0.0.1:11434";
  }
  return undefined;
}

/** Find API key from environment, with optional config file fallback. */
export function findApiKey(provider: Provider, fileApiKey?: string): string {
  const explicit = process.env.NAV_API_KEY;
  if (explicit) return explicit;

  // Config file API key sits between NAV_API_KEY and provider-specific env vars
  if (fileApiKey) return fileApiKey;

  if (provider === "ollama") return "";
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ?? "";
  }
  if (provider === "google") {
    return process.env.GEMINI_API_KEY ?? "";
  }
  return process.env.OPENAI_API_KEY ?? "";
}

// ── Config file support ────────────────────────────────────────────

/** Shape of nav.config.json — all fields optional. */
export interface ConfigFileValues {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  verbose?: boolean;
  sandbox?: boolean;
  contextWindow?: number;
  handoverThreshold?: number;
  theme?: string;
}

const KNOWN_CONFIG_KEYS = new Set<string>([
  "model", "provider", "baseUrl", "apiKey", "verbose",
  "sandbox", "contextWindow", "handoverThreshold", "theme",
]);

/** Load and validate a single nav.config.json file. Returns empty object if missing/invalid. */
export function loadConfigFile(path: string): ConfigFileValues {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const json = JSON.parse(raw);
    if (typeof json !== "object" || json === null || Array.isArray(json)) return {};

    const result: ConfigFileValues = {};
    for (const [key, value] of Object.entries(json)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        console.warn(`nav.config.json: unknown key "${key}" in ${path}`);
        continue;
      }
      (result as Record<string, unknown>)[key] = value;
    }
    return result;
  } catch (err) {
    console.warn(`nav.config.json: failed to load ${path}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Load config files from both locations and merge (project over home).
 * Returns a single merged ConfigFileValues.
 */
export function loadConfigFiles(cwd: string): ConfigFileValues {
  const home = homedir();
  const homeConfig = loadConfigFile(join(home, ".config", "nav", "nav.config.json"));
  const projectConfig = loadConfigFile(join(cwd, ".nav", "nav.config.json"));
  return { ...homeConfig, ...projectConfig };
}

// ── CLI flags ──────────────────────────────────────────────────────

export interface CliFlags {
  model?: string;
  provider?: string;
  baseUrl?: string;
  verbose?: boolean;
  sandbox?: boolean;
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
    } else if (arg === "--sandbox" || arg === "-s") {
      flags.sandbox = true;
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

/**
 * Resolve final config.
 * Priority: CLI flags → env vars → project config file → user config file → defaults.
 *
 * Pass pre-loaded file values to avoid loading twice (e.g. when theme needs
 * to be applied before config resolution).
 */
export function resolveConfig(flags: CliFlags, file?: ConfigFileValues): Config {
  const cwd = process.cwd();
  if (!file) file = loadConfigFiles(cwd);

  const model = flags.model ?? process.env.NAV_MODEL ?? file.model ?? "gpt-4o";

  const providerStr = flags.provider ?? process.env.NAV_PROVIDER ?? file.provider;
  const provider: Provider = providerStr
    ? (providerStr as Provider)
    : detectProvider(model);

  const baseUrl =
    flags.baseUrl ?? process.env.NAV_BASE_URL ?? file.baseUrl ?? detectBaseUrl(provider, model);

  const apiKey = findApiKey(provider, file.apiKey);

  const envSandbox = process.env.NAV_SANDBOX === "1" || process.env.NAV_SANDBOX === "true";
  const sandbox = flags.sandbox ?? (envSandbox || (file.sandbox ?? false));

  // Context window: CLI (N/A) → env → file → known model lookup → undefined (detect later)
  const envCtxWindow = process.env.NAV_CONTEXT_WINDOW;
  const contextWindow = envCtxWindow
    ? parseInt(envCtxWindow, 10)
    : file.contextWindow ?? getKnownContextWindow(model);

  // Handover threshold: env → file → default 0.8
  const envThreshold = process.env.NAV_HANDOVER_THRESHOLD;
  const handoverThreshold = envThreshold
    ? Math.max(0, Math.min(1, parseFloat(envThreshold)))
    : file.handoverThreshold ?? DEFAULT_HANDOVER_THRESHOLD;

  // Verbose: CLI → env (N/A, no env var) → file → false
  const verbose = flags.verbose ?? file.verbose ?? false;

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    verbose,
    sandbox: !!sandbox,
    cwd,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : undefined,
    handoverThreshold,
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
  -p, --provider <name>  Provider: openai | anthropic | ollama | google (auto-detected)
  -b, --base-url <url>   API base URL (env: NAV_BASE_URL)
  -s, --sandbox          Run in sandbox (macOS seatbelt, env: NAV_SANDBOX)
  -v, --verbose          Show diffs, tokens, timing
  -h, --help             Show this help

Environment:
  NAV_MODEL              Default model
  NAV_PROVIDER           Default provider
  NAV_API_KEY            API key (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)
  NAV_BASE_URL           API base URL
  NAV_SANDBOX            Enable sandbox (1 or true)
  NAV_CONTEXT_WINDOW     Context window size in tokens (auto-detected for known models)
  NAV_HANDOVER_THRESHOLD Auto-handover threshold 0-1 (default: 0.8 = 80% of context)

Config files (JSON, all fields optional):
  .nav/nav.config.json         Project-level config (highest file priority)
  ~/.config/nav/nav.config.json  User-level config

  Priority: CLI flags > env vars > project config > user config > defaults

  Keys: model, provider, baseUrl, apiKey, verbose, sandbox,
        contextWindow, handoverThreshold, theme

Custom commands:
  .nav/commands/*.md              Project-level custom commands
  ~/.config/nav/commands/*.md     User-level custom commands
`.trim();
