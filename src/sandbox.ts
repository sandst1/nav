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
import { existsSync, realpathSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";

const SANDBOXED_ENV = "NAV_SANDBOXED";

// Embedded sandbox profile - used when running as compiled binary
const SANDBOX_PROFILE = `;; nav — permissive seatbelt sandbox profile
;;
;; Allow everything by default, restrict file writes to the project directory,
;; temp directory, and Darwin user cache. Network is unrestricted (needed for
;; LLM API calls). All child processes inherit these restrictions.
;;
;; Usage:
;;   sandbox-exec -D PROJECT_DIR=/path/to/project \\
;;                -D TMP_DIR=/private/tmp \\
;;                -D CACHE_DIR=/var/folders/xx/... \\
;;                -f nav-permissive.sb \\
;;                bun /path/to/nav/src/index.ts ...

(version 1)

;; Start permissive — allow everything by default
(allow default)

;; Deny all file writes, then whitelist specific paths
(deny file-write*)

(allow file-write*
  ;; Project working directory (read + write)
  (subpath (param "PROJECT_DIR"))

  ;; Temp and cache directories (many tools need these)
  (subpath (param "TMP_DIR"))
  (subpath (param "CACHE_DIR"))

  ;; Standard output devices
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null")
  (literal "/dev/tty")
)
`;

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
  let profilePath: string;
  let tempProfile = false;

  // Try to find the profile file in the source tree first (for development)
  const sourceProfilePath = resolve(
    dirname(import.meta.dir),
    "sandbox",
    "nav-permissive.sb",
  );

  if (existsSync(sourceProfilePath)) {
    // Running from source
    profilePath = sourceProfilePath;
  } else {
    // Running as compiled binary - write embedded profile to temp file
    profilePath = join(tmpdir(), `nav-sandbox-${process.pid}.sb`);
    try {
      writeFileSync(profilePath, SANDBOX_PROFILE, "utf-8");
      tempProfile = true;
    } catch (err) {
      console.error(`sandbox: failed to write profile to ${profilePath}:`, err);
      process.exit(1);
    }
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
    process.execPath,        // bun binary or compiled executable
    ...process.argv.slice(2), // forward all args (skip execPath and script path)
  ];

  const result = spawnSync("sandbox-exec", args, {
    stdio: "inherit",
    env: { ...process.env, [SANDBOXED_ENV]: "1" },
  });

  // Clean up temp profile if we created one
  if (tempProfile) {
    try {
      unlinkSync(profilePath);
    } catch {
      // Ignore cleanup errors
    }
  }

  process.exit(result.status ?? 1);
}
