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
import { parseHooksConfig, DEFAULT_HOOK_TIMEOUT_MS, type HooksConfig } from "./hooks";
import { NAV_TOOL_NAMES, isKnownNavToolName } from "./tool-names";

/** Default max full work+verification cycles per task in /tasks run and /plans run. */
export const DEFAULT_TASK_IMPLEMENTATION_MAX_ATTEMPTS = 3;

/** Default max concurrent tool executions per assistant turn (sequential). */
export const DEFAULT_PARALLEL_TOOL_CALLS = 1;
/** Upper bound for `parallelToolCalls` from config or env. */
export const MAX_PARALLEL_TOOL_CALLS = 32;

export type Provider = "openai" | "anthropic" | "ollama" | "google" | "azure";

/** How the agent reads files and applies edits. Default: hashline anchors. */
export type EditMode = "hashline" | "searchReplace";

export type { HooksConfig } from "./hooks";

/** Normalize `editMode` from config JSON; invalid values warn and fall back to hashline. */
export function parseEditMode(raw: unknown): EditMode {
  if (raw === undefined || raw === null) return "hashline";
  if (raw === "hashline" || raw === "searchReplace") return raw;
  console.warn(
    `nav.config.json: invalid editMode ${JSON.stringify(raw)} (expected "hashline" or "searchReplace"), using "hashline"`,
  );
  return "hashline";
}

/**
 * Parse `parallelToolCalls` from config file JSON. Invalid or out-of-range values warn and clamp.
 */
export function parseParallelToolCallsFromFile(raw: unknown, pathLabel: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let n: number;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    n = Math.floor(raw);
  } else if (typeof raw === "string" && raw.trim() !== "") {
    n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n)) {
      console.warn(
        `nav.config.json: invalid parallelToolCalls ${JSON.stringify(raw)} in ${pathLabel}, using default ${DEFAULT_PARALLEL_TOOL_CALLS}`,
      );
      return undefined;
    }
    n = Math.floor(n);
  } else {
    console.warn(
      `nav.config.json: invalid parallelToolCalls (expected positive integer) in ${pathLabel}, using default ${DEFAULT_PARALLEL_TOOL_CALLS}`,
    );
    return undefined;
  }
  if (n < 1) {
    console.warn(
      `nav.config.json: parallelToolCalls must be >= 1 in ${pathLabel}, using ${DEFAULT_PARALLEL_TOOL_CALLS}`,
    );
    return DEFAULT_PARALLEL_TOOL_CALLS;
  }
  if (n > MAX_PARALLEL_TOOL_CALLS) {
    console.warn(
      `nav.config.json: parallelToolCalls ${n} exceeds max ${MAX_PARALLEL_TOOL_CALLS} in ${pathLabel}, clamping`,
    );
    return MAX_PARALLEL_TOOL_CALLS;
  }
  return n;
}

/**
 * Apply conservative limits for delegated subagent runs.
 * Nested runs should execute tools sequentially for determinism and lower blast radius.
 */
export function withSubagentNestedToolLimits(cfg: Config): Config {
  return {
    ...cfg,
    parallelToolCalls: 1,
  };
}

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
  /** Ollama num_batch option (default 1024). */
  ollamaBatchSize: number;
  /** Azure OpenAI deployment name (falls back to model if not set). */
  azureDeployment?: string;
  /** Optional lifecycle hooks (stop, taskDone, planDone). */
  hooks?: HooksConfig;
  /** Max wall time per shell hook step (ms). Default: 10 minutes. */
  hookTimeoutMs: number;
  /**
   * Max full implementation cycles per task (each: agent work + taskDone hooks).
   * When exhausted after hook failure, the task work loop stops. Default: 3.
   */
  taskImplementationMaxAttempts: number;
  /** File read format and edit tool semantics. */
  editMode: EditMode;
  /**
   * Max tool calls from a single assistant message that may run concurrently (worker pool).
   * Default 1 (sequential).
   */
  parallelToolCalls: number;
  /**
   * When set, only these tool names are exposed to the LLM (and prompt is trimmed).
   * Omitted or undefined means all built-in tools including `subagent`.
   */
  allowedTools?: string[];
  /**
   * Parsed `subagent` block from nav.config.json.
   * `undefined` means the key was absent — delegated agents use main settings for every field.
   * Present (even `{}`) means per-field overlay in {@link resolveSubagentRuntimeConfig}.
   */
  subagentFileDefaults?: SubagentFileValues;
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
  if (provider === "azure") {
    return process.env.AZURE_OPENAI_API_KEY ?? "";
  }
  return process.env.OPENAI_API_KEY ?? "";
}

// ── Config file support ────────────────────────────────────────────

/** Optional defaults for delegated subagent runs (nav.config.json `subagent` object). */
export interface SubagentFileValues {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  azureDeployment?: string;
  ollamaBatchSize?: number;
  contextWindow?: number;
  handoverThreshold?: number;
  /** Max concurrent tool calls for delegated runs; omitted -> inherit parent. */
  parallelToolCalls?: number;
  /** Whether delegated subagents may call `subagent` recursively. Default false. */
  allowNestedSubagents?: boolean;
  /** Allowlist for subagent LLM only; omitted → use parent's {@link Config.allowedTools}. */
  tools?: string[];
}

const SUBAGENT_FILE_KEYS = new Set([
  "model",
  "provider",
  "baseUrl",
  "apiKey",
  "azureDeployment",
  "ollamaBatchSize",
  "contextWindow",
  "handoverThreshold",
  "parallelToolCalls",
  "allowNestedSubagents",
  "tools",
]);

/** Parse and validate `tools` array from config JSON. */
export function normalizeAllowedToolsList(raw: unknown, warnLabel: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(`nav.config.json: ${warnLabel} must be an array of tool name strings, ignoring`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name) continue;
    if (!isKnownNavToolName(name)) {
      console.warn(`nav.config.json: unknown tool name ${JSON.stringify(name)} in ${warnLabel}, skipping`);
      continue;
    }
    out.push(name);
  }
  return out;
}

/**
 * Enforce nested-subagent policy on delegated tool allowlists.
 * - `allowNested=true`: keep allowlist as-is.
 * - `allowNested=false`: remove `subagent`; if tools are undefined, expand to explicit defaults
 *   without `subagent` and `ask_user`.
 */
export function applySubagentNestedPolicy(
  parentAllowedTools: string[] | undefined,
  allowNested: boolean,
): string[] | undefined {
  if (allowNested) return parentAllowedTools;
  if (parentAllowedTools === undefined) {
    return NAV_TOOL_NAMES.filter((name) => name !== "subagent" && name !== "ask_user");
  }
  return parentAllowedTools.filter((name) => name !== "subagent");
}

/** Parse `subagent` object from config file. */
export function parseSubagentFileValues(raw: unknown, path: string): SubagentFileValues | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`nav.config.json: "subagent" must be an object in ${path}, ignoring`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: SubagentFileValues = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!SUBAGENT_FILE_KEYS.has(key)) {
      console.warn(`nav.config.json: unknown subagent key "${key}" in ${path}, skipping`);
      continue;
    }
    if (key === "tools") {
      const list = normalizeAllowedToolsList(value, "subagent.tools");
      if (list !== undefined) out.tools = list;
      continue;
    }
    if (key === "parallelToolCalls") {
      const parsed = parseParallelToolCallsFromFile(value, `subagent.parallelToolCalls (${path})`);
      if (parsed !== undefined) out.parallelToolCalls = parsed;
      continue;
    }
    if (key === "allowNestedSubagents") {
      if (typeof value === "boolean") {
        out.allowNestedSubagents = value;
      } else {
        console.warn(`nav.config.json: subagent.allowNestedSubagents must be boolean in ${path}, ignoring`);
      }
      continue;
    }
    if (
      key === "ollamaBatchSize" ||
      key === "contextWindow"
    ) {
      if (typeof value === "number" && Number.isFinite(value)) {
        (out as Record<string, number>)[key] = value;
      } else if (typeof value === "string" && value.trim() !== "") {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) (out as Record<string, number>)[key] = n;
      }
      continue;
    }
    if (key === "handoverThreshold") {
      if (typeof value === "number" && Number.isFinite(value)) {
        out.handoverThreshold = value;
      } else if (typeof value === "string" && value.trim() !== "") {
        const n = parseFloat(value);
        if (Number.isFinite(n)) out.handoverThreshold = n;
      }
      continue;
    }
    if (typeof value === "string") {
      (out as Record<string, string>)[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : {};
}

/**
 * Merge parent config with optional `subagent` file block for a delegated run.
 * Parent fields (cwd, sandbox, verbose, hooks, editMode, etc.) are always inherited.
 * LLM fields (`model`, `provider`, `baseUrl`, `contextWindow`, …) use each subagent key
 * only when set; unset keys keep the parent's resolved values (no re-detection from `model` alone).
 */
export function resolveSubagentRuntimeConfig(
  parent: Config,
  subagentDefaults: SubagentFileValues | undefined,
): Config {
  if (!subagentDefaults) return parent;

  const model = subagentDefaults.model ?? parent.model;
  const provider: Provider =
    subagentDefaults.provider !== undefined
      ? (subagentDefaults.provider as Provider)
      : parent.provider;

  const baseUrl =
    subagentDefaults.baseUrl !== undefined ? subagentDefaults.baseUrl : parent.baseUrl;

  const apiKey =
    subagentDefaults.apiKey !== undefined
      ? findApiKey(provider, subagentDefaults.apiKey)
      : provider === parent.provider
        ? parent.apiKey
        : findApiKey(provider, undefined);

  const azureDeployment =
    provider === "azure"
      ? (subagentDefaults.azureDeployment ?? parent.azureDeployment)
      : undefined;

  const contextWindow =
    subagentDefaults.contextWindow !== undefined && subagentDefaults.contextWindow > 0
      ? subagentDefaults.contextWindow
      : parent.contextWindow;

  const handoverThreshold =
    subagentDefaults.handoverThreshold !== undefined
      ? Math.max(0, Math.min(1, subagentDefaults.handoverThreshold))
      : parent.handoverThreshold;

  const ollamaBatchSize =
    subagentDefaults.ollamaBatchSize !== undefined && subagentDefaults.ollamaBatchSize > 0
      ? Math.floor(subagentDefaults.ollamaBatchSize)
      : parent.ollamaBatchSize;

  const allowedTools =
    subagentDefaults.tools !== undefined ? subagentDefaults.tools : parent.allowedTools;
  const parallelToolCalls =
    subagentDefaults.parallelToolCalls !== undefined
      ? subagentDefaults.parallelToolCalls
      : parent.parallelToolCalls;

  return {
    ...parent,
    provider,
    model,
    apiKey,
    baseUrl,
    azureDeployment,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : undefined,
    handoverThreshold,
    ollamaBatchSize,
    allowedTools,
    parallelToolCalls,
  };
}

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
  ollamaBatchSize?: number;
  theme?: string;
  azureDeployment?: string;
  /** Raw hooks object — validated in resolveConfig. */
  hooks?: unknown;
  hookTimeoutMs?: number;
  taskImplementationMaxAttempts?: number;
  editMode?: string;
  /** Allowlist of tool names for the main agent. */
  tools?: unknown;
  /** Per-field defaults for delegated subagent runs. */
  subagent?: unknown;
  /** Max concurrent tool calls per assistant turn (default 1). */
  parallelToolCalls?: number;
}

const KNOWN_CONFIG_KEYS = new Set<string>([
  "model", "provider", "baseUrl", "apiKey", "verbose",
  "sandbox", "contextWindow", "handoverThreshold", "ollamaBatchSize", "theme",
  "azureDeployment", "hooks", "hookTimeoutMs", "taskImplementationMaxAttempts",
  "editMode", "tools", "subagent", "parallelToolCalls",
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
      if (key.startsWith("_")) continue; // metadata/comment keys — silently skip
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

/** Known top-level subcommands (not flags, not prompts). */
const SUBCOMMANDS = new Set(["config-init", "ui-server"]);

export interface CliFlags {
  model?: string;
  provider?: string;
  baseUrl?: string;
  verbose?: boolean;
  sandbox?: boolean;
  prompt?: string;
  help?: boolean;
  subcommand?: string;
  uiHost?: string;
  uiPort?: number;
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
    } else if (arg === "--ui-host" && i + 1 < args.length) {
      flags.uiHost = args[++i];
      i++;
    } else if (arg === "--ui-port" && i + 1 < args.length) {
      flags.uiPort = parseInt(args[++i]!, 10);
      i++;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else if (SUBCOMMANDS.has(arg) && positional.length === 0) {
      flags.subcommand = arg;
      i++;
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

/** Compute effective sandbox flag: CLI → env → config file → false. */
export function effectiveSandbox(cliSandbox?: boolean, fileSandbox?: boolean): boolean {
  const envSandbox = process.env.NAV_SANDBOX === "1" || process.env.NAV_SANDBOX === "true";
  return !!(cliSandbox ?? (envSandbox || (fileSandbox ?? false)));
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

  const model = flags.model ?? process.env.NAV_MODEL ?? file.model ?? "gpt-4.1";

  const providerStr = flags.provider ?? process.env.NAV_PROVIDER ?? file.provider;
  const provider: Provider = providerStr
    ? (providerStr as Provider)
    : detectProvider(model);

  const baseUrl =
    flags.baseUrl ?? process.env.NAV_BASE_URL
    ?? (provider === "azure" ? process.env.AZURE_OPENAI_API_BASE_URL : undefined)
    ?? file.baseUrl ?? detectBaseUrl(provider, model);

  const apiKey = findApiKey(provider, file.apiKey);

  const azureDeployment = provider === "azure"
    ? (process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? file.azureDeployment)
    : undefined;

  const sandbox = effectiveSandbox(flags.sandbox, file.sandbox);

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

  // Ollama batch size: env → file → default 1024
  const envBatchSize = process.env.NAV_OLLAMA_BATCH_SIZE;
  const ollamaBatchSize = envBatchSize
    ? parseInt(envBatchSize, 10)
    : file.ollamaBatchSize ?? 1024;

  const hooks = parseHooksConfig(file.hooks);
  const envHookTimeout = process.env.NAV_HOOK_TIMEOUT_MS;
  const hookTimeoutMs =
    envHookTimeout
      ? Math.max(1000, parseInt(envHookTimeout, 10) || DEFAULT_HOOK_TIMEOUT_MS)
      : file.hookTimeoutMs !== undefined && file.hookTimeoutMs > 0
        ? file.hookTimeoutMs
        : DEFAULT_HOOK_TIMEOUT_MS;

  const envTaskImpl = process.env.NAV_TASK_IMPLEMENTATION_MAX_ATTEMPTS;
  const taskImplementationMaxAttempts = envTaskImpl
    ? Math.max(1, parseInt(envTaskImpl, 10) || DEFAULT_TASK_IMPLEMENTATION_MAX_ATTEMPTS)
    : file.taskImplementationMaxAttempts !== undefined && file.taskImplementationMaxAttempts > 0
      ? Math.max(1, Math.floor(file.taskImplementationMaxAttempts))
      : DEFAULT_TASK_IMPLEMENTATION_MAX_ATTEMPTS;

  const editMode = parseEditMode(file.editMode);

  const allowedTools = normalizeAllowedToolsList(file.tools, "tools");
  const subagentParsed = parseSubagentFileValues(file.subagent, "nav.config.json");
  const subagentFileDefaults =
    file.subagent !== undefined && file.subagent !== null
      ? subagentParsed ?? {}
      : undefined;

  const envParallel = process.env.NAV_PARALLEL_TOOL_CALLS;
  let parallelToolCalls = DEFAULT_PARALLEL_TOOL_CALLS;
  if (envParallel !== undefined && envParallel.trim() !== "") {
    const n = parseInt(envParallel.trim(), 10);
    if (Number.isFinite(n) && n >= 1) {
      parallelToolCalls = Math.min(MAX_PARALLEL_TOOL_CALLS, Math.floor(n));
      if (Math.floor(n) !== n || n > MAX_PARALLEL_TOOL_CALLS) {
        console.warn(
          `NAV_PARALLEL_TOOL_CALLS: value ${JSON.stringify(envParallel)} clamped to ${parallelToolCalls} (max ${MAX_PARALLEL_TOOL_CALLS})`,
        );
      }
    } else {
      console.warn(
        `NAV_PARALLEL_TOOL_CALLS: invalid ${JSON.stringify(envParallel)}, using ${DEFAULT_PARALLEL_TOOL_CALLS}`,
      );
    }
  } else {
    const fromFile = parseParallelToolCallsFromFile(file.parallelToolCalls, "nav.config.json");
    if (fromFile !== undefined) parallelToolCalls = fromFile;
  }

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
    ollamaBatchSize,
    azureDeployment,
    hooks,
    hookTimeoutMs,
    taskImplementationMaxAttempts,
    editMode,
    parallelToolCalls,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(subagentFileDefaults !== undefined ? { subagentFileDefaults } : {}),
  };
}

export const HELP_TEXT = `
nav — minimalist coding agent

Usage:
  nav                         Interactive mode
  nav "fix the bug"           One-shot mode
  nav -m claude-sonnet-4-20250514 "task"  Use specific model
  nav config-init             Create .nav/nav.config.json in the current project
  nav ui-server               Run websocket/http server for desktop UI

Flags:
  -m, --model <name>     Model name (default: gpt-4.1, env: NAV_MODEL)
  -p, --provider <name>  Provider: openai | anthropic | ollama | google | azure (auto-detected)
  -b, --base-url <url>   API base URL (env: NAV_BASE_URL)
      --ui-host <host>   UI server host (for ui-server, default: 127.0.0.1)
      --ui-port <port>   UI server port (for ui-server, default: 7777)
  -s, --sandbox          Run in sandbox (macOS seatbelt, env: NAV_SANDBOX)
  -v, --verbose          Show diffs, tokens, timing
  -h, --help             Show this help

Environment:
  NAV_MODEL              Default model
  NAV_PROVIDER           Default provider
  NAV_API_KEY            API key (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)
  NAV_BASE_URL           API base URL
  NAV_PARALLEL_TOOL_CALLS Max concurrent tool calls per assistant turn (1–32, overrides config file)
  NAV_SANDBOX            Enable sandbox (1 or true)
  NAV_UI_HOST            UI server host (for ui-server mode)
  NAV_UI_PORT            UI server port (for ui-server mode)
  NAV_CONTEXT_WINDOW     Context window size in tokens (auto-detected for known models)
  NAV_OLLAMA_BATCH_SIZE  Ollama num_batch option (default: 1024)
  NAV_HANDOVER_THRESHOLD Auto-handover threshold 0-1 (default: 0.8 = 80% of context)
  NAV_HOOK_TIMEOUT_MS  Shell hook step timeout in milliseconds (default: 600000)
  NAV_TASK_IMPLEMENTATION_MAX_ATTEMPTS  Full work+verify cycles per task in task/plan runs (default: 3)

  Azure OpenAI:
  AZURE_OPENAI_API_KEY           Azure API key
  AZURE_OPENAI_API_BASE_URL      Azure endpoint (e.g. https://my-resource.openai.azure.com/openai/v1)
  AZURE_OPENAI_DEPLOYMENT_NAME   Deployment name

Config files (JSON, all fields optional):
  .nav/nav.config.json         Project-level config (highest file priority)
  ~/.config/nav/nav.config.json  User-level config

  Priority: CLI flags > env vars > project config > user config > defaults

  Keys: model, provider, baseUrl, apiKey, verbose, sandbox,
        contextWindow, handoverThreshold, theme, hooks, hookTimeoutMs,
        taskImplementationMaxAttempts, editMode, tools, subagent

  Run \`nav config-init\` to create a project config with defaults.

Custom commands:
  .nav/commands/*.md              Project-level custom commands
  ~/.config/nav/commands/*.md     User-level custom commands
`.trim();
