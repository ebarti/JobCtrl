import { posix } from "node:path";
import { defineConfig, type DefaultTheme } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const REPO_URL = "https://github.com/ebarti/JobHunter";

// Docs that stay in the repository but are not published on the site.
const UNPUBLISHED_PREFIXES = ["docs/plans/", "docs/incidents/"];
const UNPUBLISHED_FILES = new Set(["docs/backlog.md", "docs/delivered.md"]);

// Single source of truth for page rewrites: fed to VitePress `rewrites` AND
// used to fix inbound links. VitePress strips `.md` from links but does not
// apply the rewrite map to them, so a link to `developer/README.md` would
// otherwise emit `developer/README` — a page that is never built.
const PAGE_REWRITES: Record<string, string> = {
  "INDEX.md": "index.md",
  "developer/README.md": "developer/index.md",
};

function routeForRewrittenPage(docPath: string): string | null {
  const rewritten = PAGE_REWRITES[docPath];
  if (!rewritten) return null;
  // With cleanUrls: `index.md` -> `/`, `developer/index.md` -> `/developer/`.
  return "/" + rewritten.replace(/index\.md$/, "").replace(/\.md$/, "");
}

const USER_SIDEBAR: DefaultTheme.SidebarItem[] = [
  { text: "Overview", link: "/" },
  {
    text: "User Guide",
    items: [
      { text: "Getting Started", link: "/user/getting-started" },
      { text: "Configuration", link: "/user/configuration" },
      { text: "Normal Flows", link: "/user/normal-flows" },
      { text: "Data & Safety", link: "/user/data-and-safety" },
      { text: "Screenshots", link: "/user/screenshots" },
    ],
  },
];

const DEVELOPER_SIDEBAR: DefaultTheme.SidebarItem[] = [
  {
    text: "Developer Guide",
    items: [
      { text: "Overview", link: "/developer/" },
      { text: "Local Development", link: "/local-development" },
      { text: "Local TypeScript API", link: "/local-ts-api" },
      { text: "Reliability & QA", link: "/local-reliability-qa" },
      { text: "Screenshot Playbook", link: "/developer/screenshot-playbook" },
    ],
  },
  {
    text: "Architecture",
    items: [
      { text: "System Architecture", link: "/architecture" },
      { text: "Job Pipeline", link: "/job-pipeline-architecture" },
      { text: "Domain Model (DDD)", link: "/ddd-target" },
      { text: "Frontend", link: "/frontend-target" },
      { text: "Resume Tailoring", link: "/tailoring" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Requirements", link: "/requirements" },
      { text: "Decisions (ADRs)", link: "/decisions" },
    ],
  },
];

// Sectioned sidebar: user-guide pages (and the homepage) show only the User
// Guide; developer-facing pages show the developer sidebar. Developer pages
// live at mixed top-level paths, so each is enumerated. VitePress picks the
// key by slash-count-descending order and ties keep insertion order, so the
// "/" fallback must stay LAST.
const SIDEBAR: DefaultTheme.Sidebar = {
  "/user/": USER_SIDEBAR,
  "/developer/": DEVELOPER_SIDEBAR,
  "/local-development": DEVELOPER_SIDEBAR,
  "/local-ts-api": DEVELOPER_SIDEBAR,
  "/local-reliability-qa": DEVELOPER_SIDEBAR,
  "/architecture": DEVELOPER_SIDEBAR,
  "/job-pipeline-architecture": DEVELOPER_SIDEBAR,
  "/ddd-target": DEVELOPER_SIDEBAR,
  "/frontend-target": DEVELOPER_SIDEBAR,
  "/tailoring": DEVELOPER_SIDEBAR,
  "/requirements": DEVELOPER_SIDEBAR,
  "/decisions": DEVELOPER_SIDEBAR,
  "/": USER_SIDEBAR,
};

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
    srcExclude: ["plans/**", "incidents/**", "backlog.md", "delivered.md"],
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
        { text: "User Guide", link: "/user/getting-started" },
        { text: "Developer", link: "/developer/" },
        { text: "Architecture", link: "/architecture" },
      ],
      sidebar: SIDEBAR,
      socialLinks: [{ icon: "github", link: REPO_URL }],
      search: { provider: "local" },
      outline: { level: [2, 3] },
    },
    mermaid: {},
  }),
);
