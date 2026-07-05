#!/usr/bin/env node
/**
 * Runtime regression gate for the built docs site.
 *
 * The static href gate cannot see client-side failures: `vitepress preview`
 * (sirv) snapshots the dist file list at boot, so a rebuild under a running
 * preview serves HTML whose hashed chunks 404 — every page then renders with
 * zero JavaScript: blank mermaid containers, no aria-current, no lightbox,
 * and no console errors. This script boots a FRESH preview of the current
 * dist on a free port and asserts, in a real browser:
 *   - zero failed or 404'd requests on every checked page;
 *   - every diagram page hydrates at least one `.mermaid svg`;
 *   - the sidebar marks exactly one link with aria-current="page";
 *   - Product Tour screenshots actually load pixels.
 *
 * Run after `pnpm docs:build`:  pnpm docs:check:runtime
 * (Requires the workspace's Playwright Chromium — installed via apps/web.)
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/web/package.json"));
const { chromium } = require("@playwright/test");

const PAGES = [
  { path: "/", mermaid: false, images: false },
  { path: "/architecture/", mermaid: true, images: false },
  { path: "/architecture/scoring", mermaid: true, images: false },
  { path: "/architecture/pipeline/operations", mermaid: true, images: false },
  { path: "/user/normal-flows", mermaid: true, images: true },
  { path: "/user/screenshots", mermaid: false, images: true },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const port = await freePort();
const preview = spawn(
  "corepack",
  ["pnpm", "exec", "vitepress", "preview", "docs", "--port", String(port)],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("preview did not boot in 30s")), 30000);
  preview.stdout.on("data", (d) => {
    if (String(d).includes("http")) {
      clearTimeout(timer);
      resolve();
    }
  });
  preview.on("exit", (code) => reject(new Error(`preview exited early (${code})`)));
});

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const badRequests = [];
  page.on("requestfailed", (r) => badRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => {
    if (r.status() >= 400) badRequests.push(`${r.url()} HTTP ${r.status()}`);
  });

  for (const spec of PAGES) {
    badRequests.length = 0;
    await page.goto(`http://127.0.0.1:${port}${spec.path}`, { waitUntil: "networkidle" });

    if (spec.mermaid) {
      const hydrated = await page
        .waitForFunction(() => document.querySelectorAll(".mermaid svg").length >= 1, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (!hydrated) fail(`${spec.path}: no .mermaid svg hydrated (blank diagram)`);
    }

    if (spec.path !== "/") {
      await page.waitForTimeout(200);
      const aria = await page.locator('.VPSidebar a[aria-current="page"]').count();
      if (aria !== 1) fail(`${spec.path}: expected exactly 1 aria-current sidebar link, found ${aria}`);
    }

    if (spec.images) {
      const broken = await page
        .locator(".vp-doc img")
        .evaluateAll((imgs) => imgs.filter((i) => !(i.complete && i.naturalWidth > 100)).length);
      if (broken > 0) fail(`${spec.path}: ${broken} content image(s) failed to load`);
    }

    if (badRequests.length > 0) {
      fail(`${spec.path}: ${badRequests.length} failed/4xx request(s), first: ${badRequests[0]}`);
    }
    if (failures === 0) console.log(`ok    ${spec.path}`);
  }
} finally {
  await browser.close();
  preview.kill("SIGTERM");
}

console.log(failures ? `DOCS RUNTIME CHECK FAIL — ${failures}` : "DOCS RUNTIME CHECK PASS");
process.exit(failures ? 1 : 0);
