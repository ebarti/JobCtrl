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
  { path: "/guides/", visualSelector: null, images: false },
  {
    path: "/guides/local-first-job-search-automation",
    visualSelector: null,
    images: false,
  },
  {
    path: "/guides/open-source-job-application-tracker",
    visualSelector: null,
    images: false,
  },
  {
    path: "/guides/resume-tailoring-without-fabrication",
    visualSelector: null,
    images: false,
  },
  {
    path: "/guides/evidence-based-job-fit-scoring",
    visualSelector: null,
    images: false,
  },
  {
    path: "/guides/at-most-once-job-application-submission",
    visualSelector: ".mermaid svg",
    images: false,
  },
  {
    path: "/guides/temporal-workflows-desktop-app",
    visualSelector: null,
    images: false,
  },
  { path: "/architecture/", visualSelector: ".system-topology", images: false },
  { path: "/developer/", visualSelector: null, images: false },
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
  { path: "/user/getting-started", visualSelector: null, images: false },
  { path: "/user/product-tour", visualSelector: null, images: true },
  {
    path: "/user/data-and-safety",
    visualSelector: ".data-boundary",
    images: false,
  },
  {
    path: "/user/scoring-and-employer-analysis",
    visualSelector: null,
    images: false,
  },
  { path: "/user/discovery", visualSelector: null, images: false },
  { path: "/user/apply", visualSelector: null, images: false },
  {
    path: "/user/candidate-profile",
    visualSelector: null,
    images: false,
  },
  {
    path: "/user/enrichment-and-extraction",
    visualSelector: null,
    images: false,
  },
  {
    path: "/user/materials-and-tailoring",
    visualSelector: ".mermaid svg",
    images: false,
  },
  {
    path: "/user/outcomes-and-feedback",
    visualSelector: null,
    images: false,
  },
  {
    path: "/user/contacts-and-outreach",
    visualSelector: null,
    images: false,
  },
  {
    path: "/user/compensation-evidence",
    visualSelector: null,
    images: false,
  },
  { path: "/comparison", visualSelector: null, images: true },
];

const SOCIAL_METADATA_ROUTES = new Set([
  "/",
  "/comparison",
  "/guides/",
  "/guides/local-first-job-search-automation",
  "/guides/open-source-job-application-tracker",
  "/guides/resume-tailoring-without-fabrication",
  "/guides/evidence-based-job-fit-scoring",
  "/guides/at-most-once-job-application-submission",
  "/guides/temporal-workflows-desktop-app",
  "/architecture/",
  "/developer/",
  "/user/apply",
  "/user/data-and-safety",
  "/user/getting-started",
  "/user/materials-and-tailoring",
  "/user/normal-flows",
  "/user/product-tour",
  "/user/scoring-and-employer-analysis",
]);
const SOCIAL_IMAGE_URL = "https://jobctrl.dev/assets/brand/social-preview.png";
const SOCIAL_IMAGE_ALT =
  "JobCtrl: run your job search, keep your data, and inspect key AI-assisted decisions.";
const DOCS_GOOGLE_TAG_ORIGIN = "https://www.googletagmanager.com";
const DOCS_GOOGLE_TAG_MEASUREMENT_ID = "G-KB495KG6MS";
const DOCS_GOOGLE_TAG_SCRIPT_ID = "jobctrl-docs-google-analytics";
const DOCS_ANALYTICS_CONSENT_STORAGE_KEY =
  "jobctrl-docs-analytics-consent-v1";
const observedSocialDescriptions = new Map();

const LIFECYCLE_EXPLANATION_CONTRACTS = [
  {
    path: "/user/discovery",
    heading: "#runtime-sources-and-schedule",
    selectors: [
      "#runtime-setting-job-boards",
      "#runtime-setting-parallel-source-families",
      "#runtime-setting-schedule-cron",
    ],
    tokens: ["SQLite", "four", "SKIP", "task-queue depth"],
  },
  {
    path: "/user/apply",
    heading: "#approval-and-automation-modes",
    selectors: [
      "#candidate-profile-application-fields",
      "#approval-and-automation-modes",
      "#browser-apply-automation",
    ],
    tokens: [
      "missing_profile_data:<field>",
      "autoApply",
      "applyApprovalRequired",
      "at-most-once",
      "CAPTCHA",
    ],
  },
  {
    path: "/user/candidate-profile",
    heading: "#how-profile-data-becomes-runtime-evidence",
    labels: [
      "Import creates a draft.",
      "Save validates and normalizes.",
      "Work receives an immutable snapshot.",
      "Consumers bind to the version they used.",
      "Propagation remains explicit and recoverable.",
    ],
    tokens: ["ProfileSnapshot", "profile version", "Apply approval"],
  },
  {
    path: "/user/enrichment-and-extraction",
    heading: "#how-a-lead-becomes-a-usable-snapshot",
    labels: [
      "Fetch once, then walk the configured extraction cascade.",
      "Verify active state independently.",
      "Assign confidence from the posting-content evidence.",
      "Quarantine instead of guessing.",
      "Surface duplicate candidates from content evidence.",
    ],
    tokens: [
      "JSON-LD",
      "200 characters",
      "400 characters",
      "1.0",
      "0.95",
      "0.85",
      "unknown active state",
      "operator override",
    ],
  },
  {
    path: "/user/materials-and-tailoring",
    heading: "#how-jobctrl-chooses-a-resume",
    selectors: [".mermaid svg"],
    labels: [
      "Build one deterministic plan.",
      "Ask each ready generator for structured content.",
      "Validate the assembled resume, not just model JSON.",
      "Repair bounded quality failures.",
      "Require approval from every enabled gate.",
      "Select and persist the best clean candidate.",
    ],
    tokens: [
      "actual candidate text",
      "8/10",
      "85%",
      "0.82",
      "PASS",
      "six-persona",
      "last accepted generation",
    ],
  },
  {
    path: "/user/outcomes-and-feedback",
    heading: "#how-email-becomes-an-outcome-suggestion",
    labels: [
      "Start from known applications.",
      "Score metadata before reading a body.",
      "Classify with fixed phrase rules.",
      "Wait for a human decision.",
      "Gate analytics by sample size.",
    ],
    tokens: [
      "applied_at",
      "discovered_at",
      "45-day",
      "0.70",
      "0.20",
      "five applied records",
      "five response-time samples",
    ],
  },
  {
    path: "/user/contacts-and-outreach",
    heading: "#how-research-and-draft-approval-work",
    labels: [
      "Check source policy before research.",
      "Keep findings as proposals.",
      "Ground the actual draft.",
      "Run the approval stack.",
      "Persist the gate result as authority.",
      "Stop at the clipboard.",
    ],
    tokens: [
      "broad-web discovery",
      "needs_review",
      "PASS",
      "0.82",
      "persisted approved draft",
    ],
  },
  {
    path: "/user/compensation-evidence",
    heading: "#how-compensation-is-calculated",
    labels: [
      "Record parse state.",
      "Interpret bounds conservatively.",
      "Annualize only with a known or narrowly inferred period.",
      "Keep cash and equity separate.",
      "Discover reusable benchmark slices.",
      "Refresh only missing or due slices.",
      "Normalize direct evidence.",
      "Extrapolate missing geographies audibly.",
      "Materialize the last good result.",
    ],
    tokens: [
      "parsed_range",
      "2,080",
      "12,000",
      "seven-day freshness window",
      "Euro Top Tech",
      "Levels.fyi",
      "Glassdoor",
      "source-dated ECB exchange rates",
      "0.1x",
      "10x",
      "factor_out_of_bounds",
      "Discovery",
      "explicit compensation refresh",
      "passive read",
    ],
  },
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

async function assertSocialMetadata(page, route) {
  const metadata = await page.evaluate(() => {
    const values = (selector, attribute = "content") =>
      Array.from(document.head.querySelectorAll(selector)).map((element) =>
        element.getAttribute(attribute),
      );
    return {
      title: document.title,
      description: values('meta[name="description"]')[0],
      canonical: values('link[rel="canonical"]', "href"),
      ogType: values('meta[property="og:type"]'),
      ogSiteName: values('meta[property="og:site_name"]'),
      ogUrl: values('meta[property="og:url"]'),
      ogTitle: values('meta[property="og:title"]'),
      ogDescription: values('meta[property="og:description"]'),
      ogImage: values('meta[property="og:image"]'),
      ogImageWidth: values('meta[property="og:image:width"]'),
      ogImageHeight: values('meta[property="og:image:height"]'),
      ogImageAlt: values('meta[property="og:image:alt"]'),
      twitterCard: values('meta[name="twitter:card"]'),
      twitterTitle: values('meta[name="twitter:title"]'),
      twitterDescription: values('meta[name="twitter:description"]'),
      twitterImage: values('meta[name="twitter:image"]'),
      twitterImageAlt: values('meta[name="twitter:image:alt"]'),
    };
  });
  const expectedCanonical = `https://jobctrl.dev${route}`;
  const expected = {
    canonical: [expectedCanonical],
    ogType: ["website"],
    ogSiteName: ["JobCtrl"],
    ogUrl: [expectedCanonical],
    ogTitle: [metadata.title],
    ogDescription: [metadata.description],
    ogImage: [SOCIAL_IMAGE_URL],
    ogImageWidth: ["1200"],
    ogImageHeight: ["630"],
    ogImageAlt: [SOCIAL_IMAGE_ALT],
    twitterCard: ["summary_large_image"],
    twitterTitle: [metadata.title],
    twitterDescription: [metadata.description],
    twitterImage: [SOCIAL_IMAGE_URL],
    twitterImageAlt: [SOCIAL_IMAGE_ALT],
  };
  const mismatches = Object.entries(expected)
    .filter(([key, values]) => JSON.stringify(metadata[key]) !== JSON.stringify(values))
    .map(([key]) => key);
  if (!metadata.title || !metadata.description || mismatches.length > 0) {
    fail(`${route}: canonical or social metadata is missing, duplicated, or conflicting (${mismatches.join(", ")})`);
  } else if (observedSocialDescriptions.has(metadata.description)) {
    fail(
      `${route}: search description duplicates ${observedSocialDescriptions.get(metadata.description)}`,
    );
  } else {
    observedSocialDescriptions.set(metadata.description, route);
    console.log(`ok    ${route} canonical and social metadata`);
  }
}

async function assertHomepageSearchIdentity(page) {
  const identity = await page.evaluate(() => {
    const element = document.querySelector(
      'script#jobctrl-structured-data[type="application/ld+json"]',
    );
    return {
      title: document.title,
      data: element ? JSON.parse(element.textContent ?? "{}") : null,
    };
  });
  const graph = Array.isArray(identity.data?.["@graph"])
    ? identity.data["@graph"]
    : [];
  const organization = graph.find((node) => node?.["@type"] === "Organization");
  const website = graph.find((node) => node?.["@type"] === "WebSite");
  const software = graph.find(
    (node) => node?.["@type"] === "SoftwareApplication",
  );
  if (
    identity.title !== "JobCtrl.dev — Local-first job search automation" ||
    organization?.name !== "JobCtrl" ||
    organization?.url !== "https://jobctrl.dev/" ||
    !organization?.sameAs?.includes("https://github.com/ebarti/JobCtrl") ||
    website?.name !== "JobCtrl" ||
    website?.alternateName !== "jobctrl.dev" ||
    !website?.disambiguatingDescription?.includes("jobctrl.dev") ||
    website?.url !== "https://jobctrl.dev/" ||
    software?.name !== "JobCtrl" ||
    software?.alternateName !== "JobCtrl.dev" ||
    !software?.disambiguatingDescription?.includes("github.com/ebarti/JobCtrl") ||
    software?.applicationSubCategory !== "Job search automation" ||
    software?.offers?.["@type"] !== "Offer" ||
    software?.offers?.price !== "0" ||
    software?.offers?.priceCurrency !== "USD"
  ) {
    fail(`/: homepage search identity is incomplete (${JSON.stringify(identity)})`);
  } else {
    console.log("ok    / homepage search identity");
  }
}

async function assertDocsAnalyticsConsent(page, baseUrl, fail) {
  const googleTagRequests = [];
  const stubGoogleTag = async (route) => {
    googleTagRequests.push(route.request().url());
    await route.fulfill({
      contentType: "application/javascript",
      body: "",
    });
  };
  await page.route(`${DOCS_GOOGLE_TAG_ORIGIN}/**`, stubGoogleTag);

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  const initialState = await page.evaluate(
    ({ scriptId, storageKey }) => {
      const banner = document.querySelector("[data-jh-cookie-banner]");
      const box = banner?.getBoundingClientRect();
      return {
        banner: box
          ? {
              bottom: box.bottom,
              left: box.left,
              right: box.right,
              top: box.top,
            }
          : null,
        choice: localStorage.getItem(storageKey),
        dataLayerPresent: "dataLayer" in window,
        gtagPresent: "gtag" in window,
        pageOverflows:
          document.documentElement.scrollWidth > window.innerWidth,
        scriptCount: document.querySelectorAll(`#${scriptId}`).length,
      };
    },
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  const initialActions = await page
    .locator("[data-jh-cookie-banner] button")
    .allTextContents();
  if (
    !initialState.banner ||
    initialState.banner.left < 0 ||
    initialState.banner.right > MOBILE_VIEWPORT.width + 1 ||
    initialState.banner.top < 0 ||
    initialState.banner.bottom > MOBILE_VIEWPORT.height + 1 ||
    initialState.pageOverflows ||
    initialState.choice !== null ||
    initialState.scriptCount !== 0 ||
    initialState.dataLayerPresent ||
    initialState.gtagPresent ||
    googleTagRequests.length !== 0 ||
    !initialActions.some((label) => label.includes("Decline analytics")) ||
    !initialActions.some((label) => label.includes("Accept analytics"))
  ) {
    fail(
      `/: analytics consent did not start private, optional, and viewport-contained (${JSON.stringify(
        { initialState, initialActions, googleTagRequests },
      )})`,
    );
  } else {
    console.log("ok    / analytics defaults to no Google request");
  }

  await page
    .getByRole("button", { name: "Decline analytics", exact: true })
    .click();
  const declinedState = await page.evaluate(
    ({ scriptId, storageKey }) => ({
      activeHref: document.activeElement?.getAttribute("href") ?? "",
      bannerCount: document.querySelectorAll("[data-jh-cookie-banner]").length,
      choice: localStorage.getItem(storageKey),
      dataLayerPresent: "dataLayer" in window,
      gtagPresent: "gtag" in window,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  if (
    declinedState.activeHref !== "/" ||
    declinedState.bannerCount !== 0 ||
    declinedState.choice !== "denied" ||
    declinedState.scriptCount !== 0 ||
    declinedState.dataLayerPresent ||
    declinedState.gtagPresent ||
    googleTagRequests.length !== 0
  ) {
    fail(
      `/: declining analytics loaded or retained the Google tag (${JSON.stringify(
        { declinedState, googleTagRequests },
      )})`,
    );
  } else {
    console.log("ok    / analytics decline persists without Google");
  }

  await page
    .getByRole("button", { name: "Cookie settings", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Optional documentation analytics",
      exact: true,
    })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Accept analytics", exact: true })
    .click();
  await page.waitForFunction(
    (scriptId) => Boolean(document.getElementById(scriptId)),
    DOCS_GOOGLE_TAG_SCRIPT_ID,
  );
  await page.waitForTimeout(100);

  const acceptedState = await page.evaluate(
    ({ measurementId, scriptId, storageKey }) => {
      const commands = (window.dataLayer ?? []).map((command) =>
        Array.from(command),
      );
      return {
        choice: localStorage.getItem(storageKey),
        config: commands.find(
          (command) =>
            command[0] === "config" && command[1] === measurementId,
        ),
        consent: commands.find(
          (command) =>
            command[0] === "consent" && command[1] === "default",
        ),
        pageViews: commands.filter(
          (command) =>
            command[0] === "event" && command[1] === "page_view",
        ),
        scriptSrc: document
          .getElementById(scriptId)
          ?.getAttribute("src"),
      };
    },
    {
      measurementId: DOCS_GOOGLE_TAG_MEASUREMENT_ID,
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  const acceptedConfig = acceptedState.config?.[2];
  const acceptedConsent = acceptedState.consent?.[2];
  if (
    acceptedState.choice !== "granted" ||
    acceptedState.scriptSrc !==
      `${DOCS_GOOGLE_TAG_ORIGIN}/gtag/js?id=${DOCS_GOOGLE_TAG_MEASUREMENT_ID}` ||
    googleTagRequests.length !== 1 ||
    googleTagRequests[0] !==
      `${DOCS_GOOGLE_TAG_ORIGIN}/gtag/js?id=${DOCS_GOOGLE_TAG_MEASUREMENT_ID}` ||
    acceptedState.pageViews.length !== 1 ||
    acceptedState.pageViews[0]?.[2]?.page_path !== "/" ||
    acceptedState.pageViews[0]?.[2]?.page_location !== `${baseUrl}/` ||
    acceptedConfig?.send_page_view !== false ||
    acceptedConfig?.allow_google_signals !== false ||
    acceptedConfig?.allow_ad_personalization_signals !== false ||
    acceptedConfig?.cookie_domain !== "none" ||
    acceptedConfig?.cookie_expires !== 15_544_800 ||
    acceptedConfig?.cookie_update !== false ||
    acceptedConsent?.analytics_storage !== "granted" ||
    acceptedConsent?.ad_storage !== "denied" ||
    acceptedConsent?.ad_user_data !== "denied" ||
    acceptedConsent?.ad_personalization !== "denied"
  ) {
    fail(
      `/: accepting analytics did not load the bounded Google tag (${JSON.stringify(
        { acceptedState, googleTagRequests },
      )})`,
    );
  } else {
    console.log("ok    / analytics accept loads the bounded Google tag");
  }

  await page.setViewportSize(BASE_VIEWPORT);
  await page
    .locator('.VPHome .VPHero a[href="/user/product-tour"]')
    .click();
  await page.waitForURL(`${baseUrl}/user/product-tour`);
  await page.waitForFunction(
    () =>
      (window.dataLayer ?? []).filter(
        (command) =>
          command[0] === "event" && command[1] === "page_view",
      ).length === 2,
  );
  const spaPageViews = await page.evaluate(() =>
    (window.dataLayer ?? [])
      .filter(
        (command) =>
          command[0] === "event" && command[1] === "page_view",
      )
      .map((command) => Array.from(command)),
  );
  if (
    spaPageViews.at(-1)?.[2]?.page_path !== "/user/product-tour" ||
    spaPageViews.at(-1)?.[2]?.page_location !==
      `${baseUrl}/user/product-tour` ||
    spaPageViews.at(-1)?.[2]?.page_referrer !== `${baseUrl}/` ||
    !String(spaPageViews.at(-1)?.[2]?.page_title).includes("Product Tour")
  ) {
    fail(
      `/user/product-tour: SPA analytics page view was missing or overbroad (${JSON.stringify(
        spaPageViews,
      )})`,
    );
  } else {
    console.log("ok    /user/product-tour analytics tracks SPA navigation");
  }

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    (scriptId) => Boolean(document.getElementById(scriptId)),
    DOCS_GOOGLE_TAG_SCRIPT_ID,
  );
  await page.waitForTimeout(100);
  const restoredGrant = await page.evaluate(
    ({ storageKey }) => ({
      bannerCount: document.querySelectorAll("[data-jh-cookie-banner]").length,
      choice: localStorage.getItem(storageKey),
      pageViews: (window.dataLayer ?? []).filter(
        (command) =>
          command[0] === "event" && command[1] === "page_view",
      ).length,
    }),
    { storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY },
  );
  if (
    restoredGrant.choice !== "granted" ||
    restoredGrant.bannerCount !== 0 ||
    restoredGrant.pageViews !== 1 ||
    googleTagRequests.length !== 2
  ) {
    fail(
      `/user/product-tour: analytics grant did not restore cleanly (${JSON.stringify(
        { restoredGrant, googleTagRequests },
      )})`,
    );
  } else {
    console.log("ok    / analytics grant restores without reopening banner");
  }

  await page.evaluate(() => {
    document.cookie = "_ga=GA1.1.test; Path=/; SameSite=Lax";
    document.cookie = "_ga_KB495KG6MS=GS1.1.test; Path=/; SameSite=Lax";
    document.cookie = "_gid=test; Path=/; SameSite=Lax";
  });
  await page
    .getByRole("button", { name: "Cookie settings", exact: true })
    .click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page
      .getByRole("button", { name: "Decline analytics", exact: true })
      .click(),
  ]);
  const withdrawnState = await page.evaluate(
    ({ scriptId, storageKey }) => ({
      analyticsCookies: document.cookie
        .split(";")
        .map((cookie) => cookie.split("=", 1)[0]?.trim())
        .filter(
          (name) =>
            name?.startsWith("_ga") ||
            name?.startsWith("_gid") ||
            name?.startsWith("_gat"),
        ),
      bannerCount: document.querySelectorAll("[data-jh-cookie-banner]").length,
      choice: localStorage.getItem(storageKey),
      dataLayerPresent: "dataLayer" in window,
      gtagPresent: "gtag" in window,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  if (
    withdrawnState.choice !== "denied" ||
    withdrawnState.bannerCount !== 0 ||
    withdrawnState.scriptCount !== 0 ||
    withdrawnState.dataLayerPresent ||
    withdrawnState.gtagPresent ||
    withdrawnState.analyticsCookies.length !== 0
  ) {
    fail(
      `/user/product-tour: analytics withdrawal did not stop and clean up tracking (${JSON.stringify(
        withdrawnState,
      )})`,
    );
  } else {
    console.log("ok    / analytics withdrawal stops tracking and clears cookies");
  }

  await page
    .locator('.VPNavBarTitle a[href="/"]')
    .click();
  await page.waitForURL(`${baseUrl}/`);
  const postWithdrawalState = await page.evaluate(
    ({ scriptId, storageKey }) => ({
      choice: localStorage.getItem(storageKey),
      dataLayerPresent: "dataLayer" in window,
      gtagPresent: "gtag" in window,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  if (
    postWithdrawalState.choice !== "denied" ||
    postWithdrawalState.scriptCount !== 0 ||
    postWithdrawalState.dataLayerPresent ||
    postWithdrawalState.gtagPresent ||
    googleTagRequests.length !== 2
  ) {
    fail(
      `/: tracking resumed after withdrawal (${JSON.stringify(
        { postWithdrawalState, googleTagRequests },
      )})`,
    );
  } else {
    console.log("ok    / analytics remains disabled after SPA navigation");
  }

  await page.reload({ waitUntil: "networkidle" });
  const restoredDenial = await page.evaluate(
    ({ scriptId, storageKey }) => ({
      bannerCount: document.querySelectorAll("[data-jh-cookie-banner]").length,
      choice: localStorage.getItem(storageKey),
      dataLayerPresent: "dataLayer" in window,
      gtagPresent: "gtag" in window,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  if (
    restoredDenial.choice !== "denied" ||
    restoredDenial.bannerCount !== 0 ||
    restoredDenial.scriptCount !== 0 ||
    restoredDenial.dataLayerPresent ||
    restoredDenial.gtagPresent ||
    googleTagRequests.length !== 2
  ) {
    fail(
      `/: analytics denial did not persist across reload (${JSON.stringify(
        { restoredDenial, googleTagRequests },
      )})`,
    );
  } else {
    console.log("ok    / analytics denial persists across reload");
  }

  await page
    .getByRole("button", { name: "Cookie settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Accept analytics", exact: true })
    .click();
  await page.waitForFunction(
    (scriptId) => Boolean(document.getElementById(scriptId)),
    DOCS_GOOGLE_TAG_SCRIPT_ID,
  );

  const secondPage = await page.context().newPage();
  await secondPage.setViewportSize(BASE_VIEWPORT);
  await secondPage.route(`${DOCS_GOOGLE_TAG_ORIGIN}/**`, stubGoogleTag);
  await secondPage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await secondPage.waitForFunction(
    (scriptId) => Boolean(document.getElementById(scriptId)),
    DOCS_GOOGLE_TAG_SCRIPT_ID,
  );

  const consentedTabStates = await Promise.all(
    [page, secondPage].map((tab) =>
      tab.evaluate(
        ({ scriptId, storageKey }) => ({
          choice: localStorage.getItem(storageKey),
          pageViews: (window.dataLayer ?? []).filter(
            (command) =>
              command[0] === "event" && command[1] === "page_view",
          ).length,
          scriptCount: document.querySelectorAll(`#${scriptId}`).length,
        }),
        {
          scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
          storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
        },
      ),
    ),
  );

  await page
    .getByRole("button", { name: "Cookie settings", exact: true })
    .click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    secondPage.waitForNavigation({ waitUntil: "networkidle" }),
    page
      .getByRole("button", { name: "Decline analytics", exact: true })
      .click(),
  ]);

  const deniedTabStates = await Promise.all(
    [page, secondPage].map((tab) =>
      tab.evaluate(
        ({ scriptId, storageKey }) => ({
          bannerCount:
            document.querySelectorAll("[data-jh-cookie-banner]").length,
          choice: localStorage.getItem(storageKey),
          dataLayerPresent: "dataLayer" in window,
          gtagPresent: "gtag" in window,
          scriptCount: document.querySelectorAll(`#${scriptId}`).length,
        }),
        {
          scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
          storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
        },
      ),
    ),
  );
  const requestsAfterCrossTabDenial = googleTagRequests.length;

  await secondPage
    .locator('.VPHome .VPHero a[href="/user/product-tour"]')
    .click();
  await secondPage.waitForURL(`${baseUrl}/user/product-tour`);
  const secondTabPostDenial = await secondPage.evaluate(
    ({ scriptId, storageKey }) => ({
      choice: localStorage.getItem(storageKey),
      dataLayerPresent: "dataLayer" in window,
      gtagPresent: "gtag" in window,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );

  await page
    .getByRole("button", { name: "Cookie settings", exact: true })
    .click();
  await Promise.all([
    secondPage.waitForNavigation({ waitUntil: "networkidle" }),
    page
      .getByRole("button", { name: "Accept analytics", exact: true })
      .click(),
  ]);
  await Promise.all(
    [page, secondPage].map((tab) =>
      tab.waitForFunction(
        (scriptId) => Boolean(document.getElementById(scriptId)),
        DOCS_GOOGLE_TAG_SCRIPT_ID,
      ),
    ),
  );

  await secondPage
    .getByRole("button", { name: "Cookie settings", exact: true })
    .click();
  const synchronizedGrantState = await secondPage.evaluate(
    ({ scriptId, storageKey }) => ({
      bannerText:
        document.querySelector("[data-jh-cookie-banner]")?.textContent ?? "",
      choice: localStorage.getItem(storageKey),
      pageViews: (window.dataLayer ?? []).filter(
        (command) =>
          command[0] === "event" && command[1] === "page_view",
      ).length,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    secondPage.waitForNavigation({ waitUntil: "networkidle" }),
    secondPage
      .getByRole("button", { name: "Decline analytics", exact: true })
      .click(),
  ]);
  const synchronizedDenialStates = await Promise.all(
    [page, secondPage].map((tab) =>
      tab.evaluate(
        ({ scriptId, storageKey }) => ({
          bannerCount:
            document.querySelectorAll("[data-jh-cookie-banner]").length,
          choice: localStorage.getItem(storageKey),
          dataLayerPresent: "dataLayer" in window,
          gtagPresent: "gtag" in window,
          scriptCount: document.querySelectorAll(`#${scriptId}`).length,
        }),
        {
          scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
          storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
        },
      ),
    ),
  );
  const requestsAfterSynchronizedDenial = googleTagRequests.length;

  await secondPage
    .locator('.VPNavBarTitle a[href="/"]')
    .click();
  await secondPage.waitForURL(`${baseUrl}/`);
  const secondTabAfterSynchronizedDenial = await secondPage.evaluate(
    ({ scriptId, storageKey }) => ({
      choice: localStorage.getItem(storageKey),
      dataLayerPresent: "dataLayer" in window,
      gtagPresent: "gtag" in window,
      scriptCount: document.querySelectorAll(`#${scriptId}`).length,
    }),
    {
      scriptId: DOCS_GOOGLE_TAG_SCRIPT_ID,
      storageKey: DOCS_ANALYTICS_CONSENT_STORAGE_KEY,
    },
  );
  await secondPage.close();

  if (
    consentedTabStates.some(
      (state) =>
        state.choice !== "granted" ||
        state.pageViews !== 1 ||
        state.scriptCount !== 1,
    ) ||
    deniedTabStates.some(
      (state) =>
        state.choice !== "denied" ||
        state.bannerCount !== 0 ||
        state.scriptCount !== 0 ||
        state.dataLayerPresent ||
        state.gtagPresent,
    ) ||
    requestsAfterCrossTabDenial !== 4 ||
    secondTabPostDenial.choice !== "denied" ||
    secondTabPostDenial.scriptCount !== 0 ||
    secondTabPostDenial.dataLayerPresent ||
    secondTabPostDenial.gtagPresent ||
    synchronizedGrantState.choice !== "granted" ||
    synchronizedGrantState.scriptCount !== 1 ||
    synchronizedGrantState.pageViews !== 1 ||
    !synchronizedGrantState.bannerText.includes(
      "Current choice: analytics enabled",
    ) ||
    synchronizedDenialStates.some(
      (state) =>
        state.choice !== "denied" ||
        state.bannerCount !== 0 ||
        state.scriptCount !== 0 ||
        state.dataLayerPresent ||
        state.gtagPresent,
    ) ||
    requestsAfterSynchronizedDenial !== 6 ||
    secondTabAfterSynchronizedDenial.choice !== "denied" ||
    secondTabAfterSynchronizedDenial.scriptCount !== 0 ||
    secondTabAfterSynchronizedDenial.dataLayerPresent ||
    secondTabAfterSynchronizedDenial.gtagPresent ||
    googleTagRequests.length !== requestsAfterSynchronizedDenial
  ) {
    fail(
      `/: cross-tab analytics withdrawal left stale consent (${JSON.stringify(
        {
          consentedTabStates,
          deniedTabStates,
          secondTabPostDenial,
          synchronizedGrantState,
          synchronizedDenialStates,
          secondTabAfterSynchronizedDenial,
          googleTagRequests,
        },
      )})`,
    );
  } else {
    console.log("ok    / analytics consent synchronizes across open docs tabs");
  }
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
  const context = await browser.newContext({ viewport: BASE_VIEWPORT });
  const page = await context.newPage();
  const badRequests = [];
  page.on("requestfailed", (r) =>
    badRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) badRequests.push(`${r.url()} HTTP ${r.status()}`);
  });

  await assertDocsAnalyticsConsent(
    page,
    `http://127.0.0.1:${port}`,
    fail,
  );

  for (const spec of PAGES) {
    badRequests.length = 0;
    await page.goto(`http://127.0.0.1:${port}${spec.path}`, {
      waitUntil: "networkidle",
    });

    if (SOCIAL_METADATA_ROUTES.has(spec.path)) {
      await assertSocialMetadata(page, spec.path);
    }
    if (spec.path === "/") {
      await assertHomepageSearchIdentity(page);
    }

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

  const heroActions = await page
    .locator(".VPHome .VPHero .actions .VPButton")
    .evaluateAll((actions) =>
      actions
        .filter((action) => action.getClientRects().length > 0)
        .map((action) => ({
          text: action.textContent?.trim(),
          href: action.href,
        })),
    );
  const expectedHeroActions = [
    { text: "Try the Live Demo", href: "https://demo.jobctrl.dev/" },
    {
      text: "Install on Apple silicon",
      href: `http://127.0.0.1:${port}/user/getting-started`,
    },
    {
      text: "See How It Works",
      href: `http://127.0.0.1:${port}/user/product-tour`,
    },
    { text: "View on GitHub", href: "https://github.com/ebarti/JobCtrl" },
  ];
  if (JSON.stringify(heroActions) !== JSON.stringify(expectedHeroActions)) {
    fail(
      `/: launch actions do not match the demo/install/tour/source contract (${JSON.stringify(heroActions)})`,
    );
  } else {
    console.log("ok    / launch hero actions");
  }

  await page.goto(`http://127.0.0.1:${port}/user/product-tour`, {
    waitUntil: "networkidle",
  });
  const tourSidebar = await page.locator(".VPSidebar").innerText();
  const missingDesktopSidebarLabels = REQUIRED_SIDEBAR_LABELS.filter(
    (label) => !tourSidebar.includes(label),
  );
  if (missingDesktopSidebarLabels.length > 0) {
    fail(
      `/user/product-tour: unified sidebar is missing ${missingDesktopSidebarLabels.join(", ")}`,
    );
  }
  const tourOutline = await page.locator(".VPDocAsideOutline").innerText();
  const tourText = await page.locator(".vp-doc").innerText();
  const internalTourCopy = [
    "Intended Screenshot Asset Matrix",
    "Mobile Reflow",
    "Generating these screenshots",
  ];
  if (
    !/On this page/.test(tourOutline) ||
    !/Set Up Your Profile|Apply Review|Runs History/.test(tourOutline) ||
    internalTourCopy.some(
      (copy) => tourOutline.includes(copy) || tourText.includes(copy),
    )
  ) {
    fail(
      "/user/product-tour: public tour outline is missing product content or exposes internal capture guidance",
    );
  } else {
    console.log("ok    /user/product-tour section outline");
  }
  const footerText = await page.locator(".VPFooter").innerText();
  const obsoleteFooterMessage =
    "Documentation screenshots and examples use synthetic data unless noted.";
  if (
    !footerText.includes("Copyright © 2026 Eloi Barti") ||
    !footerText.includes("AGPL-3.0-only") ||
    !footerText.includes("Source code") ||
    !footerText.includes("Cookie settings") ||
    footerText.includes(obsoleteFooterMessage)
  ) {
    fail(
      "/user/product-tour: copyright/license footer is missing or incomplete",
    );
  } else {
    console.log("ok    /user/product-tour footer notice");
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
      `/user/product-tour desktop: media escaped its content track (${JSON.stringify(desktopTour)})`,
    );
  } else {
    console.log("ok    /user/product-tour desktop media track");
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
      "/user/product-tour: responsive media lost its zoom or alternative-text semantics",
    );
  } else {
    console.log("ok    /user/product-tour image zoom semantics");
  }
  await page.locator('.jh-lightbox button[aria-label="Close"]').click();

  await page.setViewportSize(REPORTED_TOUR_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/product-tour`, {
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
      `/user/product-tour 1285px: media/outline layout regressed (${JSON.stringify(reportedTour)})`,
    );
  } else {
    console.log("ok    /user/product-tour 1285px media/outline layout");
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
      `/user/product-tour sidebar resize: pointer, keyboard, or layout contract regressed (${JSON.stringify(
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
    console.log("ok    /user/product-tour direct-manipulation sidebar resize");
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
  await page.goto(`http://127.0.0.1:${port}/user/product-tour`, {
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
      `/user/product-tour sidebar collapse: focus, persistence, or width release regressed (${JSON.stringify(
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
      "ok    /user/product-tour keyboard sidebar collapse and restore",
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
  await page.goto(`http://127.0.0.1:${port}/user/product-tour`, {
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
      `/user/product-tour 1024px: responsive media layout regressed (${JSON.stringify(narrowDesktopTour)})`,
    );
  } else {
    console.log("ok    /user/product-tour 1024px media layout");
  }

  // A 1440px display at 200% page zoom exposes roughly a 720px-wide CSS
  // viewport. The desktop controls should yield to VitePress's reachable
  // mobile navigation instead of clipping either control set.
  await page.setViewportSize(ZOOMED_DESKTOP_CSS_VIEWPORT);
  await page.goto(`http://127.0.0.1:${port}/user/product-tour`, {
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
      `/user/product-tour 200% zoom: navigation became unreachable (${JSON.stringify(zoomedDesktopState)})`,
    );
  } else {
    console.log("ok    /user/product-tour 200% zoom navigation fallback");
  }

  await page.setViewportSize(BASE_VIEWPORT);

  await page.goto(
    `http://127.0.0.1:${port}/user/scoring-and-employer-analysis`,
    { waitUntil: "networkidle" },
  );
  const scoringExplanationContract = await page.evaluate(() => {
    const doc = document.querySelector(".vp-doc");
    const text = (doc?.textContent ?? "").replace(/\s+/g, " ").trim();
    const strongLabels = [...(doc?.querySelectorAll("strong") ?? [])].map(
      (label) => (label.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    const requiredLabels = [
      "Send the accepted requirements to the scorer.",
      "Classify the returned evidence.",
      "Apply evidence credit and requirement priority.",
      "Assign the display band.",
      "Confidence is a review signal, not a points adjustment.",
      "Eligibility is recorded separately from soft fit.",
      "The minimum-fit threshold does not change the saved score.",
      "A correction is not a hidden weight change.",
    ];
    const requiredTokens = [
      "requirement-fit-v1",
      "Direct match",
      "Strong match",
      "Transferable evidence",
      "1.25×",
      "score = 1 + round(9 × coverage)",
      "45% technical fit",
      "30% experience fit",
      "25% role fit",
      "evidence ID",
      "capped at 4",
      "Unavailable evidence",
      "0–10",
    ];
    return {
      missingHeadings: [
        "#how-the-score-is-calculated",
        "#when-requirement-rows-are-unavailable",
        "#score-confidence-and-eligibility-are-different",
      ].filter((selector) => !document.querySelector(selector)),
      missingLabels: requiredLabels.filter(
        (label) => !strongLabels.includes(label),
      ),
      missingTokens: requiredTokens.filter((token) => !text.includes(token)),
    };
  });
  if (
    scoringExplanationContract.missingHeadings.length > 0 ||
    scoringExplanationContract.missingLabels.length > 0 ||
    scoringExplanationContract.missingTokens.length > 0
  ) {
    fail(
      `/user/scoring-and-employer-analysis: public scoring explanation regressed (${JSON.stringify(scoringExplanationContract)})`,
    );
  } else {
    console.log(
      "ok    /user/scoring-and-employer-analysis scoring explanation",
    );
  }

  for (const contract of LIFECYCLE_EXPLANATION_CONTRACTS) {
    await page.goto(`http://127.0.0.1:${port}${contract.path}`, {
      waitUntil: "networkidle",
    });
    const lifecycleExplanation = await page.evaluate(
      ({ heading, labels = [], tokens = [], selectors = [] }) => {
        const doc = document.querySelector(".vp-doc");
        const text = (doc?.textContent ?? "").replace(/\s+/g, " ").trim();
        const strongLabels = [...(doc?.querySelectorAll("strong") ?? [])].map(
          (label) => (label.textContent ?? "").replace(/\s+/g, " ").trim(),
        );
        return {
          hasExplanationHeading: Boolean(document.querySelector(heading)),
          missingLabels: labels.filter(
            (label) => !strongLabels.includes(label),
          ),
          missingTokens: tokens.filter((token) => !text.includes(token)),
          missingSelectors: selectors.filter(
            (selector) => !document.querySelector(selector),
          ),
        };
      },
      contract,
    );
    if (
      !lifecycleExplanation.hasExplanationHeading ||
      lifecycleExplanation.missingLabels.length > 0 ||
      lifecycleExplanation.missingTokens.length > 0 ||
      lifecycleExplanation.missingSelectors.length > 0
    ) {
      fail(
        `${contract.path}: public lifecycle explanation regressed (${JSON.stringify(lifecycleExplanation)})`,
      );
    } else {
      console.log(`ok    ${contract.path} lifecycle explanation`);
    }
  }

  await page.goto(
    `http://127.0.0.1:${port}/user/normal-flows#workers-activity-slots-and-queue-backlog`,
    { waitUntil: "networkidle" },
  );
  const capacityExplanationContract = await page.evaluate(() => {
    const doc = document.querySelector(".vp-doc");
    const text = (doc?.textContent ?? "").replace(/\s+/g, " ").trim();
    const strongLabels = [...(doc?.querySelectorAll("strong") ?? [])].map(
      (label) => (label.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    const requiredLabels = [
      "Worker processes online",
      "Activity slots in use",
      "Active work",
      "Queue backlog",
    ];
    const requiredTokens = [
      "0 of 4",
      "fresh worker processes",
      "configured slots minus active slots",
      "unknown, not zero",
      "infrastructure pressure",
    ];
    return {
      hasHeading: Boolean(
        document.querySelector("#workers-activity-slots-and-queue-backlog"),
      ),
      missingLabels: requiredLabels.filter(
        (label) => !strongLabels.includes(label),
      ),
      missingTokens: requiredTokens.filter((token) => !text.includes(token)),
    };
  });
  if (
    !capacityExplanationContract.hasHeading ||
    capacityExplanationContract.missingLabels.length > 0 ||
    capacityExplanationContract.missingTokens.length > 0
  ) {
    fail(
      `/user/normal-flows: worker capacity explanation regressed (${JSON.stringify(capacityExplanationContract)})`,
    );
  } else {
    console.log("ok    /user/normal-flows worker capacity explanation");
  }

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
      hasDocsAnalyticsDisclosure:
        Boolean(document.querySelector("#documentation-site-analytics")) &&
        text.includes("G-KB495KG6MS") &&
        text.includes("Before acceptance") &&
        text.includes("does not load or contact Google Analytics") &&
        text.includes("jobctrl-docs-analytics-consent-v1") &&
        text.includes("Cookie settings") &&
        text.includes("without URL query strings or fragments") &&
        text.includes("within six months") &&
        text.includes("separate from JobCtrl's local product telemetry"),
    };
  });
  const requiredQuickAnswers = [
    "Do I need a hosted backend or a JobCtrl account?",
    "Are the database and generated files stored locally?",
    "Does JobCtrl call AI models or other providers automatically?",
    "Does Discovery make network requests?",
    "Is product telemetry enabled by default?",
    "Does this documentation site use analytics?",
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
    !privacyContract.hasDefaultProtection ||
    !privacyContract.hasDocsAnalyticsDisclosure
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
    const cardElements = [...document.querySelectorAll(".jh-compare-card")];
    const cards = cardElements.map((card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    });
    const headings = [...document.querySelectorAll(".vp-doc h2")].map(
      (heading) => (heading.textContent ?? "").replaceAll("\u200B", "").trim(),
    );
    const verdicts = cardElements.map((card) =>
      (card.querySelector(".jh-compare-card__verdict")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    return {
      cards,
      headings,
      verdicts,
      hasDeprecatedFitCopy: cardElements.some((card) =>
        /Best fit:|Trade-off:/.test(card.textContent ?? ""),
      ),
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      summaryRegionLabel: document
        .querySelector(".jh-compare-table-wrap")
        ?.getAttribute("aria-label"),
      summaryRegionTabIndex: document
        .querySelector(".jh-compare-table-wrap")
        ?.getAttribute("tabindex"),
    };
  });
  const cardsFormTwoRows =
    comparisonDesktop.cards.length === 4 &&
    Math.abs(
      comparisonDesktop.cards[0].y - comparisonDesktop.cards[1].y,
    ) < 2 &&
    Math.abs(
      comparisonDesktop.cards[2].y - comparisonDesktop.cards[3].y,
    ) < 2 &&
    comparisonDesktop.cards[2].y > comparisonDesktop.cards[0].y &&
    comparisonDesktop.cards.every(
      (card) => Math.abs(card.width - comparisonDesktop.cards[0].width) < 2,
    );
  if (
    !cardsFormTwoRows ||
    comparisonDesktop.pageOverflows ||
    comparisonDesktop.summaryRegionLabel !== "At-a-glance comparison table" ||
    comparisonDesktop.summaryRegionTabIndex !== "0" ||
    comparisonDesktop.verdicts.length !== 4 ||
    !comparisonDesktop.verdicts[0]?.startsWith("Why JobCtrl leads:") ||
    comparisonDesktop.verdicts
      .slice(1)
      .some((verdict) => !verdict.startsWith("Gap versus JobCtrl:")) ||
    comparisonDesktop.hasDeprecatedFitCopy ||
    !comparisonDesktop.headings.includes(
      "JobCtrl's UI is part of the product",
    ) ||
    comparisonDesktop.headings.at(-2) !==
      "Appendix: evidence-backed capability matrix" ||
    comparisonDesktop.headings.at(-1) !== "Snapshot and delta method"
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
  await page.goto(`http://127.0.0.1:${port}/user/product-tour`, {
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
      `/user/product-tour mobile: screenshot did not remain inspectable (${mobileTourImage?.width ?? 0}px)`,
    );
  } else if (customDesktopControlsVisible) {
    fail(
      "/user/product-tour mobile: desktop sidebar controls displaced the stock mobile drawer",
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
      `/user/product-tour mobile: unified menu is missing ${missingMobileSidebarLabels.join(", ")}`,
    );
  } else {
    console.log("ok    /user/product-tour mobile menu");
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
  await page.waitForFunction(
    () => {
      const image = document.querySelector(
        "[data-jh-comparison-carousel] img",
      );
      if (!(image instanceof HTMLImageElement)) return false;
      const box = image.getBoundingClientRect();
      return image.complete && image.naturalWidth > 100 && box.width > 220;
    },
    { timeout: 5000 },
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
    comparisonMobile.cards.length === 4 &&
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
