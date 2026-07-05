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

const BASE_VIEWPORT = { width: 1440, height: 1000 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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
  const page = await browser.newPage({ viewport: BASE_VIEWPORT });
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

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  const heroImage = await page.locator(".VPHome .VPHero img.image-src").boundingBox();
  if (!heroImage || heroImage.width < 420 || heroImage.y > BASE_VIEWPORT.height) {
    fail("/: product hero image is missing, too small, or below the first viewport");
  } else {
    console.log("ok    / hero image");
  }

  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, { waitUntil: "networkidle" });
  const tourSidebar = await page.locator(".VPSidebar").innerText();
  if (/Developer Guide|System Architecture|API|Reference/.test(tourSidebar)) {
    fail("/user/screenshots: user-guide sidebar still exposes developer/reference groups");
  }
  if (!/User Guide|Product Tour|Daily Workflow|Security/.test(tourSidebar)) {
    fail("/user/screenshots: user-guide sidebar hides the user navigation");
  }
  const tourImage = await page.locator(".vp-doc img").first().boundingBox();
  if (!tourImage || tourImage.width < 800) {
    fail(`/user/screenshots: first desktop screenshot is too narrow (${tourImage?.width ?? 0}px)`);
  } else {
    console.log("ok    /user/screenshots visual width");
  }

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, { waitUntil: "networkidle" });
  const mobileTourImage = await page.locator(".vp-doc img").first().boundingBox();
  if (!mobileTourImage || mobileTourImage.width < 700) {
    fail(`/user/screenshots mobile: screenshot did not remain inspectable (${mobileTourImage?.width ?? 0}px)`);
  }
  await page.locator("button.menu").click();
  await page.waitForTimeout(200);
  const mobileMenuText = await page.locator(".VPSidebar.open").innerText();
  if (/Developer Guide|System Architecture|API|Reference/.test(mobileMenuText)) {
    fail("/user/screenshots mobile: menu still exposes developer/reference groups");
  } else if (!/User Guide|Product Tour|Daily Workflow|Security/.test(mobileMenuText)) {
    fail("/user/screenshots mobile: menu hides the user navigation");
  } else {
    console.log("ok    /user/screenshots mobile menu");
  }

  await page.goto(`http://127.0.0.1:${port}/architecture/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".mermaid svg").length >= 1, { timeout: 15000 });
  const mobileDiagram = await page.locator(".mermaid svg").first().boundingBox();
  if (!mobileDiagram || mobileDiagram.width < 700) {
    fail(`/architecture mobile: inline diagram is still a tiny thumbnail (${mobileDiagram?.width ?? 0}px)`);
  }
  await page.locator(".vp-doc .mermaid").first().click();
  await page.waitForSelector(".jh-lightbox", { state: "visible", timeout: 5000 });
  const lightboxContent = await page.locator(".jh-lightbox__content").boundingBox();
  if (!lightboxContent || lightboxContent.width < 700) {
    fail(`/architecture mobile: expanded diagram opens too small (${lightboxContent?.width ?? 0}px)`);
  } else {
    console.log("ok    /architecture mobile diagram");
  }
  await page.locator('.jh-lightbox button[aria-label="Close"]').click();

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.locator(".DocSearch-Button").click();
  await page.locator("input.search-input").fill("privacy");
  await page.waitForFunction(
    () => document.querySelectorAll(".VPLocalSearchBox a.result").length > 0,
    { timeout: 5000 },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".VPLocalSearchBox .back-button, .VPLocalSearchBox .toggle-layout-button, .VPLocalSearchBox .clear-button")].every(
        (button) => button.getAttribute("aria-label"),
      ),
    { timeout: 5000 },
  );
  const searchState = await page.evaluate(() => ({
    hrefs: [...document.querySelectorAll(".VPLocalSearchBox a.result")]
      .map((a) => a.getAttribute("href") ?? "")
      .slice(0, 8),
    unlabeledButtons: [
      ...document.querySelectorAll(
        ".VPLocalSearchBox .back-button, .VPLocalSearchBox .toggle-layout-button, .VPLocalSearchBox .clear-button",
      ),
    ].filter((button) => !button.getAttribute("aria-label")).length,
  }));
  if (searchState.unlabeledButtons > 0) {
    fail(`/ search: ${searchState.unlabeledButtons} local-search icon button(s) lack aria-label`);
  }
  if (!searchState.hrefs.some((href) => href.startsWith("/user/security") || href.startsWith("/user/data-and-safety"))) {
    fail(`/ search privacy: user-facing privacy/security docs missing from top results (${searchState.hrefs.join(", ")})`);
  } else {
    console.log("ok    / search privacy");
  }

  await page.goto(`http://127.0.0.1:${port}/requirements#security-and-observability`, {
    waitUntil: "networkidle",
  });
  const tableMetrics = await page.locator(".vp-doc table").first().evaluate((table) => {
    const cell = table.querySelector("td:nth-child(3)") ?? table.querySelector("td");
    return {
      clientWidth: table.clientWidth,
      scrollWidth: table.scrollWidth,
      cellWidth: cell?.getBoundingClientRect().width ?? 0,
    };
  });
  if (tableMetrics.scrollWidth <= tableMetrics.clientWidth + 80 || tableMetrics.cellWidth < 120) {
    fail(
      `/requirements mobile: reference table is still crushed (${JSON.stringify(tableMetrics)})`,
    );
  } else {
    console.log("ok    /requirements mobile table");
  }
} finally {
  await browser.close();
  preview.kill("SIGTERM");
}

console.log(failures ? `DOCS RUNTIME CHECK FAIL — ${failures}` : "DOCS RUNTIME CHECK PASS");
process.exit(failures ? 1 : 0);
