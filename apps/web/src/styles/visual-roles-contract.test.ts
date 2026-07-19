import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(styleDir, "../..");
const repoRoot = resolve(webRoot, "../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const roleCss = read("apps/web/src/styles/visual-roles.css");
const dashboardCss = read("apps/web/src/styles/redesign-dashboard.css");
const mainSource = read("apps/web/src/main.tsx");

function applicationSources(directory: string): Array<{
  path: string;
  source: string;
}> {
  return readdirSync(resolve(repoRoot, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return applicationSources(path);
      if (
        !entry.name.endsWith(".tsx") ||
        entry.name.includes(".test.") ||
        entry.name.includes(".stories.")
      ) {
        return [];
      }
      return [{ path, source: read(path) }];
    },
  );
}

function applicationStyles(): Array<{ path: string; source: string }> {
  return readdirSync(styleDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".css") || entry.name === "tokens.css") {
      return [];
    }
    const path = `apps/web/src/styles/${entry.name}`;
    return [{ path, source: read(path) }];
  });
}

const allowedVisualColorExceptions = new Set([
  "generated-resume-artifact",
  "resume-editor-chrome",
  "resume-comment-chrome",
  "pdf-preview-surface",
  "artifact-preview-surface",
]);

const visualExceptionMarker =
  /\/\*\s*visual-(?<kind>role|color)-exception:(?<boundary>start|end)\s+(?<name>[a-z-]+)\s*\*\//g;

function stripVisualColorExceptions(source: string, path: string): string {
  const markers = [...source.matchAll(visualExceptionMarker)];
  const retained: string[] = [];
  let cursor = 0;
  let active:
    | {
        kind: string;
        name: string;
      }
    | undefined;

  for (const marker of markers) {
    const kind = marker.groups?.["kind"] ?? "";
    const boundary = marker.groups?.["boundary"] ?? "";
    const name = marker.groups?.["name"] ?? "";

    expect(allowedVisualColorExceptions, `${path} exception ${name}`).toContain(name);

    if (boundary === "start") {
      expect(active, `${path} nested exception ${name}`).toBeUndefined();
      retained.push(source.slice(cursor, marker.index));
      active = { kind, name };
      continue;
    }

    expect(active, `${path} orphan exception end ${name}`).toBeDefined();
    expect(active?.kind, `${path} exception kind ${name}`).toBe(kind);
    expect(active?.name, `${path} exception pair ${name}`).toBe(name);
    cursor = (marker.index ?? 0) + marker[0].length;
    active = undefined;
  }

  expect(active, `${path} unclosed visual exception`).toBeUndefined();
  retained.push(source.slice(cursor));
  return retained.join("");
}

const requiredVisualColorExceptionPairs = [
  ["apps/web/src/styles/globals.css", "role", "generated-resume-artifact", 1],
  ["apps/web/src/styles/globals.css", "color", "resume-editor-chrome", 1],
  ["apps/web/src/styles/globals.css", "color", "resume-comment-chrome", 1],
  ["apps/web/src/styles/globals.css", "color", "pdf-preview-surface", 1],
  ["apps/web/src/styles/globals.css", "color", "artifact-preview-surface", 1],
  ["apps/web/src/styles/redesign-configuration.css", "color", "resume-editor-chrome", 1],
  ["apps/web/src/styles/redesign-detail-surfaces.css", "color", "artifact-preview-surface", 2],
] as const;

function isGeneratedResumeOutputMetric(path: string, source: string, index: number): boolean {
  if (path !== "apps/web/src/contexts/profile/components/ResumeTemplatePanel.tsx") {
    return false;
  }
  const start = source.indexOf("const DENSITY_TOKENS");
  const end = source.indexOf("export function ResumeTemplatePanel");
  return start >= 0 && index >= start && index < end;
}

const requiredRoles = [
  "page-title",
  "section-title",
  "component-title",
  "body",
  "strong-body",
  "control",
  "label",
  "status",
  "table-header",
  "metadata",
  "metric",
  "code",
] as const;

describe("shared visual role contract", () => {
  it("imports the canonical role layer after every route stylesheet", () => {
    const visualRoleImport = mainSource.indexOf('import "./styles/visual-roles.css";');
    const lastRouteImport = mainSource.indexOf(
      'import "./styles/redesign-route-workspaces.css";',
    );

    expect(visualRoleImport).toBeGreaterThan(lastRouteImport);
  });

  it("defines one exact token-backed declaration for every approved role", () => {
    for (const role of requiredRoles) {
      expect(roleCss).toContain(`[data-typography="${role}"]`);
    }

    expect(roleCss).toContain("var(--jh-type-page-title-size)");
    expect(roleCss).toContain("var(--jh-type-section-title-size)");
    expect(roleCss).toContain("var(--jh-type-component-title-size)");
    expect(roleCss).toContain("var(--jh-type-body-size)");
    expect(roleCss).toContain("var(--jh-type-label-size)");
    expect(roleCss).toContain("var(--jh-type-metric-size)");
    expect(roleCss).toContain(
      '[data-typography="status"] {\n  font-size: var(--jh-type-body-size) !important;\n  font-weight: var(--jh-type-strong-body-weight) !important;\n  line-height: var(--jh-type-body-line-height) !important;\n}',
    );
  });

  it("keeps generated resume artifact typography outside the application role bridge", () => {
    expect(roleCss).toContain(":not(:where(.resume-plate-document *))");
    expect(roleCss).toContain(
      "h1:not([data-typography]):not(:where(.resume-plate-document *))",
    );
    expect(roleCss).toContain(
      ":is(h3, h4, h5, h6):not([data-typography]):not(:where(.resume-plate-document *))",
    );
    expect(roleCss).toContain(
      ":is(p, blockquote, dd):not([data-typography]):not(:where(.resume-plate-document *))",
    );
    expect(roleCss).toContain(
      ":is(button, [role=\"button\"], .jh-button):not([data-typography]):not(",
    );
  });

  it("limits fixed visual color artifacts to balanced named exceptions", () => {
    for (const [path, kind, name, pairCount] of requiredVisualColorExceptionPairs) {
      const markers = [...read(path).matchAll(visualExceptionMarker)].filter(
        (marker) => marker.groups?.["kind"] === kind && marker.groups?.["name"] === name,
      );

      expect(
        markers.filter((marker) => marker.groups?.["boundary"] === "start"),
        `${path} ${name} start markers`,
      ).toHaveLength(pairCount);
      expect(
        markers.filter((marker) => marker.groups?.["boundary"] === "end"),
        `${path} ${name} end markers`,
      ).toHaveLength(pairCount);
    }

    for (const { path, source } of applicationStyles()) {
      stripVisualColorExceptions(source, path);
    }
  });

  it("keeps shared primitive roles explicit and semantic", () => {
    const sources = {
      button: read("apps/web/src/shared/ui/button.tsx"),
      alert: read("apps/web/src/shared/ui/alert.tsx"),
      status: read("apps/web/src/shared/ui/status-badge.tsx"),
      field: read("apps/web/src/shared/ui/field.tsx"),
      table: read("apps/web/src/shared/ui/table.tsx"),
      pageHead: read("apps/web/src/shared/ui/page-head.tsx"),
    };

    expect(sources.button).toContain('data-typography="control"');
    expect(sources.alert).toContain('data-typography="component-title"');
    expect(sources.alert).toContain('data-typography="body"');
    expect(sources.status).toContain('data-typography="status"');
    expect(sources.field).toContain('data-typography="metadata"');
    expect(sources.table).toContain('data-typography="table-header"');
    expect(sources.pageHead).toContain('data-typography="page-title"');
  });

  it("keeps semantic alert bodies neutral and grid hit areas token-sized", () => {
    expect(roleCss).toContain(
      '[data-slot="alert"] [data-slot="alert-description"] {\n  color: var(--foreground) !important;',
    );
    expect(roleCss).toContain("min-inline-size: var(--jh-target-min-size);");
    expect(roleCss).toContain("min-block-size: var(--jh-target-min-size);");
  });

  it("removes application motion when reduced motion is requested", () => {
    expect(roleCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(roleCss).toContain("transition-duration: 0.01ms !important;");
    expect(roleCss).toContain("animation-duration: 0.01ms !important;");
  });

  it("allows dashboard funnel content to reflow inside shared buttons", () => {
    expect(dashboardCss).toContain(".dashboard-view .funnel-row .legend > span");
    expect(dashboardCss).toContain("overflow-wrap: anywhere;");
    expect(dashboardCss).toContain("white-space: normal;");
  });

  it("rejects raw typography metrics across all application components and styles", () => {
    const sources = applicationSources("apps/web/src");
    const rawUtilities = sources.flatMap(({ path, source }) =>
      [
        ...source.matchAll(
          /(?:text|leading|font)-\[(?<value>-?\d+(?:\.\d+)?(?:px|rem|em|%)?)\]/g,
        ),
        ...source.matchAll(
          /(?:fontSize|fontWeight|lineHeight|textTransform)\s*:\s*["']?\d/g,
        ),
      ]
        .filter(
          (match) => !isGeneratedResumeOutputMetric(path, source, match.index ?? -1),
        )
        .map((match) => `${path}: ${match[0]}`),
    );

    expect(rawUtilities).toEqual([]);

    const allowedTypographyValue = (property: string, value: string): boolean => {
      const normalized = value.replace(/\s*!important\s*$/, "").trim();
      if (normalized === "inherit") return true;
      if (property === "letter-spacing") return normalized === "normal";
      if (property === "text-transform") return normalized === "none";
      const suffix =
        property === "font-size"
          ? "size"
          : property === "line-height"
            ? "line-height"
            : "weight";
      return new RegExp(`^var\\(--jh-type-[a-z-]+-${suffix}\\)$`).test(normalized);
    };
    const rawStyleDeclarations = applicationStyles().flatMap(({ path, source }) => {
      const auditableSource = stripVisualColorExceptions(source, path);
      return [
        ...auditableSource.matchAll(
          /(?<![-\w])(?<property>font-size|font-weight|line-height|letter-spacing|text-transform)\s*:\s*(?<value>[^;]+);/g,
        ),
      ]
        .filter((match) => {
          const property = match.groups?.["property"] ?? "";
          const value = match.groups?.["value"] ?? "";
          return !allowedTypographyValue(property, value);
        })
        .map((match) => `${path}: ${match[0]}`);
    });
    expect(rawStyleDeclarations).toEqual([]);
  });

  it("rejects literal semantic colors outside token and named exception blocks", () => {
    const semanticColorProperty =
      /^--(?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|success|warning|border|input|ring)(?:-[a-z-]+)?$/;
    const colorBearingProperty =
      /^(?:color|background(?:-color)?|border(?:-[a-z-]+)?|outline(?:-color)?|fill|stroke)$/;
    const literalSemanticColor =
      /(?:#[\da-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|\b(?:white|black)\b)/i;
    const allowedColorValue = (value: string): boolean => {
      const normalized = value.replace(/\s*!important\s*$/, "").trim();
      return /^(?:var\([^)]*\)|transparent|currentColor|inherit)$/i.test(normalized);
    };

    const rawColorDeclarations = applicationStyles().flatMap(({ path, source }) => {
      const auditableSource = stripVisualColorExceptions(source, path);
      return [
        ...auditableSource.matchAll(
          /(?<![-\w])(?<property>--[a-z][a-z0-9-]*|color|background(?:-color)?|border(?:-[a-z-]+)?|outline(?:-color)?|fill|stroke)\s*:\s*(?<value>[^;{}]+);/gi,
        ),
      ]
        .filter((match) => {
          const property = match.groups?.["property"] ?? "";
          const value = match.groups?.["value"] ?? "";
          return (
            (colorBearingProperty.test(property) || semanticColorProperty.test(property)) &&
            !allowedColorValue(value) &&
            literalSemanticColor.test(value)
          );
        })
        .map(
          (match) =>
            `${path}: ${match.groups?.["property"]}: ${match.groups?.["value"]?.trim()}`,
        );
    });

    expect(rawColorDeclarations).toEqual([]);
  });

  it("rejects semantic fill tokens as visible foreground colors outside named exception blocks", () => {
    const rawSemanticForegrounds = applicationStyles().flatMap(({ path, source }) => {
      const auditableSource = stripVisualColorExceptions(source, path);
      return [
        ...auditableSource.matchAll(
          /(?<![-\\w])color\\s*:\\s*(?<value>[^;{}]+);/gi,
        ),
      ]
        .filter((match) =>
          /(?:^|[^\\w-])var\\(--(?:success|warning|destructive|status-info)\\)/.test(
            match.groups?.["value"] ?? "",
          ),
        )
        .map((match) => `${path}: color: ${match.groups?.["value"]?.trim()}`);
    });

    expect(rawSemanticForegrounds).toEqual([]);
  });

  it("routes visible application controls through shared primitives", () => {
    const rawControls = applicationSources("apps/web/src")
      .filter(({ path }) => !path.includes("/shared/ui/"))
      .flatMap(({ path, source }) =>
        [...source.matchAll(/<(button|input|select|textarea)\b/g)].flatMap((match) => {
          const start = match.index ?? 0;
          const end = source.indexOf(">", start);
          const openingTag = source.slice(start, end >= 0 ? end + 1 : start + 120);
          if (match[1] === "input" && /type\s*=\s*["']hidden["']/.test(openingTag)) {
            return [];
          }
          return [`${path}: ${openingTag.replace(/\s+/g, " ").slice(0, 180)}`];
        }),
      );

    expect(rawControls).toEqual([]);
  });
});
