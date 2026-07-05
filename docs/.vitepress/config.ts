import { posix } from "node:path";
import { defineConfig, type DefaultTheme } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const REPO_URL = "https://github.com/ebarti/JobHunter";

// Docs that stay in the repository but are not published on the site.
// docs/README.md is the repo-facing documentation map (GitHub renders it when
// browsing docs/); the site's homepage is the hero landing page in index.md.
const UNPUBLISHED_PREFIXES = ["docs/plans/", "docs/incidents/"];
const UNPUBLISHED_FILES = new Set([
  "docs/backlog.md",
  "docs/claims-ledger.md",
  "docs/delivered.md",
  "docs/README.md",
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

// One unified sidebar for the whole site — the user and developer guides are
// one navigation tree, in reader-journey order (see "Documentation Standards"
// in docs/developer/README.md): use the product (User Guide: install → see
// it → use it daily → tune it → understand the data → protect it) → change
// the product (Developer Guide) → understand the system (System
// Architecture) → look things up (API, Reference). User-guide pages hide the
// developer/reference groups in the theme layer; developer and reference
// sections stay collapsed until opened or active. URLs are frozen; only labels
// and order may change here.
const SIDEBAR: DefaultTheme.SidebarItem[] = [
  { text: "Home", link: "/" },
  {
    text: "User Guide",
    collapsed: false,
    items: [
      { text: "Getting Started", link: "/user/getting-started" },
      { text: "Product Tour", link: "/user/screenshots" },
      { text: "Daily Workflow", link: "/user/normal-flows" },
      { text: "Configuration", link: "/user/configuration" },
      { text: "Data, Privacy & Safety", link: "/user/data-and-safety" },
      { text: "Security", link: "/user/security" },
    ],
  },
  {
    text: "Developer Guide",
    collapsed: true,
    items: [
      { text: "Overview", link: "/developer/" },
      { text: "Local Development", link: "/local-development" },
      { text: "Reliability & QA", link: "/local-reliability-qa" },
      { text: "Security", link: "/developer/security" },
    ],
  },
  // Reader-journey order: what the system is (Overview, Runtime) → what it
  // does (Job Pipeline, then per-stage deep-dives in pipeline order: Scoring →
  // Materials → Tailoring → Apply feedback) → where data lives (Storage) →
  // how to watch it (Observability) → how it is designed (backend Domain
  // Model, Frontend). prev/next footers follow this order, so it is also the
  // linear reading path.
  {
    text: "System Architecture",
    collapsed: true,
    items: [
      { text: "Overview", link: "/architecture/" },
      { text: "Runtime Boundaries", link: "/architecture/runtime" },
      {
        text: "Job Pipeline",
        collapsed: true,
        items: [
          { text: "Overview", link: "/architecture/pipeline/" },
          { text: "Stage Walkthrough", link: "/architecture/pipeline/stages" },
          { text: "Envelope & Activities", link: "/architecture/pipeline/envelope" },
          { text: "Concurrency & Fan-out", link: "/architecture/pipeline/concurrency" },
          { text: "Operations & Events", link: "/architecture/pipeline/operations" },
        ],
      },
      { text: "Scoring", link: "/architecture/scoring" },
      { text: "Materials & Tailoring Audit", link: "/architecture/materials" },
      { text: "Tailoring Contract", link: "/architecture/tailoring" },
      { text: "Apply Feedback & Projections", link: "/architecture/read-model" },
      { text: "Storage", link: "/architecture/storage" },
      { text: "Observability", link: "/architecture/observability" },
      {
        text: "Backend Domain Model (DDD)",
        collapsed: true,
        items: [
          { text: "Overview", link: "/architecture/domain-model/" },
          { text: "Strategic Design", link: "/architecture/domain-model/strategic" },
          { text: "Tactical Design", link: "/architecture/domain-model/tactical" },
          { text: "Ports & Adapters", link: "/architecture/domain-model/ports" },
          { text: "Cross-Context Integration", link: "/architecture/domain-model/integration" },
          { text: "Persistence & Consistency", link: "/architecture/domain-model/persistence" },
          { text: "Cloud Deployment", link: "/architecture/domain-model/cloud" },
          { text: "Risks & Glossary", link: "/architecture/domain-model/reference" },
        ],
      },
      {
        text: "Frontend Architecture",
        collapsed: true,
        items: [
          { text: "Overview", link: "/architecture/frontend/" },
          { text: "Bounded Contexts", link: "/architecture/frontend/contexts" },
          { text: "Folder Structure", link: "/architecture/frontend/structure" },
          { text: "Context Patterns", link: "/architecture/frontend/patterns" },
          { text: "State & Ports", link: "/architecture/frontend/state-and-ports" },
          { text: "Realtime (SSE)", link: "/architecture/frontend/realtime" },
          { text: "Integration & Evolution", link: "/architecture/frontend/integration" },
          { text: "Testing", link: "/architecture/frontend/testing" },
          { text: "Risks & Glossary", link: "/architecture/frontend/reference" },
        ],
      },
    ],
  },
  {
    text: "API",
    collapsed: true,
    items: [{ text: "Local TypeScript API", link: "/local-ts-api" }],
  },
  {
    text: "Reference",
    collapsed: true,
    items: [
      { text: "Requirements", link: "/requirements" },
      { text: "Decisions (ADRs)", link: "/decisions" },
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
    title: "JobHunter",
    description:
      "Local-first, AI-assisted job application pipeline: discovery, scoring, tailored materials, and supervised apply.",
    srcExclude: ["plans/**", "incidents/**", "backlog.md", "claims-ledger.md", "delivered.md", "README.md"],
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
      nav: [
        { text: "Guide", link: "/user/getting-started" },
        { text: "Architecture", link: "/architecture/" },
      ],
      sidebar: SIDEBAR,
      socialLinks: [{ icon: "github", link: REPO_URL }],
      footer: {
        message: "Documentation screenshots and examples use synthetic data unless noted.",
        copyright: `Copyright © 2026 JobHunter contributors. Licensed under <a href="${REPO_URL}/blob/main/LICENSE">AGPL-3.0-only</a>.`,
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
