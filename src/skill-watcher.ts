/**
 * Watch skill directories for changes.
 *
 * Uses fs.watch (event-driven, not polling) to detect when SKILL.md files
 * are added, modified, or removed. Sets a flag that the main loop checks
 * after each agent turn to reload skills if needed.
 */

import { watch, existsSync, mkdirSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class SkillWatcher {
  private watchers: FSWatcher[] = [];
  private _needsReload = false;

  /** True if skills have changed since last check. */
  get needsReload(): boolean {
    return this._needsReload;
  }

  /** Reset the flag after reloading skills. */
  clearReloadFlag(): void {
    this._needsReload = false;
  }

  /** Start watching skill directories. */
  start(cwd: string): void {
    const dirs = [
      join(cwd, ".nav", "skills"),
      join(cwd, ".claude", "skills"),
      join(homedir(), ".config", "nav", "skills"),
    ];

    for (const dir of dirs) {
      // Ensure dir exists so we can watch it
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          continue; // Can't create, skip
        }
      }

      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          // Only care about SKILL.md changes
          if (filename?.endsWith("SKILL.md")) {
            this._needsReload = true;
          }
        });
        this.watchers.push(watcher);
      } catch {
        // Directory not watchable, skip
      }
    }
  }

  /** Stop all watchers. */
  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
  }
}
