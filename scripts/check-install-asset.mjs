#!/usr/bin/env node
// The hosted installer is a static docs-site asset. Keep it byte-for-byte equal
// to the repository bootstrap script so jobctrl.dev/install.sh is not a fork.
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
