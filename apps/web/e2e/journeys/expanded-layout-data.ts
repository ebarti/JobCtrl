import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";

import { expect, json } from "../harness/fixtures.js";

const widths = [1440, 390] as const;

export async function actionIdentitySnapshot(api: APIRequestContext) {
  const recorded = await json<{
    runs: { runId: string; action: string; workflowId: string }[];
    hasMore: boolean;
  }>(api, "get", "/v1/action-runs?limit=100");
  // Every case owns a fresh workspace and creates only its declared sources.
  // Refuse a truncated inventory instead of silently comparing just one page.
  expect(recorded.hasMore).toBe(false);
  return recorded.runs.map(({ runId, action, workflowId }) => ({ runId, action, workflowId }))
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

async function ready(page: Page, heading: string) {
  await expect(page).toHaveTitle(/JobCtrl/);
  await expect(page.getByRole("heading", { name: heading, level: 1, exact: true })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expect(page.locator(".main").getByText(
    /^(?:Loading(?:[ .…]|$)|Refreshing saved Profile evidence…$|Checking (?:saved|the) .*)/,
  ).filter({ visible: true })).toHaveCount(0);
  await page.evaluate(async () => { await document.fonts.ready; });
}

/** Only read disclosures are activated here. We never click a form submit,
 * action, approval or model control to obtain a visual state. Re-query after
 * each toggle because several native details lazily mount nested content. */
async function expandReadOnly(scope: Locator) {
  const opened: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    const native = scope.locator("details:not([open]) > summary:visible").first();
    const custom = scope.locator('.configuration-section__trigger[aria-expanded="false"]:visible').first();
    const trigger = await native.count() ? native : custom;
    if (!await trigger.count()) return opened;
    opened.push((await trigger.innerText()).trim());
    // These locators select the first *closed* disclosure. Retain the actual
    // DOM node while clicking: afterward the same locator refers to the next
    // closed sibling, which cannot prove that the clicked disclosure opened.
    const element = await trigger.elementHandle();
    expect(element).not.toBeNull();
    // Lazy siblings can mount between locating the element and dispatching
    // the click. Click this retained node, not the positional closed locator.
    await element!.click();
    await expect.poll(() => element!.evaluate((node) => node.tagName === "SUMMARY"
      ? (node.parentElement as HTMLDetailsElement).open
      : node.getAttribute("aria-expanded") === "true")).toBe(true);
    await element!.dispose();
  }
  throw new Error("The expanded-layout disclosure inventory exceeded its bounded scope.");
}

export async function captureExpanded(page: Page, testInfo: TestInfo, name: string, heading: string, scope = page.locator(".main")) {
  const opened: string[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await ready(page, heading);
    opened.push(...await expandReadOnly(scope));
    await ready(page, heading);
    // Lazy history reads and responsive controls can add disclosures after
    // settling or after a viewport change. Include both before recording.
    opened.push(...await expandReadOnly(scope));
    await ready(page, heading);
    await page.evaluate(() => window.scrollTo(0, 0));
    const geometry = await scope.evaluate((main) => {
      const bounds = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      const visible = (element: Element) => element.getClientRects().length > 0;
      return {
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        disclosures: Array.from(main.querySelectorAll("details")).filter(visible).map((detail) => ({
          title: detail.querySelector("summary")?.textContent?.trim(), open: detail.open, bounds: bounds(detail),
        })),
        configuration: Array.from(main.querySelectorAll(".configuration-section__trigger")).filter(visible).map((trigger) => ({
          title: trigger.textContent?.trim(), expanded: trigger.getAttribute("aria-expanded"), bounds: bounds(trigger),
        })),
        panels: Array.from(main.querySelectorAll(".card, .route-workspace, .job-workspace-section, .requirements-library__detail, .configuration-section"))
          .filter(visible).map((panel) => {
            const style = getComputedStyle(panel);
            return {
              title: panel.getAttribute("aria-label") ?? panel.querySelector("h2, h3, summary")?.textContent?.trim(),
              className: panel.className, bounds: bounds(panel),
              padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
              borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
              children: Array.from(panel.children).filter(visible).map((child) => ({ tag: child.tagName, bounds: bounds(child) })),
            };
          }),
      };
    });
    const overflow = await page.locator("body *").evaluateAll((elements) => elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!element.getClientRects().length || box.width <= 0 || style.visibility === "hidden"
          || element.scrollWidth <= element.clientWidth + 1 && box.right <= window.innerWidth + 1) return [];
      return [{
        tag: element.tagName, className: typeof element.className === "string" ? element.className : "", id: element.id,
        ownTextLength: Array.from(element.childNodes).reduce((total, node) => total + (node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : 0), 0),
        rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height },
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        minWidth: style.minWidth, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, overflowX: style.overflowX,
      }];
    }).sort((left, right) => right.rect.right - left.rect.right).slice(0, 100));
    await testInfo.attach(`${name}-${width}-overflow-diagnostics`, {
      contentType: "application/json", body: JSON.stringify({ viewport: width, documentWidth: geometry.scrollWidth, elements: overflow }),
    });
    if (geometry.scrollWidth > width) {
      await testInfo.attach(`${name}-${width}-overflow-full`, {
        contentType: "image/png", body: await page.screenshot({ fullPage: true, animations: "disabled" }),
      });
    }
    await testInfo.attach(`${name}-${width}-expanded-geometry`, {
      contentType: "application/json", body: JSON.stringify({ opened, ...geometry }),
    });
    expect(geometry.scrollWidth, `${name} expanded content at ${width}px`).toBeLessThanOrEqual(width);
    expect(geometry.disclosures.filter((item) => !item.open), `${name} closed disclosures at ${width}px`).toEqual([]);
    expect(geometry.configuration.filter((item) => item.expanded !== "true"), `${name} closed configuration at ${width}px`).toEqual([]);
    await testInfo.attach(`${name}-${width}-expanded-full`, {
      contentType: "image/png", body: await page.screenshot({ fullPage: true, animations: "disabled" }),
    });
    // A fresh normal-scale lower viewport supplements the full-page record:
    // the controls and borders below the fold must remain reviewable at 1:1.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await testInfo.attach(`${name}-${width}-expanded-lower-viewport`, {
      contentType: "image/png", body: await page.screenshot({ animations: "disabled" }),
    });
  }
}

export async function visitExpanded(page: Page, testInfo: TestInfo, name: string, path: string, heading: string, prepare?: () => Promise<void>) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(path);
  await ready(page, heading);
  await testInfo.attach(`${name}-1440-initial`, {
    contentType: "image/png", body: await page.screenshot({ animations: "disabled" }),
  });
  await prepare?.();
  await captureExpanded(page, testInfo, name, heading);
}
