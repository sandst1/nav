#!/usr/bin/env bun
/**
 * Build standalone binaries for nav
 * Usage: bun run scripts/build.ts [platform]
 * Platform: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64
 */

import { $ } from "bun";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const platforms = {
  "darwin-arm64": { target: "bun-darwin-arm64", ext: "" },
  "darwin-x64": { target: "bun-darwin-x64", ext: "" },
  "linux-arm64": { target: "bun-linux-arm64", ext: "" },
  "linux-x64": { target: "bun-linux-x64", ext: "" },
  "windows-x64": { target: "bun-windows-x64", ext: ".exe" },
} as const;

type Platform = keyof typeof platforms;

async function build(platform: Platform) {
  const { target, ext } = platforms[platform];
  const outDir = join(import.meta.dir, "..", "dist");
  const outFile = join(outDir, `nav-${platform}${ext}`);

  console.log(`Building for ${platform}...`);
  
  // Ensure dist directory exists
  await mkdir(outDir, { recursive: true });

  // Build standalone binary
  await $`bun build src/index.ts --compile --target=${target} --outfile=${outFile}`;
  
  console.log(`✓ Built ${outFile}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Build for all platforms
    console.log("Building for all platforms...\n");
    for (const platform of Object.keys(platforms) as Platform[]) {
      await build(platform);
    }
    console.log("\n✓ All builds complete");
  } else {
    // Build for specified platform
    const platform = args[0] as Platform;
    if (!platforms[platform]) {
      console.error(`Unknown platform: ${platform}`);
      console.error(`Available platforms: ${Object.keys(platforms).join(", ")}`);
      process.exit(1);
    }
    await build(platform);
  }
}

main().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
