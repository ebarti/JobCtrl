#!/usr/bin/env node
// Keep the local fallback and release-script template byte-for-byte equal.
// Cloudflare Pages redirects the public path to the latest stable release asset.
import { readFileSync } from "node:fs";

const sourcePath = "scripts/get";
const hostedPath = "docs/public/install.sh";

const source = readFileSync(sourcePath, "utf8");
const hosted = readFileSync(hostedPath, "utf8");

if (source !== hosted) {
  console.error(`${hostedPath} is out of sync with ${sourcePath}.`);
  console.error(`Update ${sourcePath} first, then synchronize ${hostedPath}.`);
  process.exit(1);
}

console.log(`install asset check passed: ${hostedPath} matches ${sourcePath}.`);
