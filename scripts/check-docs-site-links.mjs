#!/usr/bin/env node
// Post-build gate for the docs site: every href/src emitted into
// docs/.vitepress/dist must resolve to a built page or asset. VitePress's own
// dead-link check validates links against *source* files, so it cannot see a
// link that points at a page relocated by `rewrites` (e.g. developer/README
// vs the emitted /developer/). This check validates the shipped artifact.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { posix } from "node:path";

const dist = process.argv[2] ?? "docs/.vitepress/dist";

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const files = [...walk(dist)];
const emitted = new Set(files.map((f) => "/" + relative(dist, f).split(sep).join("/")));

const SKIP = /^(?:[a-z][a-z0-9+.-]*:|#)/i;
const failures = [];
let checked = 0;

for (const file of files) {
  if (!file.endsWith(".html")) continue;
  const pageRoute = "/" + relative(dist, file).split(sep).join("/");
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    const raw = match[1];
    if (raw === "" || SKIP.test(raw)) continue;
    const target = raw.split("#")[0].split("?")[0];
    if (target === "") continue;
    const resolved = target.startsWith("/")
      ? posix.normalize(target)
      : posix.normalize(posix.join(posix.dirname(pageRoute), target));
    const candidates = [
      resolved,
      `${resolved}.html`,
      resolved.endsWith("/") ? `${resolved}index.html` : `${resolved}/index.html`,
    ];
    checked += 1;
    if (!candidates.some((c) => emitted.has(c))) {
      failures.push(`${pageRoute} -> ${raw}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`docs site link check FAILED: ${failures.length} unresolved reference(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`docs site link check passed: ${checked} references resolve across ${emitted.size} emitted files.`);
