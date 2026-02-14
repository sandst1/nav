/**
 * Theme — color palette for terminal output.
 *
 * Default "nordic" palette uses truecolor (24-bit) ANSI codes inspired by
 * a Finnish winter dusk: lavender sky, dusky rose horizon, warm moon gold.
 *
 * Set NAV_THEME=classic for standard 16-color ANSI.
 */

// ANSI modifiers (theme-independent)
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";

// Truecolor helper
const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

interface Palette {
  brand: string;
  prompt: string;
  tool: string;
  success: string;
  error: string;
  warning: string;
  text: string;
  dim: string;
  diffAdd: string;
  diffRemove: string;
  diffHunk: string;
}

const nordic: Palette = {
  brand:      rgb(180, 160, 210),  // Soft lavender — mid sky
  prompt:     rgb(210, 160, 180),  // Dusky rose — horizon
  tool:       rgb(140, 160, 190),  // Muted slate blue — upper sky
  success:    rgb(140, 190, 140),  // Sage green
  error:      rgb(200, 120, 120),  // Muted rose
  warning:    rgb(220, 200, 130),  // Warm gold — moon
  text:       rgb(230, 225, 235),  // Soft warm white — snow
  dim:        rgb(120, 115, 130),  // Cool gray — shadows
  diffAdd:    rgb(140, 190, 140),  // Soft green
  diffRemove: rgb(190, 130, 130),  // Soft rose
  diffHunk:   rgb(150, 170, 200),  // Pale blue — upper sky
};

const classic: Palette = {
  brand:      "\x1b[36m",   // Cyan
  prompt:     "\x1b[36m",   // Cyan
  tool:       "\x1b[35m",   // Magenta
  success:    "\x1b[32m",   // Green
  error:      "\x1b[31m",   // Red
  warning:    "\x1b[33m",   // Yellow
  text:       "\x1b[37m",   // White
  dim:        "\x1b[90m",   // Bright black (gray)
  diffAdd:    "\x1b[32m",   // Green
  diffRemove: "\x1b[31m",   // Red
  diffHunk:   "\x1b[36m",   // Cyan
};

/** Resolve theme by name. Falls back to nordic. */
export function resolveTheme(name?: string): Palette {
  return name?.toLowerCase() === "classic" ? classic : nordic;
}

// Default: resolve from env. Can be overridden via setTheme() after config file load.
export let theme: Palette = resolveTheme(process.env.NAV_THEME);

/** Override the active theme (call after config file resolution). */
export function setTheme(name: string): void {
  theme = resolveTheme(name);
}
