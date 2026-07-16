#!/usr/bin/env node
/**
 * Runtime regression gate for the built docs site.
 *
 * The static href gate cannot see client-side failures: `vitepress preview`
 * (sirv) snapshots the dist file list at boot, so a rebuild under a running
 * preview serves HTML whose hashed chunks 404 — every page then renders with
 * zero JavaScript: blank visual components, no aria-current, no lightbox,
 * and no console errors. This script boots a FRESH preview of the current
 * dist on a free port and asserts, in a real browser:
 *   - zero failed or 404'd requests on every checked page;
 *   - every visual page renders its current canonical visual component;
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
  { path: "/", visualSelector: null, images: false },
  { path: "/architecture/", visualSelector: ".system-topology", images: false },
  {
    path: "/architecture/scoring",
    visualSelector: ".mermaid svg",
    images: false,
  },
  {
    path: "/architecture/pipeline/operations",
    visualSelector: ".mermaid svg",
    images: false,
  },
  {
    path: "/user/normal-flows",
    visualSelector: ".jh-daily-journey",
    images: true,
  },
  { path: "/user/screenshots", visualSelector: null, images: true },
  {
    path: "/user/data-and-safety",
    visualSelector: ".data-boundary",
    images: false,
  },
  { path: "/comparison", visualSelector: null, images: true },
];

const REQUIRED_SIDEBAR_LABELS = [
  "Start Here",
  "Product Tour",
  "Daily Workflow",
  "The Job-Search Lifecycle",
  "Configuration & Trust",
  "Build & Verify",
  "How JobCtrl Works",
  "Reference",
];

const BASE_VIEWPORT = { width: 1440, height: 1000 };
const REPORTED_TOUR_VIEWPORT = { width: 1285, height: 1397 };
const NARROW_DESKTOP_VIEWPORT = { width: 1024, height: 900 };
const SIDEBAR_SCROLL_VIEWPORT = { width: 1285, height: 600 };
const ZOOMED_DESKTOP_CSS_VIEWPORT = { width: 720, height: 500 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const galleryHeroScreenshot = path.join(
  root,
  "docs/assets/screenshots/dashboard.png",
);
const publicHeroScreenshot = path.join(
  root,
  "docs/public/assets/screenshots/dashboard.png",
);

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
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
    const image = document.querySelector(
      ".vp-doc p:has(> img:only-child) > img",
    );
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
          ? Math.max(
              0,
              Math.min(imageBox.right, outlineBox.right) -
                Math.max(imageBox.left, outlineBox.left),
            )
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
  const timer = setTimeout(
    () => reject(new Error("preview did not boot in 30s")),
    30000,
  );
  preview.stdout.on("data", (d) => {
    if (String(d).includes("http")) {
      clearTimeout(timer);
      resolve();
    }
  });
  preview.on("exit", (code) =>
    reject(new Error(`preview exited early (${code})`)),
  );
});

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
};

if (
  (await sha256(galleryHeroScreenshot)) !== (await sha256(publicHeroScreenshot))
) {
  fail(
    "/ hero image: public hero screenshot is stale relative to docs/assets/screenshots/dashboard.png",
  );
} else {
  console.log("ok    / hero image freshness");
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: BASE_VIEWPORT });
  const badRequests = [];
  page.on("requestfailed", (r) =>
    badRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) badRequests.push(`${r.url()} HTTP ${r.status()}`);
  });

  for (const spec of PAGES) {
    badRequests.length = 0;
    await page.goto(`http://127.0.0.1:${port}${spec.path}`, {
      waitUntil: "networkidle",
    });

    if (spec.visualSelector) {
      const visual = page.locator(spec.visualSelector).first();
      const rendered = await visual
        .waitFor({ state: "visible", timeout: 15000 })
        .then(async () => {
          const box = await visual.boundingBox();
          return Boolean(box && box.width > 40 && box.height > 40);
        })
        .catch(() => false);
      if (!rendered)
        fail(`${spec.path}: ${spec.visualSelector} did not render visibly`);
    }

    if (spec.path !== "/") {
      await page.waitForTimeout(200);
      const aria = await page
        .locator('.VPSidebar a[aria-current="page"]')
        .count();
      if (aria !== 1)
        fail(
          `${spec.path}: expected exactly 1 aria-current sidebar link, found ${aria}`,
        );
    }

    if (spec.images) {
      const broken = await page
        .locator(".vp-doc img")
        .evaluateAll(
          (imgs) =>
            imgs.filter((i) => !(i.complete && i.naturalWidth > 100)).length,
        );
      if (broken > 0)
        fail(`${spec.path}: ${broken} content image(s) failed to load`);
    }

    if (badRequests.length > 0) {
      fail(
        `${spec.path}: ${badRequests.length} failed/4xx request(s), first: ${badRequests[0]}`,
      );
    }
    if (failures === 0) console.log(`ok    ${spec.path}`);
  }

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  const heroImage = await page
    .locator(".VPHome .VPHero img.image-src")
    .boundingBox();
  if (
    !heroImage ||
    heroImage.width < 420 ||
    heroImage.y > BASE_VIEWPORT.height
  ) {
    fail(
      "/: product hero image is missing, too small, or below the first viewport",
    );
  } else {
    console.log("ok    / hero image");
  }

  const heroBrandActions = await page
    .locator(".VPHome .VPHero .actions .VPButton.brand")
    .evaluateAll((actions) =>
      actions
        .filter((action) => action.getClientRects().length > 0)
        .map((action) => ({
          text: action.textContent?.trim(),
          href: action.href,
        })),
    );
  if (
    heroBrandActions.length !== 1 ||
    heroBrandActions[0]?.text !== "Try the Live Demo" ||
    heroBrandActions[0]?.href !== "https://demo.jobctrl.dev/"
  ) {
    fail(
      `/: expected one visible brand action for Try the Live Demo, found ${JSON.stringify(heroBrandActions)}`,
    );
  } else {
    console.log("ok    / live demo hero action");
  }

  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, {
    waitUntil: "networkidle",
  });
  const tourSidebar = await page.locator(".VPSidebar").innerText();
  const missingDesktopSidebarLabels = REQUIRED_SIDEBAR_LABELS.filter(
    (label) => !tourSidebar.includes(label),
  );
  if (missingDesktopSidebarLabels.length > 0) {
    fail(
      `/user/screenshots: unified sidebar is missing ${missingDesktopSidebarLabels.join(", ")}`,
    );
  }
  const tourOutline = await page.locator(".VPDocAsideOutline").innerText();
  if (
    !/On this page/.test(tourOutline) ||
    !/Set Up Your Profile|Apply Review|Runs History/.test(tourOutline)
  ) {
    fail("/user/screenshots: desktop section outline is missing or incomplete");
  } else {
    console.log("ok    /user/screenshots section outline");
  }
  const footerText = await page.locator(".VPFooter").innerText();
  const obsoleteFooterMessage =
    "Documentation screenshots and examples use synthetic data unless noted.";
  if (
    !footerText.includes("Copyright © 2026 Eloi Barti") ||
    !footerText.includes("AGPL-3.0-only") ||
    !footerText.includes("Source code") ||
    footerText.includes(obsoleteFooterMessage)
  ) {
    fail(
      "/user/screenshots: copyright/license footer is missing or incomplete",
    );
  } else {
    console.log("ok    /user/screenshots footer notice");
  }
  const desktopTour = await productTourGeometry(page);
  if (
    !desktopTour.mediaFrame ||
    !desktopTour.prose ||
    !desktopTour.mainContent ||
    desktopTour.mediaFrame.width < 600 ||
    Math.abs(desktopTour.mediaFrame.width - desktopTour.prose.width) > 2 ||
    desktopTour.mediaFrame.right > desktopTour.mainContent.right + 1 ||
    desktopTour.imageOutlineOverlap > 0 ||
    desktopTour.pageOverflows
  ) {
    fail(
      `/user/screenshots desktop: media escaped its content track (${JSON.stringify(desktopTour)})`,
    );
  } else {
    console.log("ok    /user/screenshots desktop media track");
  }

  const zoomableTourImage = page.locator(".vp-doc img").first();
  const imageAlt = await zoomableTourImage.getAttribute("alt");
  const imageRole = await zoomableTourImage.getAttribute("role");
  const imageLabel = await zoomableTourImage.getAttribute("aria-label");
  await zoomableTourImage.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".jh-lightbox", {
    state: "visible",
    timeout: 5000,
  });
  const expandedAlt = await page
    .locator(".jh-lightbox__content img")
    .getAttribute("alt");
  if (
    !imageAlt?.trim() ||
    imageRole !== "button" ||
    imageLabel !== `Expand image: ${imageAlt}` ||
    expandedAlt !== imageAlt
  ) {
    fail(
      "/user/screenshots: responsive media lost its zoom or alternative-text semantics",
    );
  } else {
    console.log("ok    /user/screenshots image zoom semantics");
  }
  await page.locator('.jh-lightbox button[aria-label="Close"]').click();

  await page.setViewportSize(REPORTED_TOUR_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, {
    waitUntil: "networkidle",
  });
  const reportedTour = await productTourGeometry(page);
  if (
    !reportedTour.mediaFrame ||
    !reportedTour.prose ||
    !reportedTour.mainContent ||
    !reportedTour.outline ||
    Math.abs(reportedTour.mediaFrame.width - reportedTour.prose.width) > 2 ||
    reportedTour.mediaFrame.right > reportedTour.mainContent.right + 1 ||
    reportedTour.imageOutlineOverlap > 0 ||
    reportedTour.pageOverflows
  ) {
    fail(
      `/user/screenshots 1285px: media/outline layout regressed (${JSON.stringify(reportedTour)})`,
    );
  } else {
    console.log("ok    /user/screenshots 1285px media/outline layout");
  }

  const resizeNavigation = page.getByRole("separator", {
    name: "Resize navigation",
    exact: true,
  });
  const separatorContract = {
    controls: await resizeNavigation.getAttribute("aria-controls"),
    orientation: await resizeNavigation.getAttribute("aria-orientation"),
    min: await resizeNavigation.getAttribute("aria-valuemin"),
    max: await resizeNavigation.getAttribute("aria-valuemax"),
  };
  const obsoleteControlCount = await page
    .locator('.jh-sidebar-controls, input[type="range"]')
    .count();
  await resizeNavigation.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(
    () =>
      Math.abs(
        (document.querySelector(".VPSidebar")?.getBoundingClientRect().width ??
          0) - 224,
      ) < 1,
  );
  const narrowSidebar = await productTourGeometry(page);
  const narrowValue = await resizeNavigation.getAttribute("aria-valuenow");

  const resizeHandleBox = await resizeNavigation.boundingBox();
  if (resizeHandleBox) {
    const resizeY =
      resizeHandleBox.y + Math.min(120, resizeHandleBox.height / 2);
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeY,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2 + 56,
      resizeY,
      { steps: 4 },
    );
    await page.mouse.up();
  }
  await page.waitForFunction(
    () =>
      Math.abs(
        (document.querySelector(".VPSidebar")?.getBoundingClientRect().width ??
          0) - 280,
      ) < 1,
  );
  const draggedSidebar = await productTourGeometry(page);
  const draggedValue = await resizeNavigation.getAttribute("aria-valuenow");

  await resizeNavigation.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(
    () =>
      Math.abs(
        (document.querySelector(".VPSidebar")?.getBoundingClientRect().width ??
          0) - 320,
      ) < 1,
  );
  const wideSidebar = await productTourGeometry(page);
  const wideValue = await resizeNavigation.getAttribute("aria-valuenow");
  if (
    separatorContract.controls !== "VPSidebarNav" ||
    separatorContract.orientation !== "vertical" ||
    separatorContract.min !== "224" ||
    separatorContract.max !== "320" ||
    obsoleteControlCount !== 0 ||
    narrowValue !== "224" ||
    draggedValue !== "280" ||
    wideValue !== "320" ||
    !resizeHandleBox ||
    !narrowSidebar.sidebar ||
    !draggedSidebar.sidebar ||
    !wideSidebar.sidebar ||
    !narrowSidebar.docContainer ||
    !draggedSidebar.docContainer ||
    !wideSidebar.docContainer ||
    narrowSidebar.sidebar.width !== 224 ||
    draggedSidebar.sidebar.width !== 280 ||
    wideSidebar.sidebar.width !== 320 ||
    draggedSidebar.docContainer.x <= narrowSidebar.docContainer.x ||
    wideSidebar.docContainer.x <= narrowSidebar.docContainer.x ||
    wideSidebar.imageOutlineOverlap > 0 ||
    wideSidebar.pageOverflows
  ) {
    fail(
      `/user/screenshots sidebar resize: pointer, keyboard, or layout contract regressed (${JSON.stringify(
        {
          separatorContract,
          obsoleteControlCount,
          narrowValue,
          draggedValue,
          wideValue,
          resizeHandleBox,
          narrowSidebar,
          draggedSidebar,
          wideSidebar,
        },
      )})`,
    );
  } else {
    console.log("ok    /user/screenshots direct-manipulation sidebar resize");
  }

  const collapseNavigation = page.getByRole("button", {
    name: "Collapse navigation",
    exact: true,
  });
  await collapseNavigation.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "false",
  );
  const collapsedState = await page.evaluate(() => ({
    sidebarDisplay: getComputedStyle(document.querySelector(".VPSidebar"))
      .display,
    titleDisplay: getComputedStyle(document.querySelector(".VPNavBarTitle"))
      .display,
    restoreX:
      document.querySelector(".jh-sidebar-restore")?.getBoundingClientRect()
        .x ?? -1,
    docContainerX:
      document.querySelector(".VPDoc > .container")?.getBoundingClientRect()
        .x ?? -1,
    activeName: document.activeElement?.getAttribute("aria-label") ?? "",
    visibleSidebarFocusables: [
      ...document.querySelectorAll(
        ".VPSidebar a, .VPSidebar button, .VPSidebar input",
      ),
    ].filter((element) => element.getClientRects().length > 0).length,
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
  }));
  const restoreNavigation = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  const restoreExpanded = await restoreNavigation.getAttribute("aria-expanded");
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "false",
  );
  const collapsedHomepageState = await page.evaluate(() => ({
    hasSidebar: Boolean(document.querySelector(".VPSidebar")),
    restoreVisible:
      (document.querySelector(".jh-sidebar-restore")?.getClientRects().length ??
        0) > 0,
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
  }));
  const homepageRestoreNavigation = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  await homepageRestoreNavigation.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "true",
  );
  const expandedHomepageState = await page.evaluate(() => ({
    activeHref: document.activeElement?.getAttribute("href") ?? "",
    activeVisible: (document.activeElement?.getClientRects().length ?? 0) > 0,
  }));
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "true",
  );
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "false",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "false",
  );
  const restoredPreferenceVisible = await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .isVisible();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.documentElement.dataset.jhSidebarExpanded === "true",
  );
  const expandedState = await page.evaluate(() => ({
    sidebarWidth:
      document.querySelector(".VPSidebar")?.getBoundingClientRect().width ?? 0,
    activeName: document.activeElement?.getAttribute("aria-label") ?? "",
    collapseExpanded: document
      .querySelector(".jh-sidebar-collapse")
      ?.getAttribute("aria-expanded"),
  }));
  await page
    .getByRole("separator", { name: "Resize navigation", exact: true })
    .dblclick();
  await page.waitForFunction(
    () =>
      Math.abs(
        (document.querySelector(".VPSidebar")?.getBoundingClientRect().width ??
          0) - 272,
      ) < 1,
  );
  if (
    collapsedState.sidebarDisplay !== "none" ||
    collapsedState.titleDisplay !== "none" ||
    collapsedState.restoreX < 24 ||
    collapsedState.docContainerX > 33 ||
    collapsedState.activeName !== "Show navigation" ||
    collapsedState.visibleSidebarFocusables !== 0 ||
    collapsedState.pageOverflows ||
    restoreExpanded !== "false" ||
    collapsedHomepageState.hasSidebar ||
    !collapsedHomepageState.restoreVisible ||
    collapsedHomepageState.pageOverflows ||
    expandedHomepageState.activeHref !== "/" ||
    !expandedHomepageState.activeVisible ||
    !restoredPreferenceVisible ||
    expandedState.sidebarWidth !== 320 ||
    expandedState.activeName !== "Collapse navigation" ||
    expandedState.collapseExpanded !== "true"
  ) {
    fail(
      `/user/screenshots sidebar collapse: focus, persistence, or width release regressed (${JSON.stringify(
        {
          collapsedState,
          collapsedHomepageState,
          expandedHomepageState,
          restoreExpanded,
          restoredPreferenceVisible,
          expandedState,
        },
      )})`,
    );
  } else {
    console.log(
      "ok    /user/screenshots keyboard sidebar collapse and restore",
    );
  }

  await page.setViewportSize(SIDEBAR_SCROLL_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/architecture/`, {
    waitUntil: "networkidle",
  });
  const sidebarScrollStart = await page.evaluate(() => {
    const sidebar = document.querySelector(".VPSidebar");
    const box = sidebar?.getBoundingClientRect();
    if (!(sidebar instanceof HTMLElement) || !box) return null;
    const testY = Math.min(box.bottom - 40, box.top + 260);
    const hitClass = (x) =>
      document.elementFromPoint(x, testY)?.className ?? "";
    return {
      clientHeight: sidebar.clientHeight,
      innerHitClass: hitClass(box.right - 4),
      innerX: box.right - 4,
      outerHitClass: hitClass(box.right + 4),
      scrollHeight: sidebar.scrollHeight,
      testY,
      width: box.width,
    };
  });
  if (sidebarScrollStart) {
    await page.mouse.move(sidebarScrollStart.innerX, sidebarScrollStart.testY);
    await page.mouse.wheel(0, 360);
    await page.waitForFunction(
      () => (document.querySelector(".VPSidebar")?.scrollTop ?? 0) > 0,
    );
  }
  const sidebarScrollEnd = await page.evaluate(() => ({
    pageScrollY: window.scrollY,
    scrollTop: document.querySelector(".VPSidebar")?.scrollTop ?? 0,
    width:
      document.querySelector(".VPSidebar")?.getBoundingClientRect().width ?? 0,
  }));
  if (
    !sidebarScrollStart ||
    sidebarScrollStart.scrollHeight <= sidebarScrollStart.clientHeight ||
    String(sidebarScrollStart.innerHitClass).includes("jh-sidebar-resizer") ||
    !String(sidebarScrollStart.outerHitClass).includes("jh-sidebar-resizer") ||
    sidebarScrollEnd.scrollTop <= 0 ||
    sidebarScrollEnd.pageScrollY !== 0 ||
    Math.abs(sidebarScrollEnd.width - sidebarScrollStart.width) > 1
  ) {
    fail(
      `/architecture/ sidebar edge: resize rail blocked scrolling (${JSON.stringify(
        {
          sidebarScrollStart,
          sidebarScrollEnd,
        },
      )})`,
    );
  } else {
    console.log("ok    /architecture/ sidebar edge preserves scrolling");
  }

  await page.setViewportSize(NARROW_DESKTOP_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, {
    waitUntil: "networkidle",
  });
  const narrowDesktopTour = await productTourGeometry(page);
  if (
    !narrowDesktopTour.mediaFrame ||
    !narrowDesktopTour.prose ||
    Math.abs(
      narrowDesktopTour.mediaFrame.width - narrowDesktopTour.prose.width,
    ) > 2 ||
    narrowDesktopTour.imageOutlineOverlap > 0 ||
    narrowDesktopTour.pageOverflows
  ) {
    fail(
      `/user/screenshots 1024px: responsive media layout regressed (${JSON.stringify(narrowDesktopTour)})`,
    );
  } else {
    console.log("ok    /user/screenshots 1024px media layout");
  }

  // A 1440px display at 200% page zoom exposes roughly a 720px-wide CSS
  // viewport. The desktop controls should yield to VitePress's reachable
  // mobile navigation instead of clipping either control set.
  await page.setViewportSize(ZOOMED_DESKTOP_CSS_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, {
    waitUntil: "networkidle",
  });
  const zoomedDesktopState = await page.evaluate(() => ({
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    menuVisible:
      (document.querySelector("button.menu")?.getClientRects().length ?? 0) > 0,
    desktopControlsVisible: [
      ...document.querySelectorAll(".jh-sidebar-rail, .jh-sidebar-restore"),
    ].some((element) => element.getClientRects().length > 0),
  }));
  if (
    zoomedDesktopState.pageOverflows ||
    !zoomedDesktopState.menuVisible ||
    zoomedDesktopState.desktopControlsVisible
  ) {
    fail(
      `/user/screenshots 200% zoom: navigation became unreachable (${JSON.stringify(zoomedDesktopState)})`,
    );
  } else {
    console.log("ok    /user/screenshots 200% zoom navigation fallback");
  }

  await page.setViewportSize(BASE_VIEWPORT);

  await page.goto(`http://127.0.0.1:${port}/user/data-and-safety`, {
    waitUntil: "networkidle",
  });
  const privacyContract = await page.evaluate(() => {
    const heading = document.querySelector("#privacy-quick-answer");
    const table = heading?.nextElementSibling;
    const text = document.querySelector(".vp-doc")?.textContent ?? "";
    return {
      headerCount: table?.querySelectorAll("thead th").length ?? 0,
      rowCount: table?.querySelectorAll("tbody tr").length ?? 0,
      tableText: table?.textContent ?? "",
      hasWorkspaceScope: text.includes(
        "every path below is relative to JOBCTRL_DIR",
      ),
      hasMacOnlyBoundary: text.includes("macOS credential panel"),
      hasRuntimeBoundary: text.includes("loads a Keychain entry at startup"),
      hasPrecedenceBoundary: text.includes(
        "Any non-empty environment value already present wins",
      ),
      hasRestartBoundary: text.includes("Restart JobCtrl"),
      hasWindowsBoundary: text.includes("Windows Credential Manager"),
      hasLinuxBoundary: text.includes("Linux Secret Service/keyring"),
      hasInspectionFailureBoundary:
        text.includes("inspection_failed") &&
        text.includes("not that a credential is absent"),
      hasRetryBoundary: text.includes("unlock it and retry"),
      hasDefaultProtection: text.includes("Protected by default"),
    };
  });
  const requiredQuickAnswers = [
    "Do I need a hosted backend or a JobCtrl account?",
    "Are the database and generated files stored locally?",
    "Does JobCtrl call AI models or other providers automatically?",
    "Does Discovery make network requests?",
    "Is telemetry enabled by default?",
    "Can Discovery or enrichment launch a browser?",
    "Does application-submission browser automation run continuously?",
    "Does JobCtrl submit applications or send employer-facing email by default?",
    "Does Outreach send messages automatically?",
  ];
  const requiredQuickAnswerStatuses = ["✓ Yes", "✕ No", "◐ Only"];
  if (
    privacyContract.headerCount !== 2 ||
    privacyContract.rowCount < 8 ||
    requiredQuickAnswers.some(
      (answer) => !privacyContract.tableText.includes(answer),
    ) ||
    requiredQuickAnswerStatuses.some(
      (status) => !privacyContract.tableText.includes(status),
    ) ||
    !privacyContract.tableText.includes(
      "during runs you start or schedules you explicitly enable",
    ) ||
    !privacyContract.tableText.includes(
      "Smart extraction and some detail enrichment use Playwright",
    ) ||
    !privacyContract.hasWorkspaceScope ||
    !privacyContract.hasMacOnlyBoundary ||
    !privacyContract.hasRuntimeBoundary ||
    !privacyContract.hasPrecedenceBoundary ||
    !privacyContract.hasRestartBoundary ||
    !privacyContract.hasWindowsBoundary ||
    !privacyContract.hasLinuxBoundary ||
    !privacyContract.hasInspectionFailureBoundary ||
    !privacyContract.hasRetryBoundary ||
    !privacyContract.hasDefaultProtection
  ) {
    fail(
      `/user/data-and-safety: privacy/path/credential contract regressed (${JSON.stringify(privacyContract)})`,
    );
  } else {
    console.log("ok    /user/data-and-safety privacy contract");
  }

  await page.goto(`http://127.0.0.1:${port}/architecture/runtime`, {
    waitUntil: "networkidle",
  });
  const credentialRuntimeContract = await page.evaluate(() => {
    const heading = document.querySelector("#provider-credential-boundary");
    const headingLevel = heading ? Number(heading.tagName.slice(1)) : 7;
    const sectionElements = heading ? [heading] : [];
    for (
      let element = heading?.nextElementSibling;
      element;
      element = element.nextElementSibling
    ) {
      const level = /^H[1-6]$/.test(element.tagName)
        ? Number(element.tagName.slice(1))
        : undefined;
      if (level !== undefined && level <= headingLevel) break;
      sectionElements.push(element);
    }
    const text = sectionElements
      .map((element) => element.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      hasBoundary:
        heading?.textContent?.includes("Provider Credential Boundary") ?? false,
      hasAtomicBatchBoundary:
        text.includes("PATCH /v1/credentials/batch") &&
        text.includes("applies completely"),
      hasPresenceOnlyBoundary: text.includes("responses return presence only"),
      hasTriStateBoundary: text.includes("true, false, or null"),
      hasInspectionFailureBoundary:
        text.includes("configured=null") &&
        text.includes("unavailableReason=inspection_failed"),
      hasSanitizedOperationalFailure: text.includes(
        "503 credential_store_unavailable",
      ),
      hasFixedAllowlist: text.includes("fixed allowlist covers"),
      hasMissingOrEmptyBoundary: text.includes(
        "only for a missing or empty value",
      ),
      hasProcessLocalBoundary: text.includes(
        "only into that process's environment",
      ),
      hasNoHotReloadBoundary: text.includes("There is no hot reload"),
      hasPlatformBoundary: text.includes(
        "native Windows and Linux stores are planned",
      ),
      hasProviderStatusBoundary:
        text.includes("GET /v1/providers/status") &&
        text.includes(
          "sanitized Codex/Claude/Google configuration and readiness",
        ),
      hasRestartRequiredBoundary:
        text.includes("requires a JobCtrl restart") &&
        text.includes("before new values become ready"),
    };
  });
  if (Object.values(credentialRuntimeContract).some((present) => !present)) {
    fail(
      `/architecture/runtime: credential boundary regressed (${JSON.stringify(credentialRuntimeContract)})`,
    );
  } else {
    console.log("ok    /architecture/runtime credential boundary");
  }

  await page.goto(`http://127.0.0.1:${port}/comparison`, {
    waitUntil: "networkidle",
  });
  const comparisonDesktop = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".jh-compare-card")].map(
      (card) => {
        const box = card.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width };
      },
    );
    const headings = [...document.querySelectorAll(".vp-doc h2")].map(
      (heading) => (heading.textContent ?? "").replaceAll("\u200B", "").trim(),
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
  const cardsShareRow =
    comparisonDesktop.cards.length === 3 &&
    comparisonDesktop.cards.every(
      (card) =>
        Math.abs(card.y - comparisonDesktop.cards[0].y) < 2 &&
        Math.abs(card.width - comparisonDesktop.cards[0].width) < 2,
    );
  if (
    !cardsShareRow ||
    comparisonDesktop.pageOverflows ||
    comparisonDesktop.summaryRegionLabel !== "At-a-glance comparison table" ||
    comparisonDesktop.summaryRegionTabIndex !== "0" ||
    !comparisonDesktop.headings.includes(
      "JobCtrl's UI is part of the product",
    ) ||
    comparisonDesktop.headings.at(-1) !==
      "Appendix: evidence-backed capability matrix"
  ) {
    fail(
      `/comparison desktop: visual hierarchy or appendix order regressed (${JSON.stringify(comparisonDesktop)})`,
    );
  } else {
    console.log("ok    /comparison desktop visual hierarchy");
  }

  const comparisonEyebrow =
    "Pinned snapshots · issue threads checked · no marketing claims taken at face value";
  const comparisonCarousel = page.locator("[data-jh-comparison-carousel]");
  const comparisonCarouselCount = await comparisonCarousel.count();
  if (comparisonCarouselCount !== 1) {
    fail(
      `/comparison desktop: expected one screenshot carousel, found ${comparisonCarouselCount}`,
    );
  } else {
    const carouselState = async () =>
      comparisonCarousel.evaluate((carousel) => {
        const images = [...carousel.querySelectorAll("img")];
        const visibleImages = images.filter((image) => {
          const box = image.getBoundingClientRect();
          const style = getComputedStyle(image);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });
        return {
          caption:
            carousel.querySelector("figcaption")?.textContent?.trim() ?? "",
          imageCount: images.length,
          imageAlt: visibleImages[0]?.alt ?? "",
          status:
            carousel
              .querySelector(".jh-comparison-screenshot-carousel__status")
              ?.textContent?.trim() ?? "",
          visibleImageCount: visibleImages.length,
        };
      });
    const previous = comparisonCarousel.getByRole("button", {
      name: "Previous",
      exact: true,
    });
    const next = comparisonCarousel.getByRole("button", {
      name: "Next",
      exact: true,
    });
    const initialCarousel = await carouselState();
    const initialPreviousDisabled = await previous.isDisabled();
    const initialNextDisabled = await next.isDisabled();

    await next.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(
            "[data-jh-comparison-carousel] .jh-comparison-screenshot-carousel__status",
          )
          ?.textContent?.trim() === "2 of 2",
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-jh-comparison-carousel] img")
          ?.getAttribute("aria-label") ===
        "Expand image: Apply Review editing a tailored resume with audit evidence",
    );
    const applyReviewImage = comparisonCarousel.locator("img");
    const applyReviewZoomLabel =
      await applyReviewImage.getAttribute("aria-label");
    await applyReviewImage.click();
    await page.waitForSelector(".jh-lightbox", {
      state: "visible",
      timeout: 5000,
    });
    const expandedApplyReviewAlt = await page
      .locator(".jh-lightbox__content img")
      .getAttribute("alt");
    await page.locator('.jh-lightbox button[aria-label="Close"]').click();
    const nextCarousel = await carouselState();
    const nextPreviousDisabled = await previous.isDisabled();
    const nextNextDisabled = await next.isDisabled();

    await previous.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(
            "[data-jh-comparison-carousel] .jh-comparison-screenshot-carousel__status",
          )
          ?.textContent?.trim() === "1 of 2",
    );
    const restoredCarousel = await carouselState();
    const restoredPreviousDisabled = await previous.isDisabled();
    const restoredNextDisabled = await next.isDisabled();
    const eyebrowPresent = (await page.locator(".vp-doc").innerText()).includes(
      comparisonEyebrow,
    );

    if (
      eyebrowPresent ||
      initialCarousel.imageCount !== 1 ||
      initialCarousel.visibleImageCount !== 1 ||
      initialCarousel.imageAlt !==
        "Jobs table with fit scores, stages, and filters" ||
      initialCarousel.caption !==
        "Jobs — scored and filterable, with every score inspectable" ||
      initialCarousel.status !== "1 of 2" ||
      !initialPreviousDisabled ||
      initialNextDisabled ||
      nextCarousel.imageCount !== 1 ||
      nextCarousel.visibleImageCount !== 1 ||
      nextCarousel.imageAlt !==
        "Apply Review editing a tailored resume with audit evidence" ||
      nextCarousel.caption !==
        "Apply Review — edit and approve the exact resume that ships" ||
      nextCarousel.status !== "2 of 2" ||
      nextPreviousDisabled ||
      !nextNextDisabled ||
      applyReviewZoomLabel !==
        "Expand image: Apply Review editing a tailored resume with audit evidence" ||
      expandedApplyReviewAlt !==
        "Apply Review editing a tailored resume with audit evidence" ||
      restoredCarousel.imageCount !== 1 ||
      restoredCarousel.visibleImageCount !== 1 ||
      restoredCarousel.imageAlt !==
        "Jobs table with fit scores, stages, and filters" ||
      restoredCarousel.status !== "1 of 2" ||
      !restoredPreviousDisabled ||
      restoredNextDisabled
    ) {
      fail(
        `/comparison desktop: screenshot carousel state regressed (${JSON.stringify(
          {
            eyebrowPresent,
            initialCarousel,
            initialPreviousDisabled,
            initialNextDisabled,
            nextCarousel,
            nextPreviousDisabled,
            nextNextDisabled,
            applyReviewZoomLabel,
            expandedApplyReviewAlt,
            restoredCarousel,
            restoredPreviousDisabled,
            restoredNextDisabled,
          },
        )})`,
      );
    } else {
      console.log("ok    /comparison desktop screenshot carousel");
    }
  }

  await page.goto(`http://127.0.0.1:${port}/user/normal-flows`, {
    waitUntil: "networkidle",
  });
  const desktopJourneyLocator = page
    .locator(".vp-doc .jh-daily-journey")
    .first();
  await desktopJourneyLocator.waitFor({ state: "visible", timeout: 15000 });
  const desktopJourney = await desktopJourneyLocator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  if (
    desktopJourney.width < 320 ||
    desktopJourney.width > 820 ||
    desktopJourney.scrollWidth > desktopJourney.clientWidth + 1 ||
    desktopJourney.pageOverflows
  ) {
    fail(
      `/user/normal-flows: desktop journey overflows its content track (${JSON.stringify(desktopJourney)})`,
    );
  } else {
    console.log("ok    /user/normal-flows desktop journey");
  }
  const webPanelVisible = await page
    .locator('[data-jh-channel-panel="web"]')
    .first()
    .isVisible();
  const cliPanelInitiallyVisible = await page
    .locator('[data-jh-channel-panel="cli"]')
    .first()
    .isVisible();
  const webScreenshotsVisible = await page
    .locator('[data-jh-channel-panel="web"] img')
    .evaluateAll((imgs) => imgs.some((img) => img.getClientRects().length > 0));
  if (!webPanelVisible || cliPanelInitiallyVisible || !webScreenshotsVisible) {
    fail("/user/normal-flows: workflow selector does not default to Web app");
  }
  await page.locator('[data-jh-channel-tab="cli"]').click();
  await page.waitForFunction(
    () => document.documentElement.dataset.jhWorkflowSurface === "cli",
  );
  const cliSelected = await page
    .locator('[data-jh-channel-tab="cli"]')
    .getAttribute("aria-selected");
  const cliCommandVisible = await page
    .locator("text=jobctrl run discover")
    .first()
    .isVisible();
  const webPanelAfterCli = await page
    .locator('[data-jh-channel-panel="web"]')
    .first()
    .isVisible();
  const cliVisibleScreenshots = await page
    .locator(".vp-doc img")
    .evaluateAll(
      (imgs) => imgs.filter((img) => img.getClientRects().length > 0).length,
    );
  if (
    cliSelected !== "true" ||
    !cliCommandVisible ||
    webPanelAfterCli ||
    cliVisibleScreenshots > 0
  ) {
    fail(
      "/user/normal-flows: CLI workflow selector does not reveal CLI content",
    );
  } else {
    console.log("ok    /user/normal-flows workflow selector");
  }
  await page.locator('[data-jh-channel-tab="web"]').click();
  await page.waitForFunction(
    () => document.documentElement.dataset.jhWorkflowSurface === "web",
  );

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/screenshots`, {
    waitUntil: "networkidle",
  });
  const mobileTourImage = await page
    .locator(".vp-doc img")
    .first()
    .boundingBox();
  const customDesktopControlsVisible = await page
    .locator(".jh-sidebar-rail, .jh-sidebar-restore")
    .evaluateAll((elements) =>
      elements.some((element) => element.getClientRects().length > 0),
    );
  if (!mobileTourImage || mobileTourImage.width < 700) {
    fail(
      `/user/screenshots mobile: screenshot did not remain inspectable (${mobileTourImage?.width ?? 0}px)`,
    );
  } else if (customDesktopControlsVisible) {
    fail(
      "/user/screenshots mobile: desktop sidebar controls displaced the stock mobile drawer",
    );
  }
  await page.locator("button.menu").click();
  await page.waitForTimeout(200);
  const mobileSidebar = page.locator(".VPSidebar");
  await mobileSidebar.waitFor({ state: "visible", timeout: 5000 });
  const mobileMenuText = await mobileSidebar.innerText();
  const missingMobileSidebarLabels = REQUIRED_SIDEBAR_LABELS.filter(
    (label) => !mobileMenuText.includes(label),
  );
  if (missingMobileSidebarLabels.length > 0) {
    fail(
      `/user/screenshots mobile: unified menu is missing ${missingMobileSidebarLabels.join(", ")}`,
    );
  } else {
    console.log("ok    /user/screenshots mobile menu");
  }

  await page.goto(`http://127.0.0.1:${port}/user/normal-flows`, {
    waitUntil: "networkidle",
  });
  const mobileJourneyLocator = page
    .locator(".vp-doc .jh-daily-journey")
    .first();
  await mobileJourneyLocator.waitFor({ state: "visible", timeout: 15000 });
  const mobileJourney = await mobileJourneyLocator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  if (
    mobileJourney.width > MOBILE_VIEWPORT.width - 24 ||
    mobileJourney.width < 260 ||
    mobileJourney.scrollWidth > mobileJourney.clientWidth + 1 ||
    mobileJourney.pageOverflows
  ) {
    fail(
      `/user/normal-flows mobile: journey overflows its content track (${JSON.stringify(mobileJourney)})`,
    );
  } else {
    console.log("ok    /user/normal-flows mobile journey");
  }

  await page.goto(`http://127.0.0.1:${port}/comparison`, {
    waitUntil: "networkidle",
  });
  const comparisonCarouselMobile = page.locator(
    "[data-jh-comparison-carousel]",
  );
  await comparisonCarouselMobile.scrollIntoViewIfNeeded();
  await comparisonCarouselMobile
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          "[data-jh-comparison-carousel] .jh-comparison-screenshot-carousel__status",
        )
        ?.textContent?.trim() === "2 of 2",
  );
  const comparisonMobile = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".jh-compare-card")].map(
      (card) => {
        const box = card.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width };
      },
    );
    const summary = document.querySelector(".jh-compare-table-wrap");
    const carousel = document.querySelector("[data-jh-comparison-carousel]");
    const carouselImage = carousel?.querySelector("img");
    const carouselImageBox = carouselImage?.getBoundingClientRect();
    return {
      cards,
      carouselImage: carouselImageBox
        ? {
            height: carouselImageBox.height,
            left: carouselImageBox.left,
            right: carouselImageBox.right,
            width: carouselImageBox.width,
          }
        : null,
      carouselImageCount: carousel?.querySelectorAll("img").length ?? 0,
      carouselStatus:
        carousel
          ?.querySelector(".jh-comparison-screenshot-carousel__status")
          ?.textContent?.trim() ?? "",
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      summaryClientWidth: summary?.clientWidth ?? 0,
      summaryScrollWidth: summary?.scrollWidth ?? 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  const cardsStack =
    comparisonMobile.cards.length === 3 &&
    comparisonMobile.cards.every(
      (card, index) =>
        Math.abs(card.x - comparisonMobile.cards[0].x) < 2 &&
        (index === 0 || card.y > comparisonMobile.cards[index - 1].y),
    );
  const summaryRegion = page.locator(".jh-compare-table-wrap");
  await summaryRegion.focus();
  const beforeArrow = await summaryRegion.evaluate(
    (element) => element.scrollLeft,
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  const afterArrow = await summaryRegion.evaluate(
    (element) => element.scrollLeft,
  );
  if (
    !cardsStack ||
    comparisonMobile.pageOverflows ||
    comparisonMobile.summaryScrollWidth <=
      comparisonMobile.summaryClientWidth + 80 ||
    afterArrow <= beforeArrow ||
    comparisonMobile.carouselImageCount !== 1 ||
    comparisonMobile.carouselStatus !== "2 of 2" ||
    !comparisonMobile.carouselImage ||
    comparisonMobile.carouselImage.left < -1 ||
    comparisonMobile.carouselImage.right > comparisonMobile.viewportWidth + 1 ||
    comparisonMobile.carouselImage.width < 220 ||
    comparisonMobile.carouselImage.height >
      comparisonMobile.viewportHeight * 0.8
  ) {
    fail(
      `/comparison mobile: cards, carousel, or keyboard-scroll table regressed (${JSON.stringify(
        {
          ...comparisonMobile,
          beforeArrow,
          afterArrow,
        },
      )})`,
    );
  } else {
    console.log(
      "ok    /comparison mobile layout, screenshot carousel, and keyboard table scroll",
    );
  }

  await page.goto(`http://127.0.0.1:${port}/user/data-and-safety`, {
    waitUntil: "networkidle",
  });
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
    privacyMobile.pageOverflows ||
    privacyMobile.headerCount !== 2 ||
    privacyMobile.tableLeft < 0 ||
    privacyMobile.tableRight > privacyMobile.viewportWidth + 1
  ) {
    fail(
      `/user/data-and-safety mobile: quick-answer table is not viewport-contained (${JSON.stringify(privacyMobile)})`,
    );
  } else {
    console.log("ok    /user/data-and-safety mobile privacy table");
  }

  // The responsive checks above deliberately leave the page at the mobile
  // breakpoint after opening the stock navigation drawer. Search privacy is a
  // separate semantic check, so establish its own clean viewport precondition
  // instead of inheriting drawer state from an unrelated interaction.
  await page.setViewportSize(BASE_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.locator(".DocSearch-Button").click();
  await page.locator("input.search-input").fill("privacy");
  await page.waitForFunction(
    () => document.querySelectorAll(".VPLocalSearchBox a.result").length > 0,
    { timeout: 5000 },
  );
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll(
          ".VPLocalSearchBox .back-button, .VPLocalSearchBox .toggle-layout-button, .VPLocalSearchBox .clear-button",
        ),
      ].every((button) => button.getAttribute("aria-label")),
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
    fail(
      `/ search: ${searchState.unlabeledButtons} local-search icon button(s) lack aria-label`,
    );
  }
  if (
    !searchState.hrefs.some(
      (href) =>
        href.startsWith("/user/security") ||
        href.startsWith("/user/data-and-safety"),
    )
  ) {
    fail(
      `/ search privacy: user-facing privacy/security docs missing from top results (${searchState.hrefs.join(", ")})`,
    );
  } else {
    console.log("ok    / search privacy");
  }
} finally {
  await browser.close();
  preview.kill("SIGTERM");
}

console.log(
  failures
    ? `DOCS RUNTIME CHECK FAIL — ${failures}`
    : "DOCS RUNTIME CHECK PASS",
);
process.exit(failures ? 1 : 0);
