import { posix } from "node:path";
import { defineConfig, type DefaultTheme, type HeadConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const REPO_URL = "https://github.com/ebarti/JobCtrl";
const DOCS_SITE_URL = "https://jobctrl.dev";
const SITE_NAME = "JobCtrl";
const SITE_DESCRIPTION =
  "Run your job search without surrendering your data: local discovery, evidence-backed scoring, truthful tailoring, and supervised apply.";
const SOCIAL_IMAGE_URL = `${DOCS_SITE_URL}/assets/brand/social-preview.png`;
const SOCIAL_IMAGE_ALT =
  "JobCtrl: run your job search, keep your data, and inspect key AI-assisted decisions.";
const ORGANIZATION_ID = `${DOCS_SITE_URL}/#organization`;
const WEBSITE_ID = `${DOCS_SITE_URL}/#website`;
const SOFTWARE_ID = `${DOCS_SITE_URL}/#software`;
const HOME_STRUCTURED_DATA = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": ORGANIZATION_ID,
      name: SITE_NAME,
      url: `${DOCS_SITE_URL}/`,
      logo: `${DOCS_SITE_URL}/assets/brand/app-icon.png`,
      sameAs: [REPO_URL],
    },
    {
      "@type": "WebSite",
      "@id": WEBSITE_ID,
      url: `${DOCS_SITE_URL}/`,
      name: SITE_NAME,
      alternateName: "jobctrl.dev",
      description: SITE_DESCRIPTION,
      inLanguage: "en",
      publisher: { "@id": ORGANIZATION_ID },
    },
    {
      "@type": "SoftwareApplication",
      "@id": SOFTWARE_ID,
      name: SITE_NAME,
      url: `${DOCS_SITE_URL}/`,
      description: SITE_DESCRIPTION,
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "Job search automation",
      operatingSystem: "macOS 15 or later on Apple silicon",
      isAccessibleForFree: true,
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      sameAs: [REPO_URL],
      publisher: { "@id": ORGANIZATION_ID },
    },
  ],
});

function structuredDataHeadForPage(relativePath: string): HeadConfig[] {
  if (relativePath !== "index.md") return [];
  return [
    [
      "script",
      { type: "application/ld+json", id: "jobctrl-structured-data" },
      HOME_STRUCTURED_DATA,
    ],
  ];
}

// Docs that stay in the repository but are not published on the site.
// docs/README.md is the repo-facing documentation map (GitHub renders it when
// browsing docs/); the site's homepage is the hero landing page in index.md.
const UNPUBLISHED_PREFIXES = ["docs/plans/", "docs/incidents/"];
const UNPUBLISHED_FILES = new Set([
  "docs/backlog.md",
  "docs/claims-ledger.md",
  "docs/decisions.md",
  "docs/delivered.md",
  "docs/publish-checklist.md",
  "docs/README.md",
  "docs/requirements.md",
]);

// Single source of truth for page rewrites: fed to VitePress `rewrites` AND
// used to fix inbound links. VitePress strips `.md` from links but does not
// apply the rewrite map to them, so a link to `developer/README.md` would
// otherwise emit `developer/README` — a page that is never built.
const PAGE_REWRITES: Record<string, string> = {
  "developer/README.md": "developer/index.md",
};

function routeForRewrittenPage(docPath: string): string | null {
  const rewritten = PAGE_REWRITES[docPath];
  if (!rewritten) return null;
  // With cleanUrls: `index.md` -> `/`, `developer/index.md` -> `/developer/`.
  return "/" + rewritten.replace(/index\.md$/, "").replace(/\.md$/, "");
}

function canonicalUrlForPage(docPath: string): string {
  const rewrittenPath = PAGE_REWRITES[docPath] ?? docPath;
  const route = rewrittenPath
    .replace(/(?:^|\/)index\.md$/, "/")
    .replace(/\.md$/, "");
  return new URL(route.startsWith("/") ? route : `/${route}`, DOCS_SITE_URL).toString();
}

// One guide, one navigation tree. The first two groups answer the questions a
// new reader asks; contributor, architecture, and reference depth stays
// available everywhere through collapsed groups. Every route appears once so
// active-link state and previous/next navigation remain unambiguous.
const SIDEBAR: DefaultTheme.SidebarItem[] = [
  { text: "Home", link: "/" },
  // Frozen slot for the alternatives-comparison page (launch-readiness plan
  // §8.2). Label/placement are an owner decision (§11.3); the URL is frozen.
  { text: "How It Compares", link: "/comparison" },
  {
    text: "Start Here",
    collapsed: false,
    items: [
      { text: "Product Tour", link: "/user/product-tour" },
      { text: "Getting Started", link: "/user/getting-started" },
      { text: "Daily Workflow", link: "/user/normal-flows" },
    ],
  },
  {
    text: "The Job-Search Lifecycle",
    collapsed: false,
    items: [
      { text: "Candidate Profile", link: "/user/candidate-profile" },
      { text: "Discovery & Sources", link: "/user/discovery" },
      { text: "Enrichment & Extraction", link: "/user/enrichment-and-extraction" },
      { text: "Scoring", link: "/user/scoring-and-employer-analysis" },
      { text: "Materials & Tailoring", link: "/user/materials-and-tailoring" },
      { text: "Apply", link: "/user/apply" },
      { text: "Outcomes & Feedback", link: "/user/outcomes-and-feedback" },
      { text: "Contacts & Outreach", link: "/user/contacts-and-outreach" },
      { text: "Compensation Evidence", link: "/user/compensation-evidence" },
    ],
  },
  {
    text: "Configuration & Trust",
    collapsed: true,
    items: [
      { text: "Configuration & Credentials", link: "/user/configuration" },
      { text: "Data, Privacy & Safety", link: "/user/data-and-safety" },
      {
        text: "Security",
        collapsed: true,
        items: [
          { text: "Security & Hardening", link: "/user/security" },
          { text: "Threat Model & Security Engineering", link: "/developer/security" },
        ],
      },
    ],
  },
  {
    text: "Build & Verify",
    collapsed: true,
    items: [
      { text: "Contributor Start", link: "/developer/" },
      { text: "Repository & Ownership Map", link: "/developer/repository-and-ownership-map" },
      { text: "Local Development", link: "/local-development" },
      { text: "Documentation Standards", link: "/developer/documentation-standards" },
      {
        text: "Reliability & QA",
        collapsed: true,
        items: [
          { text: "What To Run", link: "/local-reliability-qa" },
          { text: "Regression Catalog", link: "/developer/qa/regression-catalog" },
          { text: "Browser Smoke", link: "/developer/qa/browser-smoke" },
          { text: "Frontend QA", link: "/developer/qa/frontend" },
          { text: "First-Run Validation", link: "/developer/first-run-ttfv" },
          { text: "Complete Checklist", link: "/developer/qa/complete-checklist" },
        ],
      },
    ],
  },
  {
    text: "How JobCtrl Works",
    collapsed: true,
    items: [
      { text: "System Overview", link: "/architecture/" },
      { text: "Runtime & Processes", link: "/architecture/runtime" },
      {
        text: "Temporal Workflows",
        collapsed: true,
        items: [
          { text: "Workflow Catalog", link: "/architecture/pipeline/" },
          { text: "Stage Execution", link: "/architecture/pipeline/stages" },
          { text: "Activities, Retries & Cancellation", link: "/architecture/pipeline/envelope" },
          { text: "Concurrency & Fan-out", link: "/architecture/pipeline/concurrency" },
          { text: "Schedules, Operations & Recovery", link: "/architecture/pipeline/operations" },
        ],
      },
      {
        text: "Data, Events & Projections",
        collapsed: true,
        items: [
          { text: "Concepts & Ownership", link: "/architecture/data-events-and-projections" },
          { text: "Storage Authority", link: "/architecture/storage" },
          { text: "Apply Feedback Projection", link: "/architecture/read-model" },
        ],
      },
      {
        text: "AI Decisions & Materials",
        collapsed: true,
        items: [
          { text: "Scoring Policy", link: "/architecture/scoring" },
          { text: "Employer Analysis & Materials Audit", link: "/architecture/materials" },
          { text: "Tailoring Contract", link: "/architecture/tailoring" },
        ],
      },
      { text: "Contracts, Types & API Boundaries", link: "/architecture/contracts-types-and-api-boundaries" },
      { text: "Frontend Architecture", link: "/architecture/frontend/" },
      { text: "Observability", link: "/architecture/observability" },
    ],
  },
  {
    text: "Reference",
    collapsed: true,
    items: [
      {
        text: "API",
        collapsed: true,
        items: [
          { text: "Overview", link: "/local-ts-api" },
          { text: "Profile & Settings", link: "/api/profile-and-settings" },
          { text: "Jobs & Materials", link: "/api/jobs-and-materials" },
          { text: "Operations & Events", link: "/api/operations-and-events" },
          { text: "Complete Contract", link: "/api/complete-contract" },
        ],
      },
      {
        text: "Backend Domain Model",
        collapsed: true,
        items: [
          { text: "Overview", link: "/architecture/domain-model/" },
          { text: "Contexts & Domain Language", link: "/architecture/domain-model/strategic" },
          { text: "Aggregates & Invariants", link: "/architecture/domain-model/tactical" },
          { text: "Interfaces & Adapters", link: "/architecture/domain-model/ports" },
          { text: "Context Integration", link: "/architecture/domain-model/integration" },
          { text: "Persistence & Failure Modes", link: "/architecture/domain-model/persistence" },
          { text: "Hosted Deployment — Future", link: "/architecture/domain-model/cloud" },
        ],
      },
      {
        text: "Frontend Design",
        collapsed: true,
        items: [
          { text: "Frontend Contexts", link: "/architecture/frontend/contexts" },
          { text: "Folder Structure", link: "/architecture/frontend/structure" },
          { text: "Context Patterns", link: "/architecture/frontend/patterns" },
          { text: "State & Interfaces", link: "/architecture/frontend/state-and-ports" },
          { text: "Realtime Updates", link: "/architecture/frontend/realtime" },
          { text: "Integration & Evolution", link: "/architecture/frontend/integration" },
          { text: "Testing Architecture", link: "/architecture/frontend/testing" },
        ],
      },
      {
        text: "Glossary & Open Questions",
        collapsed: true,
        items: [
          { text: "Backend Glossary & Risks", link: "/architecture/domain-model/reference" },
          { text: "Frontend Glossary & Risks", link: "/architecture/frontend/reference" },
        ],
      },
    ],
  },
];

/**
 * Rewrites markdown links that resolve outside the published docs set
 * (repo-root files like ../README.md, or intentionally unpublished internal
 * docs like plans/ and backlog.md) into absolute GitHub URLs, so the deployed
 * site never ships a relative link that 404s. Links inside the published set
 * are left for VitePress to resolve and dead-link-check as usual.
 */
function rewriteEscapingLink(href: string, pageRelativePath: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) {
    return null;
  }
  const hashIndex = href.indexOf("#");
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  if (path === "") return null;
  const repoPath = posix.normalize(posix.join("docs", posix.dirname(pageRelativePath), path));
  const escapesDocs = !repoPath.startsWith("docs/");
  const isUnpublished =
    UNPUBLISHED_PREFIXES.some((prefix) => repoPath.startsWith(prefix)) ||
    UNPUBLISHED_FILES.has(repoPath);
  if (escapesDocs || isUnpublished) {
    const view = path.endsWith("/") ? "tree" : "blob";
    return `${REPO_URL}/${view}/main/${repoPath}${hash}`;
  }
  const rewrittenRoute = routeForRewrittenPage(repoPath.slice("docs/".length));
  if (rewrittenRoute) return `${rewrittenRoute}${hash}`;
  return null;
}

export default withMermaid(
  defineConfig({
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    sitemap: {
      hostname: DOCS_SITE_URL,
    },
    head: [
      ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
      ["link", { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" }],
      ["link", { rel: "icon", type: "image/png", sizes: "512x512", href: "/assets/brand/app-icon.png" }],
      ["meta", { name: "theme-color", content: "#6d28d9" }],
    ],
    transformHead: ({ pageData, title, description }) => {
      const canonicalUrl = canonicalUrlForPage(pageData.relativePath);
      return [
        ["link", { rel: "canonical", href: canonicalUrl }],
        ["meta", { property: "og:type", content: "website" }],
        ["meta", { property: "og:site_name", content: SITE_NAME }],
        ["meta", { property: "og:url", content: canonicalUrl }],
        ["meta", { property: "og:title", content: title }],
        ["meta", { property: "og:description", content: description }],
        ["meta", { property: "og:image", content: SOCIAL_IMAGE_URL }],
        ["meta", { property: "og:image:width", content: "1200" }],
        ["meta", { property: "og:image:height", content: "630" }],
        ["meta", { property: "og:image:alt", content: SOCIAL_IMAGE_ALT }],
        ["meta", { name: "twitter:card", content: "summary_large_image" }],
        ["meta", { name: "twitter:title", content: title }],
        ["meta", { name: "twitter:description", content: description }],
        ["meta", { name: "twitter:image", content: SOCIAL_IMAGE_URL }],
        ["meta", { name: "twitter:image:alt", content: SOCIAL_IMAGE_ALT }],
        ...structuredDataHeadForPage(pageData.relativePath),
      ];
    },
    srcExclude: [
      "plans/**",
      "incidents/**",
      "backlog.md",
      "claims-ledger.md",
      "decisions.md",
      "delivered.md",
      "publish-checklist.md",
      "README.md",
      "requirements.md",
    ],
    cleanUrls: true,
    lastUpdated: true,
    rewrites: PAGE_REWRITES,
    vite: {
      // The workspace-wide esbuild override (security pin) refuses to lower
      // destructuring to Vite 5's default legacy browser targets; a modern
      // floor keeps those transforms no-ops for this developer-facing site.
      // Applies to both the production build and dev-server pre-bundling.
      build: { target: "es2022" },
      optimizeDeps: {
        esbuildOptions: { target: "es2022" },
        // mermaid's CJS deps must be pre-bundled for dev; under pnpm's strict
        // layout they only resolve through mermaid, not from the repo root.
        include: ["mermaid > dayjs", "mermaid > @braintree/sanitize-url"],
      },
    },
    markdown: {
      config(md) {
        const defaultRender =
          md.renderer.rules.link_open ??
          ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
        md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
          const href = tokens[idx].attrGet("href");
          if (href && env.relativePath) {
            const rewritten = rewriteEscapingLink(href, env.relativePath);
            if (rewritten) tokens[idx].attrSet("href", rewritten);
          }
          return defaultRender(tokens, idx, options, env, self);
        };
      },
    },
    themeConfig: {
      logo: { src: "/assets/brand/app-icon.png", alt: "JobCtrl" },
      siteTitle: 'Job<span class="jh-site-title-accent">Ctrl</span>',
      // There is one guide. Search, theme controls, and the repository link
      // remain in the header; the sidebar owns all documentation navigation.
      nav: [],
      sidebar: SIDEBAR,
      socialLinks: [{ icon: "github", link: REPO_URL }],
      footer: {
        copyright: `Copyright © 2026 Eloi Barti and JobCtrl contributors. Licensed under <a href="${REPO_URL}/blob/main/LICENSE">AGPL-3.0-only</a>. <a href="${REPO_URL}">Source code</a>. <button type="button" class="jh-cookie-settings-link" data-jh-cookie-settings>Cookie settings</button>.`,
      },
      search: {
        provider: "local",
        options: {
          miniSearch: {
            searchOptions: {
              boost: { title: 4, titles: 2, text: 1 },
              prefix: true,
            },
          },
        },
      },
      outline: { level: [2, 3] },
    },
    // Diagram styling lives in the theme layer: docs/.vitepress/theme
    // registers its own Mermaid renderer with curated light/dark palettes
    // (mermaid-theme.ts). This block only keeps the plugin's markdown
    // transform + dep pre-bundling active.
    mermaid: {},
  }),
);
