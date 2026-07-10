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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  { path: "/user/data-and-safety", mermaid: false, images: false },
  { path: "/comparison", mermaid: false, images: true },
];

const BASE_VIEWPORT = { width: 1440, height: 1000 };
const REPORTED_TOUR_VIEWPORT = { width: 1285, height: 1397 };
const NARROW_DESKTOP_VIEWPORT = { width: 1024, height: 900 };
const ZOOMED_DESKTOP_CSS_VIEWPORT = { width: 720, height: 500 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const galleryHeroScreenshot = path.join(root, "docs/assets/screenshots/dashboard.png");
const publicHeroScreenshot = path.join(root, "docs/public/assets/screenshots/dashboard.png");

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

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

async function productTourGeometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width };
    };
    const image = document.querySelector(".vp-doc p:has(> img:only-child) > img");
    const outline = document.querySelector(".VPDocAsideOutline");
    const imageBox = image?.getBoundingClientRect();
    const outlineBox = outline?.getBoundingClientRect();
    return {
      sidebar: rect(".VPSidebar"),
      docContainer: rect(".VPDoc > .container"),
      mainContent: rect(".VPDoc > .container > .content"),
      prose: rect(".vp-doc > div > p:not(:has(> img:only-child))"),
      mediaFrame: rect(".vp-doc p:has(> img:only-child)"),
      image: rect(".vp-doc p:has(> img:only-child) > img"),
      outline: rect(".VPDocAsideOutline"),
      imageOutlineOverlap:
        imageBox && outlineBox
          ? Math.max(0, Math.min(imageBox.right, outlineBox.right) - Math.max(imageBox.left, outlineBox.left))
          : 0,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    };
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

if ((await sha256(galleryHeroScreenshot)) !== (await sha256(publicHeroScreenshot))) {
  fail("/ hero image: public hero screenshot is stale relative to docs/assets/screenshots/dashboard.png");
} else {
  console.log("ok    / hero image freshness");
}

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
  const tourOutline = await page.locator(".VPDocAsideOutline").innerText();
  if (!/On this page/.test(tourOutline) || !/Set Up Your Profile|Apply Review|Runs History/.test(tourOutline)) {
    fail("/user/screenshots: desktop section outline is missing or incomplete");
  } else {
    console.log("ok    /user/screenshots section outline");
  }
  const footerText = await page.locator(".VPFooter").innerText();
  if (!/AGPL-3\.0-only|synthetic data/.test(footerText)) {
    fail("/user/screenshots: copyright/license footer is missing or incomplete");
  } else {
    console.log("ok    /user/screenshots footer notice");
  }
  const desktopTour = await productTourGeometry(page);
  if (
    !desktopTour.mediaFrame
    || !desktopTour.prose
    || !desktopTour.mainContent
    || desktopTour.mediaFrame.width < 600
    || Math.abs(desktopTour.mediaFrame.width - desktopTour.prose.width) > 2
    || desktopTour.mediaFrame.right > desktopTour.mainContent.right + 1
    || desktopTour.imageOutlineOverlap > 0
    || desktopTour.pageOverflows
  ) {
    fail(`/user/screenshots desktop: media escaped its content track (${JSON.stringify(desktopTour)})`);
  } else {
    console.log("ok    /user/screenshots desktop media track");
  }

  const zoomableTourImage = page.locator(".vp-doc img").first();
  const imageAlt = await zoomableTourImage.getAttribute("alt");
  const imageRole = await zoomableTourImage.getAttribute("role");
  const imageLabel = await zoomableTourImage.getAttribute("aria-label");
  await zoomableTourImage.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".jh-lightbox", { state: "visible", timeout: 5000 });
  const expandedAlt = await page.locator(".jh-lightbox__content img").getAttribute("alt");
  if (
    !imageAlt?.includes("JobCtrl Profile page")
    || imageRole !== "button"
    || !imageLabel?.startsWith("Expand image:")
    || expandedAlt !== imageAlt
  ) {
    fail("/user/screenshots: responsive media lost its zoom or alternative-text semantics");
  } else {
    console.log("ok    /user/screenshots image zoom semantics");
  }
  await page.locator('.jh-lightbox button[aria-label="Close"]').click();

  await page.setViewportSize(REPORTED_TOUR_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, { waitUntil: "networkidle" });
  const reportedTour = await productTourGeometry(page);
  if (
    !reportedTour.mediaFrame
    || !reportedTour.prose
    || !reportedTour.mainContent
    || !reportedTour.outline
    || Math.abs(reportedTour.mediaFrame.width - reportedTour.prose.width) > 2
    || reportedTour.mediaFrame.right > reportedTour.mainContent.right + 1
    || reportedTour.imageOutlineOverlap > 0
    || reportedTour.pageOverflows
  ) {
    fail(`/user/screenshots 1285px: media/outline layout regressed (${JSON.stringify(reportedTour)})`);
  } else {
    console.log("ok    /user/screenshots 1285px media/outline layout");
  }

  const widthControl = page.getByLabel("Navigation width");
  const rangeContract = {
    min: await widthControl.getAttribute("min"),
    max: await widthControl.getAttribute("max"),
    step: await widthControl.getAttribute("step"),
  };
  await widthControl.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => Math.abs((document.querySelector(".VPSidebar")?.getBoundingClientRect().width ?? 0) - 224) < 1);
  const narrowSidebar = await productTourGeometry(page);
  const narrowOutput = await page.locator('output[for="jh-sidebar-width"]').innerText();
  await page.keyboard.press("End");
  await page.waitForFunction(() => Math.abs((document.querySelector(".VPSidebar")?.getBoundingClientRect().width ?? 0) - 320) < 1);
  const wideSidebar = await productTourGeometry(page);
  const wideOutput = await page.locator('output[for="jh-sidebar-width"]').innerText();
  if (
    rangeContract.min !== "224"
    || rangeContract.max !== "320"
    || rangeContract.step !== "8"
    || narrowOutput !== "224px"
    || wideOutput !== "320px"
    || !narrowSidebar.sidebar
    || !wideSidebar.sidebar
    || !narrowSidebar.docContainer
    || !wideSidebar.docContainer
    || narrowSidebar.sidebar.width !== 224
    || wideSidebar.sidebar.width !== 320
    || wideSidebar.docContainer.x <= narrowSidebar.docContainer.x
    || wideSidebar.imageOutlineOverlap > 0
    || wideSidebar.pageOverflows
  ) {
    fail(`/user/screenshots sidebar resize: keyboard or layout contract regressed (${JSON.stringify({
      rangeContract,
      narrowOutput,
      wideOutput,
      narrowSidebar,
      wideSidebar,
    })})`);
  } else {
    console.log("ok    /user/screenshots keyboard sidebar resize");
  }

  const collapseNavigation = page.getByRole("button", { name: "Collapse navigation", exact: true });
  await collapseNavigation.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.documentElement.dataset.jhSidebarExpanded === "false");
  const collapsedState = await page.evaluate(() => ({
    sidebarDisplay: getComputedStyle(document.querySelector(".VPSidebar")).display,
    titleDisplay: getComputedStyle(document.querySelector(".VPNavBarTitle")).display,
    restoreX: document.querySelector(".jh-sidebar-restore")?.getBoundingClientRect().x ?? -1,
    docContainerX: document.querySelector(".VPDoc > .container")?.getBoundingClientRect().x ?? -1,
    activeName: document.activeElement?.textContent?.trim() ?? "",
    visibleSidebarFocusables: [...document.querySelectorAll(".VPSidebar a, .VPSidebar button, .VPSidebar input")]
      .filter((element) => element.getClientRects().length > 0).length,
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
  }));
  const restoreNavigation = page.getByRole("button", { name: "Show navigation", exact: true });
  const restoreExpanded = await restoreNavigation.getAttribute("aria-expanded");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.documentElement.dataset.jhSidebarExpanded === "false");
  const restoredPreferenceVisible = await page.getByRole("button", { name: "Show navigation", exact: true }).isVisible();
  await page.getByRole("button", { name: "Show navigation", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.documentElement.dataset.jhSidebarExpanded === "true");
  const expandedState = await page.evaluate(() => ({
    sidebarWidth: document.querySelector(".VPSidebar")?.getBoundingClientRect().width ?? 0,
    activeName: document.activeElement?.textContent?.trim() ?? "",
    collapseExpanded: document
      .querySelector(".jh-sidebar-controls button[aria-controls=VPSidebarNav]")
      ?.getAttribute("aria-expanded"),
  }));
  await page.getByRole("button", { name: "Reset width", exact: true }).click();
  await page.waitForFunction(() => Math.abs((document.querySelector(".VPSidebar")?.getBoundingClientRect().width ?? 0) - 272) < 1);
  if (
    collapsedState.sidebarDisplay !== "none"
    || collapsedState.titleDisplay !== "none"
    || collapsedState.restoreX < 24
    || collapsedState.docContainerX > 33
    || collapsedState.activeName !== "Show navigation"
    || collapsedState.visibleSidebarFocusables !== 0
    || collapsedState.pageOverflows
    || restoreExpanded !== "false"
    || !restoredPreferenceVisible
    || expandedState.sidebarWidth !== 320
    || expandedState.activeName !== "Collapse navigation"
    || expandedState.collapseExpanded !== "true"
  ) {
    fail(`/user/screenshots sidebar collapse: focus, persistence, or width release regressed (${JSON.stringify({
      collapsedState,
      restoreExpanded,
      restoredPreferenceVisible,
      expandedState,
    })})`);
  } else {
    console.log("ok    /user/screenshots keyboard sidebar collapse and restore");
  }

  await page.setViewportSize(NARROW_DESKTOP_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, { waitUntil: "networkidle" });
  const narrowDesktopTour = await productTourGeometry(page);
  if (
    !narrowDesktopTour.mediaFrame
    || !narrowDesktopTour.prose
    || Math.abs(narrowDesktopTour.mediaFrame.width - narrowDesktopTour.prose.width) > 2
    || narrowDesktopTour.imageOutlineOverlap > 0
    || narrowDesktopTour.pageOverflows
  ) {
    fail(`/user/screenshots 1024px: responsive media layout regressed (${JSON.stringify(narrowDesktopTour)})`);
  } else {
    console.log("ok    /user/screenshots 1024px media layout");
  }

  // A 1440px display at 200% page zoom exposes roughly a 720px-wide CSS
  // viewport. The desktop controls should yield to VitePress's reachable
  // mobile navigation instead of clipping either control set.
  await page.setViewportSize(ZOOMED_DESKTOP_CSS_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, { waitUntil: "networkidle" });
  const zoomedDesktopState = await page.evaluate(() => ({
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    menuVisible: (document.querySelector("button.menu")?.getClientRects().length ?? 0) > 0,
    desktopControlsVisible: [...document.querySelectorAll(".jh-sidebar-controls, .jh-sidebar-restore")]
      .some((element) => element.getClientRects().length > 0),
  }));
  if (
    zoomedDesktopState.pageOverflows
    || !zoomedDesktopState.menuVisible
    || zoomedDesktopState.desktopControlsVisible
  ) {
    fail(`/user/screenshots 200% zoom: navigation became unreachable (${JSON.stringify(zoomedDesktopState)})`);
  } else {
    console.log("ok    /user/screenshots 200% zoom navigation fallback");
  }

  await page.setViewportSize(BASE_VIEWPORT);

  await page.goto(`http://127.0.0.1:${port}/user/data-and-safety`, { waitUntil: "networkidle" });
  const privacyContract = await page.evaluate(() => {
    const heading = document.querySelector("#privacy-quick-answer");
    const table = heading?.nextElementSibling;
    const text = document.querySelector(".vp-doc")?.textContent ?? "";
    return {
      headerCount: table?.querySelectorAll("thead th").length ?? 0,
      rowCount: table?.querySelectorAll("tbody tr").length ?? 0,
      tableText: table?.textContent ?? "",
      hasWorkspaceScope: text.includes("every path below is relative to JOBCTRL_DIR"),
      hasMacOnlyBoundary: text.includes("macOS-only credential panel"),
      hasRuntimeBoundary: text.includes("loads a Keychain entry at startup"),
      hasPrecedenceBoundary: text.includes("Any non-empty environment value already present wins"),
      hasRestartBoundary: text.includes("Restart the worker"),
      hasWindowsBoundary: text.includes("Windows Credential Manager"),
      hasLinuxBoundary: text.includes("Linux Secret Service/keyring"),
      hasInspectionFailureBoundary: text.includes("Unknown (inspection_failed) means Keychain could not be inspected"),
      hasRetryBoundary: text.includes("unlock it and retry"),
      hasDefaultProtection: text.includes("Protected by default"),
    };
  });
  const requiredQuickAnswers = [
    "Hosted backend or JobCtrl account required?",
    "Model or provider calls automatic?",
    "Discovery makes network requests?",
    "Telemetry enabled by default?",
    "Discovery or enrichment may launch a browser?",
    "Application-submission browser automation always running?",
    "Employer-facing submission or email send by default?",
  ];
  const requiredQuickAnswerStatuses = ["✓ Yes", "✕ No", "◐ Only"];
  if (
    privacyContract.headerCount !== 2
    || privacyContract.rowCount < 8
    || requiredQuickAnswers.some((answer) => !privacyContract.tableText.includes(answer))
    || requiredQuickAnswerStatuses.some(
      (status) => !privacyContract.tableText.includes(status),
    )
    || !privacyContract.tableText.includes(
      "during runs you start or schedules you explicitly enable",
    )
    || !privacyContract.tableText.includes(
      "Smart extraction and some detail enrichment use Playwright",
    )
    || !privacyContract.hasWorkspaceScope
    || !privacyContract.hasMacOnlyBoundary
    || !privacyContract.hasRuntimeBoundary
    || !privacyContract.hasPrecedenceBoundary
    || !privacyContract.hasRestartBoundary
    || !privacyContract.hasWindowsBoundary
    || !privacyContract.hasLinuxBoundary
    || !privacyContract.hasInspectionFailureBoundary
    || !privacyContract.hasRetryBoundary
    || !privacyContract.hasDefaultProtection
  ) {
    fail(`/user/data-and-safety: privacy/path/credential contract regressed (${JSON.stringify(privacyContract)})`);
  } else {
    console.log("ok    /user/data-and-safety privacy contract");
  }

  await page.goto(`http://127.0.0.1:${port}/architecture/runtime`, { waitUntil: "networkidle" });
  const credentialRuntimeContract = await page.evaluate(() => {
    const text = document.querySelector(".vp-doc")?.textContent ?? "";
    return {
      hasBoundary: text.includes("Provider Credential Boundary"),
      hasSubmittedValueBoundary: text.includes("sends one submitted value"),
      hasPresenceOnlyBoundary: text.includes("responses use presence checks"),
      hasTriStateBoundary: text.includes("configured state is true, false, or null"),
      hasInspectionFailureBoundary: text.includes("unavailableReason: inspection_failed"),
      hasSanitizedOperationalFailure: text.includes("503 credential_store_unavailable"),
      hasFixedAllowlist: text.includes("same fixed allowlist"),
      hasMissingOrEmptyBoundary: text.includes("only for a missing or empty value"),
      hasProcessLocalBoundary: text.includes("only into that process's environment"),
      hasNoHotReloadBoundary: text.includes("There is no hot reload"),
      hasPlatformBoundary: text.includes("native Windows and Linux stores are planned"),
    };
  });
  if (Object.values(credentialRuntimeContract).some((present) => !present)) {
    fail(`/architecture/runtime: credential boundary regressed (${JSON.stringify(credentialRuntimeContract)})`);
  } else {
    console.log("ok    /architecture/runtime credential boundary");
  }

  await page.goto(`http://127.0.0.1:${port}/comparison`, { waitUntil: "networkidle" });
  const comparisonDesktop = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".jh-compare-card")].map((card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    });
    const headings = [...document.querySelectorAll(".vp-doc h2")].map((heading) =>
      (heading.textContent ?? "").replaceAll("\u200B", "").trim(),
    );
    return {
      cards,
      headings,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      summaryRegionLabel: document
        .querySelector(".jh-compare-table-wrap")
        ?.getAttribute("aria-label"),
      summaryRegionTabIndex: document
        .querySelector(".jh-compare-table-wrap")
        ?.getAttribute("tabindex"),
    };
  });
  const cardsShareRow = comparisonDesktop.cards.length === 3
    && comparisonDesktop.cards.every(
      (card) => Math.abs(card.y - comparisonDesktop.cards[0].y) < 2
        && Math.abs(card.width - comparisonDesktop.cards[0].width) < 2,
    );
  if (
    !cardsShareRow
    || comparisonDesktop.pageOverflows
    || comparisonDesktop.summaryRegionLabel !== "At-a-glance comparison table"
    || comparisonDesktop.summaryRegionTabIndex !== "0"
    || !comparisonDesktop.headings.includes("JobCtrl's UI is part of the product")
    || comparisonDesktop.headings.at(-1) !== "Appendix: evidence-backed capability matrix"
  ) {
    fail(`/comparison desktop: visual hierarchy or appendix order regressed (${JSON.stringify(comparisonDesktop)})`);
  } else {
    console.log("ok    /comparison desktop visual hierarchy");
  }

  await page.goto(`http://127.0.0.1:${port}/user/normal-flows`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".mermaid svg").length >= 1, { timeout: 15000 });
  const desktopLoopDiagram = await page.locator(".vp-doc .mermaid").first().boundingBox();
  if (
    !desktopLoopDiagram ||
    desktopLoopDiagram.width < 320 ||
    desktopLoopDiagram.width > 820 ||
    desktopLoopDiagram.height > 560
  ) {
    fail(
      `/user/normal-flows: desktop diagram is mis-sized (${desktopLoopDiagram?.width ?? 0}x${
        desktopLoopDiagram?.height ?? 0
      }px)`,
    );
  } else {
    console.log("ok    /user/normal-flows desktop diagram size");
  }
  const webPanelVisible = await page.locator('[data-jh-channel-panel="web"]').first().isVisible();
  const cliPanelInitiallyVisible = await page.locator('[data-jh-channel-panel="cli"]').first().isVisible();
  const webScreenshotsVisible = await page
    .locator('[data-jh-channel-panel="web"] img')
    .evaluateAll((imgs) => imgs.some((img) => img.getClientRects().length > 0));
  if (!webPanelVisible || cliPanelInitiallyVisible || !webScreenshotsVisible) {
    fail("/user/normal-flows: workflow selector does not default to Web app");
  }
  await page.locator('[data-jh-channel-tab="cli"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.jhWorkflowSurface === "cli");
  const cliSelected = await page.locator('[data-jh-channel-tab="cli"]').getAttribute("aria-selected");
  const cliCommandVisible = await page.locator("text=jobctrl run discover").first().isVisible();
  const webPanelAfterCli = await page.locator('[data-jh-channel-panel="web"]').first().isVisible();
  const cliVisibleScreenshots = await page
    .locator(".vp-doc img")
    .evaluateAll((imgs) => imgs.filter((img) => img.getClientRects().length > 0).length);
  if (cliSelected !== "true" || !cliCommandVisible || webPanelAfterCli || cliVisibleScreenshots > 0) {
    fail("/user/normal-flows: CLI workflow selector does not reveal CLI content");
  } else {
    console.log("ok    /user/normal-flows workflow selector");
  }
  await page.locator('[data-jh-channel-tab="web"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.jhWorkflowSurface === "web");

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, { waitUntil: "networkidle" });
  const mobileTourImage = await page.locator(".vp-doc img").first().boundingBox();
  const customDesktopControlsVisible = await page
    .locator(".jh-sidebar-controls, .jh-sidebar-restore")
    .evaluateAll((elements) => elements.some((element) => element.getClientRects().length > 0));
  if (!mobileTourImage || mobileTourImage.width < 700) {
    fail(`/user/screenshots mobile: screenshot did not remain inspectable (${mobileTourImage?.width ?? 0}px)`);
  } else if (customDesktopControlsVisible) {
    fail("/user/screenshots mobile: desktop sidebar controls displaced the stock mobile drawer");
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

  await page.goto(`http://127.0.0.1:${port}/user/normal-flows`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".mermaid svg").length >= 1, { timeout: 15000 });
  const mobileDiagram = await page.locator(".vp-doc .mermaid").first().boundingBox();
  if (
    !mobileDiagram ||
    mobileDiagram.width > MOBILE_VIEWPORT.width - 24 ||
    mobileDiagram.width < 260 ||
    mobileDiagram.height > 420
  ) {
    fail(
      `/user/normal-flows mobile: inline diagram is mis-sized (${mobileDiagram?.width ?? 0}x${
        mobileDiagram?.height ?? 0
      }px)`,
    );
  }
  await page.locator(".vp-doc .mermaid").first().click();
  await page.waitForSelector(".jh-lightbox", { state: "visible", timeout: 5000 });
  const lightboxContent = await page.locator(".jh-lightbox__content").boundingBox();
  if (!lightboxContent || lightboxContent.width > MOBILE_VIEWPORT.width || lightboxContent.height > MOBILE_VIEWPORT.height) {
    fail(`/user/normal-flows mobile: expanded diagram does not start fitted (${JSON.stringify(lightboxContent)})`);
  } else {
    console.log("ok    /user/normal-flows mobile diagram");
  }
  await page.locator('.jh-lightbox button[aria-label="Close"]').click();

  await page.goto(`http://127.0.0.1:${port}/comparison`, { waitUntil: "networkidle" });
  const comparisonMobile = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".jh-compare-card")].map((card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    });
    const summary = document.querySelector(".jh-compare-table-wrap");
    return {
      cards,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      summaryClientWidth: summary?.clientWidth ?? 0,
      summaryScrollWidth: summary?.scrollWidth ?? 0,
    };
  });
  const cardsStack = comparisonMobile.cards.length === 3
    && comparisonMobile.cards.every(
      (card, index) => Math.abs(card.x - comparisonMobile.cards[0].x) < 2
        && (index === 0 || card.y > comparisonMobile.cards[index - 1].y),
    );
  const summaryRegion = page.locator(".jh-compare-table-wrap");
  await summaryRegion.focus();
  const beforeArrow = await summaryRegion.evaluate((element) => element.scrollLeft);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  const afterArrow = await summaryRegion.evaluate((element) => element.scrollLeft);
  if (
    !cardsStack
    || comparisonMobile.pageOverflows
    || comparisonMobile.summaryScrollWidth <= comparisonMobile.summaryClientWidth + 80
    || afterArrow <= beforeArrow
  ) {
    fail(
      `/comparison mobile: cards or keyboard-scroll table regressed (${JSON.stringify({
        ...comparisonMobile,
        beforeArrow,
        afterArrow,
      })})`,
    );
  } else {
    console.log("ok    /comparison mobile layout and keyboard table scroll");
  }

  await page.goto(`http://127.0.0.1:${port}/user/data-and-safety`, { waitUntil: "networkidle" });
  const privacyMobile = await page.evaluate(() => {
    const heading = document.querySelector("#privacy-quick-answer");
    const table = heading?.nextElementSibling;
    const box = table?.getBoundingClientRect();
    return {
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      tableLeft: box?.left ?? -1,
      tableRight: box?.right ?? -1,
      viewportWidth: window.innerWidth,
      headerCount: table?.querySelectorAll("thead th").length ?? 0,
    };
  });
  if (
    privacyMobile.pageOverflows
    || privacyMobile.headerCount !== 2
    || privacyMobile.tableLeft < 0
    || privacyMobile.tableRight > privacyMobile.viewportWidth + 1
  ) {
    fail(`/user/data-and-safety mobile: quick-answer table is not viewport-contained (${JSON.stringify(privacyMobile)})`);
  } else {
    console.log("ok    /user/data-and-safety mobile privacy table");
  }

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
} finally {
  await browser.close();
  preview.kill("SIGTERM");
}

console.log(failures ? `DOCS RUNTIME CHECK FAIL — ${failures}` : "DOCS RUNTIME CHECK PASS");
process.exit(failures ? 1 : 0);
