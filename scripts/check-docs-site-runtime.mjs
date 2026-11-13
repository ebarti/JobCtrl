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
    visualSelector: null,
    images: false,
  },
  {
    path: "/guides/temporal-workflows-desktop-app",
    visualSelector: null,
    images: false,
  },
  { path: "/architecture/", visualSelector: ".vp-doc table", images: false },
  { path: "/architecture/runtime", visualSelector: ".vp-doc table", images: false },
  { path: "/developer/", visualSelector: null, images: false },
  {
    path: "/architecture/scoring",
    visualSelector: null,
    images: false,
  },
  {
    path: "/architecture/pipeline/operations",
    visualSelector: null,
    images: false,
  },
  {
    path: "/user/normal-flows",
    visualSelector: ".jh-daily-journey",
    images: true,
  },
  { path: "/user/getting-started", visualSelector: null, images: false },
  { path: "/user/configuration", visualSelector: null, images: false },
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
  { path: "/user/requirements-library", visualSelector: null, images: false },
  { path: "/user/apply", visualSelector: null, images: false },
  {
    path: "/user/candidate-profile",
    visualSelector: ".candidate-profile-flow",
    images: false,
  },
  {
    path: "/user/enrichment-and-extraction",
    visualSelector: null,
    images: false,
  },
  {
    path: "/user/materials-and-tailoring",
    visualSelector: null,
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

// Assert the current Python feature documentation explicitly. Retired diagrams
// and TypeScript-era wording are not evidence of a rendering failure.
const EXPLANATION_CONTRACTS = [
  {
    path: "/guides/at-most-once-job-application-submission",
    heading: "#approval-is-bound-at-the-mutation-boundary",
    selectors: [
      "#at-most-once-is-not-exactly-once",
      "#local-stops-do-not-resolve-external-uncertainty",
      "#browser-and-email-have-different-submission-boundaries",
    ],
    tokens: [
      "needs_verification",
      "one unique intent",
      "pinned bytes",
      "final form submission is manual",
      "sender does not retry an existing intent",
    ],
  },
  {
    path: "/architecture/",
    heading: "#architecture",
    selectors: [".vp-doc table"],
    tokens: [
      "workers/automation/src/jobctrl/app/",
      "workers/automation/src/jobctrl/features/<owner>/",
      "Temporal runs the same Python application actions",
      "no sibling-private-table reads or alternate business writers",
      "Missing wording cannot lower factual qualification",
    ],
  },
  {
    path: "/architecture/runtime",
    heading: "#admission-and-readiness",
    selectors: ["#processes-and-entrypoints", "#model-execution-and-shutdown"],
    tokens: [
      "Every request checks the actual peer and Host",
      "Tokens and credentials never enter ordinary settings, event payloads or application logs",
      "lane capacity and spend checks",
      "Credentials are loaded only at the provider boundary and remain outside prompts",
      "Model failures preserve the feature's accepted artifact",
    ],
  },
  {
    path: "/architecture/scoring",
    heading: "#inputs-and-semantic-authority",
    selectors: [
      "#typed-requirements-and-permitted-evidence",
      "#deterministic-score-resolution",
      "#profile-edits-and-explicit-refresh",
      "#generation-history-and-rollout",
    ],
    tokens: [
      "All rows pass schema, evidence and immutable gateway-receipt validation",
      "Invalid, stale, refused or cancelled work preserves accepted assessments and scores",
      "document gap and does not reduce factual fit",
      "requirements-v2",
      "requirement-fit-v3-equal",
      "one item",
      "For N = 0, no score is calculated",
      "no source importance weights, must-have multipliers, blocker caps or invented source priorities",
      "selected jobs' direct Education and Languages demands",
      "Incompatible operation",
      "stop old writers and back up the workspace",
      "Rollback after such writes restores that backup",
    ],
  },
  {
    path: "/user/data-and-safety",
    heading: "#typed-requirements-upgrade",
    selectors: ["#back-up-and-restore"],
    tokens: [
      "stop every old application and worker writer",
      "consistent workspace backup",
      "workflow history and referenced accepted artifacts",
      "active Skills/Professional Experience catalog",
      "Incompatible old operations are refused",
      "rollback restores the verified pre-upgrade backup",
      "Installing an older binary alone is unsafe",
      "has not rolled out to a live workspace",
    ],
  },
  {
    path: "/architecture/pipeline/operations",
    heading: "#automatic-preparation-recovery",
    selectors: [
      "#discovery-schedule",
      "#domain-events-projections-and-sse",
      "#spend-ceiling",
    ],
    tokens: [
      "Recurring discovery is off by default",
      "preserve committed progress, respect the user's stop",
      "Feature mutations and bounded invalidations commit together",
      "lane/spend preflight before external calls",
      "none permits lexical fallback or destruction of an accepted artifact",
    ],
  },
  {
    path: "/user/configuration",
    heading: "#configuration-sources",
    tokens: [
      "macOS Keychain",
      "Windows Credential Manager",
      "Linux Secret Service",
      "resolves native-store credentials for each new provider execution",
      "A nonempty value in the launch environment takes precedence",
      "An in-flight request retains its existing credentials",
      "Stored secret values are never rendered",
      "inspection_failed",
      "does not save submitted secrets to a plaintext fallback",
      "all-or-nothing",
      "failed change preserves the previous configuration",
    ],
  },
  {
    path: "/user/discovery",
    heading: "#runtime-sources-and-schedule",
    selectors: [
      "#runtime-setting-job-boards",
      "#runtime-setting-parallel-source-families",
      "#runtime-setting-schedule-cron",
    ],
    tokens: [
      "SQLite", "expectedRevision", "expectedPolicyRevision", "expectedProfileVersion",
      "Check previous search", "Stop requested",
    ],
  },
  {
    path: "/user/apply",
    heading: "#approval-and-automation-modes",
    selectors: [
      "#candidate-profile-application-fields",
      "#approval-and-automation-modes",
      "#browser-apply-automation",
      "#final-browser-submission-is-manual",
      "#skip-and-safe-reset",
    ],
    tokens: [
      "partial coverage",
      "read-only",
      "exact recipient, subject, body and accepted resume bytes",
      "commits a unique intent",
      "blocks automatic resending",
      "CAPTCHA",
    ],
  },
  {
    path: "/user/candidate-profile",
    heading: "#how-profile-data-becomes-runtime-evidence",
    labels: [
      "Import creates a draft.",
      "Save validates and retains the authored data.",
      "Work receives an immutable snapshot.",
      "Fact and wording revisions remain separate.",
      "Refresh preserves accepted work.",
    ],
    tokens: ["ProfileSnapshot", "profile version", "Apply approval"],
  },
  {
    path: "/user/enrichment-and-extraction",
    heading: "#how-a-lead-becomes-a-usable-snapshot",
    labels: [
      "Fetch once, then walk the configured extraction cascade.",
      "Verify active state independently.",
      "Determine content quality from the captured sources.",
      "Quarantine low-confidence content.",
      "Resolve duplicate identity.",
    ],
    tokens: ["JSON-LD", "verbatim", "determination", "last accepted snapshot", "signals remain unknown", "operator override", "Availability-only uncertainty does not create a content-review entry"],
  },
  {
    path: "/user/materials-and-tailoring",
    heading: "#how-jobctrl-chooses-a-resume",
    selectors: [".vp-doc .custom-block.info"],
    tokens: [
      "retain every approved role and achievement",
      "select one approved wording per achievement",
      "Person fit remains separate from document coverage",
      "advisory coherence review",
      "Baseline-copy mode makes no resume model calls",
      "failed refresh preserves the last accepted resume",
      "integration verification are in progress",
    ],
  },
  {
    path: "/user/outcomes-and-feedback",
    heading: "#how-email-becomes-an-outcome-suggestion",
    selectors: ["#retrying-a-manual-record", "#source-of-truth-and-ownership"],
    tokens: [
      "20 anchors",
      "10 results per anchor",
      "45-day",
      "before the body is read",
      "result is a suggestion, not a reviewed outcome",
      "ignoring records the decision without inventing one",
      "preserves earlier committed suggestions and reviewed records",
      "scoped local reads",
      "sample-gated",
      "does not erase the original submit intent",
    ],
  },
  {
    path: "/user/contacts-and-outreach",
    heading: "#how-research-and-draft-approval-work",
    labels: ["Check source policy before research.", "Keep findings as proposals.", "Verify the actual draft.", "Run independent quality review.", "Persist the gate result as authority.", "Stop at the clipboard."],
    tokens: ["broad-web discovery", "needs_review", "persisted approved draft", "confirmed profile and contact facts", "recorded line IDs", "Both model verdicts must pass", "Stop at the clipboard"],
  },
  {
    path: "/user/compensation-evidence",
    heading: "#how-compensation-is-calculated",
    labels: ["Employer-posted compensation", "Direct and extrapolated market benchmarks", "Reads are passive:"],
    tokens: ["source-bound", "taxonomy", "exact", "code equality", "Classification sources", "last accepted estimate", "2,080", "seven-day", "ECB", "0.1x", "10x", "factor_out_of_bounds", "Euro Top Tech", "Glassdoor", "Levels.fyi", "Reads are passive", "opening a compensation panel neither fetches a provider nor refreshes an estimate"],
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
  "docs/assets/screenshots/original-jobs.png",
);
const publicHeroScreenshot = path.join(
  root,
  "docs/public/assets/screenshots/original-jobs.png",
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

function contrastRatio(first, second) {
  const luminance = (channels) => channels.slice(0, 3).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const left = luminance(first); const right = luminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
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
    "/ hero image: public hero screenshot is stale relative to docs/assets/screenshots/original-jobs.png",
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
  const heroSource = await page.locator(".VPHome .VPHero img.image-src").getAttribute("src");
  if (
    !heroImage ||
    heroSource !== "/assets/screenshots/original-jobs.png" ||
    heroImage.width < 420 ||
    heroImage.y > BASE_VIEWPORT.height
  ) {
    fail(
      "/: current source hero image is missing, stale, too small, or below the first viewport",
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
    !["Jobs: Compare And Act", "My Profile: Reusable Facts And Wording", "Settings: Shared Choices"]
      .every((label) => tourOutline.includes(label)) ||
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
      "Skills",
      "Professional Experience",
      "Education",
      "Languages",
      "requirement-fit-v3-equal",
      "Confidence is a review signal, not a points adjustment.",
      "Eligibility is recorded separately from fit.",
      "The minimum-fit threshold does not change the saved score.",
      "A correction retains its own authority.",
    ];
    const requiredTokens = [
      "requirements-v2",
      "requirement-fit-v3-equal",
      "Direct match",
      "Strong match",
      "Transferable evidence",
      "demand counts as one item",
      "meaning do not increase its points",
      "alternatives group counts as one demand",
      "score = clamp(1 + floor(9 × qualification coverage + 0.5), 1, 10)",
      "For N = 0, there is no calculated score",
      "no posting importance weights, must-have multipliers, blocker caps or invented source priorities",
      "professional experience only if the posting explicitly offers that alternative",
      "Language / Proficiency records only",
      "without claiming a degree",
      "source categories, identities, revisions and citations",
      "Personal traits, certifications and licenses, job conditions and detailed years-of-experience analysis are excluded",
      "skipped rather than translated or assigned zero fit",
      "Update affected matches",
      "Saving a Profile starts neither action",
      "contract-change refresh status",
      "prior accepted score",
      "no word-overlap or opaque dimension-score fallback",
    ];
    // The typed Fit owner uses equal-item arithmetic and refuses incomplete
    // assessments. Retired weighted or opaque scoring must not return as guidance.
    const retiredFallbackTokens = [
      "45% technical fit", "30% experience fit", "25% role fit",
      "requirement-fit-v2-scoped", "1.25×", "capped at 4",
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
      retiredFallbackTokens: retiredFallbackTokens.filter((token) => text.includes(token)),
    };
  });
  if (
    scoringExplanationContract.missingHeadings.length > 0 ||
    scoringExplanationContract.missingLabels.length > 0 ||
    scoringExplanationContract.missingTokens.length > 0 ||
    scoringExplanationContract.retiredFallbackTokens.length > 0
  ) {
    fail(
      `/user/scoring-and-employer-analysis: public scoring explanation regressed (${JSON.stringify(scoringExplanationContract)})`,
    );
  } else {
    console.log(
      "ok    /user/scoring-and-employer-analysis scoring explanation",
    );
  }

  for (const contract of EXPLANATION_CONTRACTS) {
    await page.goto(`http://127.0.0.1:${port}${contract.path}`, {
      waitUntil: "networkidle",
    });
    const explanation = await page.evaluate(
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
      !explanation.hasExplanationHeading ||
      explanation.missingLabels.length > 0 ||
      explanation.missingTokens.length > 0 ||
      explanation.missingSelectors.length > 0
    ) {
      fail(
        `${contract.path}: public explanation regressed (${JSON.stringify(explanation)})`,
      );
    } else {
      console.log(`ok    ${contract.path} explanation`);
    }
  }

  await page.goto(
    `http://127.0.0.1:${port}/user/normal-flows#settings-and-task-recovery`,
    { waitUntil: "networkidle" },
  );
  const connectedWorkflowContract = await page.evaluate(() => {
    const doc = document.querySelector(".vp-doc");
    const text = (doc?.textContent ?? "").replace(/\s+/g, " ").trim();
    const strongLabels = [...(doc?.querySelectorAll("strong") ?? [])].map(
      (label) => (label.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    const requiredLabels = [
      "Jobs",
      "My profile",
      "Settings",
      "Start search",
      "Search preferences",
      "Prepare resume",
      "Needs verification",
      "Settings → Data & diagnostics",
    ];
    const requiredTokens = [
      "Saving preferences does not start discovery.",
      "Final submission on an employer website is manual.",
      "Appearance saves in this browser",
      "does not change resume-template typography.",
    ];
    const requiredLinks = ["requirements-library", "candidate-profile", "configuration", "apply"];
    const links = [...(doc?.querySelectorAll("a[href]") ?? [])].map(
      (link) => link.getAttribute("href") ?? "",
    );
    return {
      hasHeading: Boolean(document.querySelector("#settings-and-task-recovery")),
      missingLabels: requiredLabels.filter((label) => !strongLabels.includes(label)),
      missingTokens: requiredTokens.filter((token) => !text.includes(token)),
      missingLinks: requiredLinks.filter((target) => !links.some((href) => href.includes(target))),
    };
  });
  if (
    !connectedWorkflowContract.hasHeading ||
    connectedWorkflowContract.missingLabels.length > 0 ||
    connectedWorkflowContract.missingTokens.length > 0 ||
    connectedWorkflowContract.missingLinks.length > 0
  ) {
    fail(
      `/user/normal-flows: connected workflow or recovery explanation regressed (${JSON.stringify(connectedWorkflowContract)})`,
    );
  } else {
    console.log("ok    /user/normal-flows connected workflow and task recovery");
  }

  await page.goto(`http://127.0.0.1:${port}/user/data-and-safety`, {
    waitUntil: "networkidle",
  });
  const privacyContract = await page.evaluate(() => {
    const heading = document.querySelector("#privacy-quick-answer");
    const table = heading?.nextElementSibling;
    const text = (document.querySelector(".vp-doc")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      headerCount: table?.querySelectorAll("thead th").length ?? 0,
      rowCount: table?.querySelectorAll("tbody tr").length ?? 0,
      tableText: table?.textContent ?? "",
      hasWorkspaceScope: text.includes(
        "every path below is relative to JOBCTRL_DIR",
      ),
      hasMacOnlyBoundary: text.includes("macOS credential panel"),
      hasRuntimeBoundary:
        text.includes("Python loads native credentials at startup") &&
        text.includes("corresponding environment value is missing or empty"),
      hasPrecedenceBoundary: text.includes(
        "Any non-empty inherited value wins",
      ),
      hasRestartBoundary: text.includes("Restart JobCtrl"),
      hasWindowsBoundary: text.includes("Windows Credential Manager"),
      hasLinuxBoundary: text.includes("Linux Secret Service"),
      hasInspectionFailureBoundary:
        text.includes("inspection_failed") &&
        text.includes("not that a credential is absent"),
      hasRetryBoundary: text.includes(
        "Unlock or restore access to the native store and retry",
      ),
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
    "Does Discovery use my browser profile?",
    "Does application-submission browser automation run continuously?",
    "Does JobCtrl submit applications or send employer-facing email by default?",
    "Does Outreach send messages automatically?",
  ];
  const requiredQuickAnswerStatuses = ["✓ Yes", "✕ No", "◐ Only"];
  const requiredBrowserBoundaries = [
    "Discovery and Enrich prefer its live profile",
    "Without it, they use guarded public HTTP or anonymous managed Playwright",
    "They never copy or separately launch your profile",
    "a fetch failure does not change transport",
  ];
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
    requiredBrowserBoundaries.some(
      (boundary) => !privacyContract.tableText.includes(boundary),
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
        "Expand image: Selected job Resume tab with the actual Plate editor",
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
        "Original Jobs table with recorded pay, fit and application state" ||
      initialCarousel.caption !==
        "Jobs — compare recorded pay, fit and application state" ||
      initialCarousel.status !== "1 of 2" ||
      !initialPreviousDisabled ||
      initialNextDisabled ||
      nextCarousel.imageCount !== 1 ||
      nextCarousel.visibleImageCount !== 1 ||
      nextCarousel.imageAlt !==
        "Selected job Resume tab with the actual Plate editor" ||
      nextCarousel.caption !==
        "Resume — prepare and edit the actual document beside its job" ||
      nextCarousel.status !== "2 of 2" ||
      nextPreviousDisabled ||
      !nextNextDisabled ||
      applyReviewZoomLabel !==
        "Expand image: Selected job Resume tab with the actual Plate editor" ||
      expandedApplyReviewAlt !==
        "Selected job Resume tab with the actual Plate editor" ||
      restoredCarousel.imageCount !== 1 ||
      restoredCarousel.visibleImageCount !== 1 ||
      restoredCarousel.imageAlt !==
        "Original Jobs table with recorded pay, fit and application state" ||
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
  // Shared product tokens use a different dark-mode selector than VitePress.
  // Exercise real first paint, controls, diagrams and search in every mode so
  // a broken build-time adapter cannot silently ship a light-only docs theme.
  const themeBase = `http://127.0.0.1:${port}`;
  for (const colorScheme of ["light", "dark"]) {
    for (const viewport of [BASE_VIEWPORT, { width: 390, height: 844 }]) {
      const themedContext = await browser.newContext({ colorScheme, viewport });
      const themedPage = await themedContext.newPage();
      try {
        for (const route of ["/", "/user/normal-flows", "/guides/at-most-once-job-application-submission"]) {
          await themedPage.goto(`${themeBase}${route}`, { waitUntil: "networkidle" });
          await themedPage.locator("h1").first().waitFor({ state: "visible" });
          const style = await themedPage.evaluate(async () => {
            await document.fonts.ready;
            const action = document.querySelector(".VPButton.brand");
            const body = getComputedStyle(document.body);
            const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
            const context = canvas.getContext("2d");
            const channels = (color) => {
              context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
              return Array.from(context.getImageData(0, 0, 1, 1).data);
            };
            const faces = [...document.fonts].filter((face) => face.family.replaceAll('"', "") === "Geist Variable");
            const actionStyle = action ? getComputedStyle(action) : null;
            return {
              dark: document.documentElement.classList.contains("dark"),
              background: body.backgroundColor,
              font: body.fontFamily,
              fontLoaded: faces.some((face) => face.status === "loaded")
                && document.fonts.check('400 14px "Geist Variable"', "JobCtrl")
                && performance.getEntriesByType("resource").some((resource) => /geist[^/]*\.woff2(?:$|\?)/.test(resource.name)),
              radius: actionStyle?.borderRadius ?? null,
              textContrast: channels(body.color), backgroundChannels: channels(body.backgroundColor),
              actionInk: actionStyle ? channels(actionStyle.color) : null,
              actionBackground: actionStyle ? channels(actionStyle.backgroundColor) : null,
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
            };
          });
          const expectedBackground = colorScheme === "dark" ? "rgb(18, 22, 28)" : "rgb(247, 248, 250)";
          const textContrast = contrastRatio(style.textContrast, style.backgroundChannels);
          const actionContrast = style.actionInk ? contrastRatio(style.actionInk, style.actionBackground) : null;
          if (style.dark !== (colorScheme === "dark") || style.background !== expectedBackground ||
              !style.font.startsWith('"Geist Variable"') || !style.fontLoaded ||
              (style.radius !== null && style.radius !== "7px") || textContrast < 4.5 ||
              (actionContrast !== null && actionContrast < 4.5) || style.overflow) {
            fail(`${route} ${colorScheme} ${viewport.width}px: shared theme/reflow mismatch (${JSON.stringify({ ...style, textContrast, actionContrast })})`);
          } else {
            console.log(`ok    ${route} ${colorScheme} ${viewport.width}px shared theme, loaded Geist, contrast and reflow`);
          }
        }
        await themedPage.getByRole("button", { name: "Search", exact: true }).click();
        await themedPage.locator("input.search-input").fill("privacy");
        const searchFrame = await themedPage.locator(".VPLocalSearchBox .search-bar").evaluate((element) => {
          const style = getComputedStyle(element);
          const probe = document.createElement("span"); element.append(probe);
          const tokenColor = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
          const expectedBorder = tokenColor("--input"); const expectedOutline = tokenColor("--ring"); probe.remove();
          const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
          const context = canvas.getContext("2d");
          const channels = (color) => {
            context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data);
          };
          return {
            border: style.borderTopColor, expectedBorder,
            outlineColor: style.outlineColor, expectedOutline,
            borderChannels: channels(style.borderTopColor), outlineChannels: channels(style.outlineColor),
            backgroundChannels: channels(getComputedStyle(document.body).backgroundColor),
            outline: style.outlineStyle, outlineWidth: style.outlineWidth,
          };
        });
        const borderContrast = contrastRatio(searchFrame.borderChannels, searchFrame.backgroundChannels);
        const outlineContrast = contrastRatio(searchFrame.outlineChannels, searchFrame.backgroundChannels);
        if (searchFrame.border !== searchFrame.expectedBorder || searchFrame.outlineColor !== searchFrame.expectedOutline ||
            searchFrame.outline !== "solid" || searchFrame.outlineWidth !== "2px" || borderContrast < 3 || outlineContrast < 3) {
          fail(`/ search ${colorScheme} ${viewport.width}px: input outline or focus ring mismatch (${JSON.stringify({ ...searchFrame, borderContrast, outlineContrast })})`);
        } else {
          console.log(`ok    / search ${colorScheme} ${viewport.width}px input border, focus ring and contrast`);
        }
        await themedPage.locator(".VPLocalSearchBox .result").first().waitFor({ state: "visible" });
        const firstResult = themedPage.locator(".VPLocalSearchBox .result").first();
        const resultHref = await firstResult.getAttribute("href");
        await firstResult.click();
        await themedPage.waitForURL((url) => url.pathname === new URL(resultHref, themeBase).pathname);
        await themedPage.locator(".VPLocalSearchBox").waitFor({ state: "hidden" });
        console.log(`ok    / search result navigation ${colorScheme} ${viewport.width}px`);
      } finally {
        await themedContext.close();
      }
    }
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
