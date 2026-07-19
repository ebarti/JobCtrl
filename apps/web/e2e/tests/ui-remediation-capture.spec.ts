import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { expect, type ConsoleMessage, type Page, test } from "@playwright/test";

const captureDirectory = process.env["JOBCTRL_UI_REMEDIATION_SCREENSHOT_DIR"];
const originalArchive = "/private/tmp/jobctrl-screenshots.ebpJY9";
const platformJobUrl =
  "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const platformJobId = encodeURIComponent(platformJobUrl);
const jobsFilterParams =
  "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

interface CaptureViewport {
  readonly height: number;
  readonly label: string;
  readonly width: number;
}

interface CaptureScreen {
  readonly expectedRedirect?: string;
  readonly index: number;
  readonly path: string;
  readonly routeTemplate: string;
  readonly slug: string;
}

interface BrowserIssue {
  readonly kind: "console" | "pageerror";
  readonly message: string;
}

interface CaptureRecord {
  readonly actualUrl: string;
  readonly browserIssues: readonly BrowserIssue[];
  readonly dimensions: { readonly height: number; readonly width: number };
  readonly expectedRedirect: string | null;
  readonly file: string;
  readonly heading: string | null;
  readonly navigationError: string | null;
  readonly overlayCount: number;
  readonly overflowElements: readonly {
    readonly left: number;
    readonly right: number;
    readonly selector: string;
    readonly text: string;
    readonly width: number;
  }[];
  readonly overflowPixels: number;
  readonly requestedPath: string;
  readonly routeTemplate: string;
  readonly screen: string;
  readonly viewport: CaptureViewport;
}

const viewports: readonly CaptureViewport[] = [
  { label: "desktop-1440x1000", width: 1440, height: 1000 },
  { label: "desktop-1280x800", width: 1280, height: 800 },
  { label: "mobile-430x932", width: 430, height: 932 },
  { label: "mobile-390x844", width: 390, height: 844 },
  { label: "mobile-320x568", width: 320, height: 568 },
] as const;

const screens: readonly CaptureScreen[] = [
  { index: 1, slug: "dashboard", path: "/dashboard", routeTemplate: "/dashboard" },
  { index: 2, slug: "analytics", path: "/analytics", routeTemplate: "/analytics" },
  { index: 3, slug: "jobs", path: "/jobs", routeTemplate: "/jobs" },
  {
    index: 4,
    slug: "apply-review",
    path: "/apply-review",
    routeTemplate: "/apply-review",
  },
  { index: 5, slug: "pipelines", path: "/pipelines", routeTemplate: "/pipelines" },
  { index: 6, slug: "discovery", path: "/discovery", routeTemplate: "/discovery" },
  { index: 7, slug: "artifacts", path: "/artifacts", routeTemplate: "/artifacts" },
  {
    index: 8,
    slug: "evidence-map",
    path: "/evidence-map",
    routeTemplate: "/evidence-map",
  },
  { index: 9, slug: "contacts", path: "/outreach", routeTemplate: "/outreach" },
  { index: 10, slug: "runs", path: "/runs", routeTemplate: "/runs" },
  { index: 11, slug: "debug", path: "/debug", routeTemplate: "/debug" },
  { index: 12, slug: "profile", path: "/profile", routeTemplate: "/profile" },
  {
    index: 13,
    slug: "preferences",
    path: "/preferences",
    routeTemplate: "/preferences",
  },
  {
    index: 14,
    slug: "settings-general",
    path: "/settings",
    routeTemplate: "/settings",
  },
  {
    index: 15,
    slug: "settings-credentials",
    path: "/settings/credentials",
    routeTemplate: "/settings/credentials",
  },
  {
    index: 16,
    slug: "settings-models",
    path: "/settings/models",
    routeTemplate: "/settings/models",
  },
  {
    index: 17,
    slug: "settings-browser",
    path: "/settings/browser",
    routeTemplate: "/settings/browser",
  },
  {
    index: 18,
    slug: "profile-import-upload",
    path: "/profile/import/upload",
    routeTemplate: "/profile/import/upload",
  },
  {
    index: 19,
    slug: "profile-import-preview",
    path: "/profile/import/preview",
    routeTemplate: "/profile/import/preview",
    expectedRedirect: "/profile/import/upload",
  },
  {
    index: 20,
    slug: "profile-import-confirm",
    path: "/profile/import/confirm",
    routeTemplate: "/profile/import/confirm",
    expectedRedirect: "/profile/import/upload",
  },
  {
    index: 21,
    slug: "job-detail",
    path: `/jobs/${platformJobId}?${jobsFilterParams}`,
    routeTemplate: "/jobs/$jobId",
  },
  {
    index: 22,
    slug: "artifact-detail",
    path: "/artifacts/2",
    routeTemplate: "/artifacts/$artifactId",
  },
  {
    index: 23,
    slug: "run-detail",
    path: "/runs/qa-run-1",
    routeTemplate: "/runs/$runId",
  },
] as const;

function jpegDimensions(buffer: Buffer): { height: number; width: number } {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("Screenshot is not a JPEG image.");
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) {
      break;
    }
    if (startOfFrameMarkers.has(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      throw new Error(`Invalid JPEG segment length ${segmentLength}.`);
    }
    offset += 2 + segmentLength;
  }
  throw new Error("JPEG dimensions could not be read.");
}

function messageText(message: ConsoleMessage): string {
  const location = message.location();
  const suffix = location.url
    ? ` (${location.url}${location.lineNumber ? `:${location.lineNumber}` : ""})`
    : "";
  return `${message.text()}${suffix}`;
}

function routeFromUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function waitForTaskSurface(page: Page): Promise<void> {
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("main h1, [role='main'] h1").first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => {
      const visible = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          node.getBoundingClientRect().height > 0
        );
      };
      return !Array.from(document.querySelectorAll("main p, main [role='status']"))
        .filter(visible)
        .some((element) =>
          /^(Loading|Checking)\b/i.test(element.textContent?.trim() ?? ""),
        );
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(150);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

test.describe("JobCtrl UI remediation screenshot archive", () => {
  test.setTimeout(10 * 60 * 1_000);
  test.skip(
    !captureDirectory,
    "Set JOBCTRL_UI_REMEDIATION_SCREENSHOT_DIR to run the exhaustive capture.",
  );

  test("captures and validates the accepted 23-screen matrix", async ({ page }) => {
    if (!captureDirectory) {
      throw new Error("Capture directory is unavailable after the test gate.");
    }
    const resolvedOutput = path.resolve(captureDirectory);
    if (
      path.dirname(resolvedOutput) !== "/private/tmp" ||
      !path.basename(resolvedOutput).startsWith("jobctrl-ui-remediated-")
    ) {
      throw new Error(
        "JOBCTRL_UI_REMEDIATION_SCREENSHOT_DIR must be a new /private/tmp/jobctrl-ui-remediated-* directory.",
      );
    }
    try {
      await fs.mkdir(resolvedOutput, { recursive: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Capture directory already exists: ${resolvedOutput}`);
      }
      throw error;
    }

    const records: CaptureRecord[] = [];
    const failures: string[] = [];
    let activeBrowserIssues: BrowserIssue[] | null = null;
    page.on("console", (message) => {
      if (message.type() === "error" && activeBrowserIssues) {
        activeBrowserIssues.push({ kind: "console", message: messageText(message) });
      }
    });
    page.on("pageerror", (error) => {
      activeBrowserIssues?.push({ kind: "pageerror", message: error.message });
    });

    for (const viewport of viewports) {
      const viewportDirectory = path.join(resolvedOutput, viewport.label);
      await fs.mkdir(viewportDirectory);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const screen of screens) {
        const fileName = `${String(screen.index).padStart(2, "0")}-${screen.slug}.jpg`;
        const relativeFile = `${viewport.label}/${fileName}`;
        const outputFile = path.join(resolvedOutput, relativeFile);
        activeBrowserIssues = [];
        let navigationError: string | null = null;
        try {
          await page.goto(screen.path, { waitUntil: "domcontentloaded" });
          await waitForTaskSurface(page);
        } catch (error) {
          navigationError = error instanceof Error ? error.message : String(error);
        }

        const headingLocator = page.locator("main h1, [role='main'] h1").first();
        let heading = (await headingLocator.isVisible().catch(() => false))
          ? (await headingLocator.textContent())?.trim() || null
          : null;
        // Vite may perform one dependency-optimization reload immediately
        // after the first route settles. Re-enter the same route once if that
        // warm reload removes the task surface before the viewport capture.
        if (!navigationError && !heading) {
          try {
            await page.goto(screen.path, { waitUntil: "domcontentloaded" });
            await waitForTaskSurface(page);
            heading = (await headingLocator.isVisible().catch(() => false))
              ? (await headingLocator.textContent())?.trim() || null
              : null;
          } catch (error) {
            navigationError = error instanceof Error ? error.message : String(error);
          }
        }
        const overlayCount = await page
          .locator("vite-error-overlay, #vite-error-overlay, [data-vite-error-overlay]")
          .count();
        const layout = await page.evaluate(() => {
          const root = document.documentElement;
          const body = document.body;
          const width = root.clientWidth;
          const scrollWidth = Math.max(root.scrollWidth, body?.scrollWidth ?? 0);
          const overflowElements = Array.from(document.querySelectorAll("body *"))
            .flatMap((element) => {
              const node = element as HTMLElement;
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                rect.width === 0 ||
                rect.height === 0 ||
                (rect.left >= -1 && rect.right <= width + 1)
              ) {
                return [];
              }
              const own = node.id
                ? `#${CSS.escape(node.id)}`
                : node.classList.length
                  ? `${node.tagName.toLowerCase()}.${Array.from(node.classList)
                      .slice(0, 3)
                      .map((name) => CSS.escape(name))
                      .join(".")}`
                  : node.tagName.toLowerCase();
              return [
                {
                  selector: own,
                  left: Math.round(rect.left * 100) / 100,
                  right: Math.round(rect.right * 100) / 100,
                  width: Math.round(rect.width * 100) / 100,
                  text: (node.innerText || node.getAttribute("aria-label") || "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 120),
                },
              ];
            })
            .slice(0, 20);
          return {
            overflowPixels: Math.max(0, scrollWidth - width),
            overflowElements,
          };
        });

        const screenshot = await page.screenshot({
          animations: "disabled",
          fullPage: false,
          path: outputFile,
          quality: 90,
          type: "jpeg",
        });
        const dimensions = jpegDimensions(screenshot);
        const browserIssues = [...activeBrowserIssues];
        activeBrowserIssues = null;
        const actualUrl = routeFromUrl(page.url());
        const record: CaptureRecord = {
          screen: screen.slug,
          routeTemplate: screen.routeTemplate,
          requestedPath: screen.path,
          actualUrl,
          expectedRedirect: screen.expectedRedirect ?? null,
          file: relativeFile,
          heading,
          dimensions,
          overflowPixels: layout.overflowPixels,
          overflowElements: layout.overflowElements,
          overlayCount,
          browserIssues,
          navigationError,
          viewport,
        };
        records.push(record);

        const captureLabel = `${screen.slug} at ${viewport.width}x${viewport.height}`;
        if (navigationError) failures.push(`${captureLabel}: ${navigationError}`);
        if (!heading) failures.push(`${captureLabel}: no visible page-level heading`);
        if (overlayCount) failures.push(`${captureLabel}: ${overlayCount} Vite overlay(s)`);
        if (layout.overflowPixels) {
          failures.push(`${captureLabel}: ${layout.overflowPixels}px page overflow`);
        }
        if (browserIssues.length) {
          failures.push(
            `${captureLabel}: browser errors: ${browserIssues.map((issue) => issue.message).join(" | ")}`,
          );
        }
        if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) {
          failures.push(
            `${captureLabel}: image is ${dimensions.width}x${dimensions.height}`,
          );
        }
        const expectedPath = screen.expectedRedirect ?? new URL(screen.path, "http://jobctrl.local").pathname;
        if (new URL(page.url()).pathname !== expectedPath) {
          failures.push(`${captureLabel}: expected pathname ${expectedPath}, got ${actualUrl}`);
        }
      }
    }

    const generatedAt = new Date().toISOString();
    const validation = {
      actualImages: records.length,
      browserErrorCaptures: records.filter((record) => record.browserIssues.length > 0).length,
      dimensionMismatches: records.filter(
        (record) =>
          record.dimensions.width !== record.viewport.width ||
          record.dimensions.height !== record.viewport.height,
      ).length,
      expectedImages: viewports.length * screens.length,
      headingFailures: records.filter((record) => !record.heading).length,
      navigationFailures: records.filter((record) => record.navigationError).length,
      overflowFailures: records.filter((record) => record.overflowPixels > 0).length,
      overlayFailures: records.filter((record) => record.overlayCount > 0).length,
      redirectMismatches: records.filter((record) => {
        const expectedPath =
          record.expectedRedirect ??
          new URL(record.requestedPath, "http://jobctrl.local").pathname;
        return new URL(record.actualUrl, "http://jobctrl.local").pathname !== expectedPath;
      }).length,
    };
    const manifest = {
      generatedAt,
      sourceArchive: originalArchive,
      baseUrl: new URL(page.url()).origin,
      scope: "Accepted JobCtrl UI assessment capture matrix against the disposable synthetic QA seed",
      note: "Synthetic QA seed identities intentionally differ from the original live screenshot records.",
      viewports,
      screens: screens.map(({ index, slug, routeTemplate, path: requestedPath, expectedRedirect }) => ({
        index,
        slug,
        routeTemplate,
        requestedPath,
        expectedRedirect: expectedRedirect ?? null,
      })),
      records,
      validation,
      failures,
    };
    const manifestFile = path.join(resolvedOutput, "manifest.json");
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const readme = `# JobCtrl UI remediation screenshot archive

Generated: ${generatedAt}

Coverage: **${screens.length} accepted screens × ${viewports.length} viewports = ${records.length} JPEG screenshots**.

The application used the disposable synthetic QA seed. Its job, artifact, and run identities intentionally differ from the original live screenshot records; route purpose and state are compared, not record names.

Import Preview and Confirm intentionally redirect to Upload when there is no import state. Each manifest record preserves both the requested path and actual URL.

## Validation

| Check | Result |
| --- | ---: |
| Images | ${validation.actualImages}/${validation.expectedImages} |
| Dimension mismatches | ${validation.dimensionMismatches} |
| Page-level overflow failures | ${validation.overflowFailures} |
| Vite overlay failures | ${validation.overlayFailures} |
| Browser-error captures | ${validation.browserErrorCaptures} |
| Missing page headings | ${validation.headingFailures} |
| Navigation failures | ${validation.navigationFailures} |
| Redirect mismatches | ${validation.redirectMismatches} |

See \`manifest.json\` for per-route evidence and \`SHA256SUMS.txt\` for archive integrity.
`;
    const readmeFile = path.join(resolvedOutput, "README.md");
    await fs.writeFile(readmeFile, readme, "utf8");

    const checksumFiles = [
      ...records.map((record) => record.file),
      "README.md",
      "manifest.json",
    ].sort((left, right) => left.localeCompare(right));
    const checksums = await Promise.all(
      checksumFiles.map(async (relativeFile) => {
        const digest = await sha256(path.join(resolvedOutput, relativeFile));
        return `${digest}  ${relativeFile}`;
      }),
    );
    await fs.writeFile(
      path.join(resolvedOutput, "SHA256SUMS.txt"),
      `${checksums.join("\n")}\n`,
      "utf8",
    );

    expect(validation.actualImages).toBe(115);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
