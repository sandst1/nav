/**
 * macOS Seatbelt sandbox — re-exec nav under sandbox-exec with filesystem
 * write restrictions. All child processes (including shell commands) inherit
 * the sandbox policy.
 *
 * Flow:
 *   nav -s "task"
 *     → detectSandbox() finds sandbox-exec on macOS
 *     → execSandbox() re-launches:
 *         sandbox-exec -D PROJECT_DIR=... -f nav-permissive.sb bun nav -s "task"
 *       with NAV_SANDBOXED=1 in env
 *     → on the second launch, isAlreadySandboxed() returns true → skip re-exec
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname } from "path";

const SANDBOXED_ENV = "NAV_SANDBOXED";

/** Are we already running inside a sandbox? */
export function isAlreadySandboxed(): boolean {
  return process.env[SANDBOXED_ENV] === "1";
}

/** Is sandbox-exec available on this system? (macOS only) */
export function isSandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("which sandbox-exec", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-exec the current process under sandbox-exec. Does not return —
 * exits with the sandboxed child's exit code.
 */
export function execSandbox(): never {
  const profilePath = resolve(
    dirname(import.meta.dir),
    "sandbox",
    "nav-permissive.sb",
  );

  if (!existsSync(profilePath)) {
    console.error(`sandbox: profile not found: ${profilePath}`);
    process.exit(1);
  }

  // Resolve real paths for the -D parameters
  const projectDir = realpathSync(process.cwd());
  const tmpDir = realpathSync(tmpdir());

  let cacheDir: string;
  try {
    cacheDir = realpathSync(
      execSync("getconf DARWIN_USER_CACHE_DIR", { encoding: "utf-8" }).trim(),
    );
  } catch {
    cacheDir = tmpDir; // fallback
  }

  const args = [
    "-D", `PROJECT_DIR=${projectDir}`,
    "-D", `TMP_DIR=${tmpDir}`,
    "-D", `CACHE_DIR=${cacheDir}`,
    "-f", profilePath,
    // The command to run inside the sandbox
    process.execPath,        // bun binary
    ...process.argv.slice(1), // forward all original args
  ];

  const result = spawnSync("sandbox-exec", args, {
    stdio: "inherit",
    env: { ...process.env, [SANDBOXED_ENV]: "1" },
  });

  process.exit(result.status ?? 1);
}
