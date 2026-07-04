import { posix } from "node:path";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const REPO_URL = "https://github.com/ebarti/JobHunter";

// Docs that stay in the repository but are not published on the site.
const UNPUBLISHED_PREFIXES = ["docs/plans/", "docs/incidents/"];
const UNPUBLISHED_FILES = new Set(["docs/backlog.md", "docs/delivered.md"]);

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
  if (!escapesDocs && !isUnpublished) return null;
  const view = path.endsWith("/") ? "tree" : "blob";
  return `${REPO_URL}/${view}/main/${repoPath}${hash}`;
}

export default withMermaid(
  defineConfig({
    title: "JobHunter",
    description:
      "Local-first, AI-assisted job application pipeline: discovery, scoring, tailored materials, and supervised apply.",
    srcExclude: ["plans/**", "incidents/**", "backlog.md", "delivered.md"],
    cleanUrls: true,
    lastUpdated: true,
    rewrites: {
      "INDEX.md": "index.md",
      "developer/README.md": "developer/index.md",
    },
    vite: {
      // The workspace-wide esbuild override (security pin) cannot lower some
      // mermaid syntax to Vite 5's default legacy browser targets; a modern
      // floor keeps that transform a no-op for this developer-facing site.
      build: { target: "es2022" },
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
      sidebar: [
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
      ],
      socialLinks: [{ icon: "github", link: REPO_URL }],
      search: { provider: "local" },
      outline: { level: [2, 3] },
    },
    mermaid: {},
  }),
);
