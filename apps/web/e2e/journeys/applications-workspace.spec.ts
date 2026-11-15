import { test, expect, json } from "../harness/fixtures.js";
import { createBaseline, createPosting, type Posting } from "./core-data.js";

test("application tasks retain edits and selection across desktop and mobile navigation", async ({
  page,
  api,
  app,
}, testInfo) => {
  await createBaseline(api);
  const first = await createPosting(api, "workspace-first");
  const second = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/workspace-second",
    title: "Synthetic Product Engineer",
    company: "Synthetic Product Company",
    description: "Develop and maintain product workflows.",
    location: "Remote",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/apply-review?jobKey=${encodeURIComponent(first.job_id)}`);
  const queue = page.getByRole("complementary", {
    name: "Application review queue",
  });
  await expect(queue.getByText("2 applications")).toBeVisible();
  await queue
    .getByRole("searchbox", { name: "Filter applications" })
    .fill("product");
  await expect(
    queue.getByRole("button", { name: /Synthetic Product Engineer/ }),
  ).toBeVisible();
  await expect(
    queue.getByRole("button", { name: /Synthetic Reliability Engineer/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Reliability Engineer",
      exact: true,
    }),
  ).toBeVisible();
  await queue.getByRole("searchbox", { name: "Filter applications" }).clear();

  await page
    .getByRole("tab", { name: "Screening answers", exact: true })
    .click();
  const attempt = page.getByRole("textbox", {
    name: "Application attempt identifier",
    exact: true,
  });
  const question = page.getByRole("textbox", {
    name: "Exact screening question",
    exact: true,
  });
  const context = page.getByRole("textbox", {
    name: "Question context and constraints",
    exact: true,
  });
  await expect(attempt).toHaveJSProperty("tagName", "INPUT");
  await attempt.fill("synthetic-attempt");
  await question.fill("What would you improve?");
  await context.fill("Keep the response concise.");
  await page
    .getByRole("tab", { name: "Application review", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Application mode", exact: true })
    .selectOption("email");
  await page
    .getByRole("textbox", { name: "Email subject", exact: true })
    .fill("Synthetic review subject");
  await page
    .getByRole("tab", { name: "Screening answers", exact: true })
    .click();
  await expect(attempt).toHaveValue("synthetic-attempt");
  await expect(question).toHaveValue("What would you improve?");
  await expect(context).toHaveValue("Keep the response concise.");
  await page
    .getByRole("tab", { name: "Application review", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Email subject", exact: true }),
  ).toHaveValue("Synthetic review subject");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("tab"))
    .toBe("application");
  await testInfo.attach("applications-desktop", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Choose an application", exact: true })
    .click();
  await queue
    .getByRole("button", { name: /Synthetic Product Engineer/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose an application", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("jobKey"))
    .toBe(second.job_id);
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Product Engineer",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Application review", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Product Engineer",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Application review", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("main")).toHaveCount(1);

  // Each task remains fully visible, readable and tappable without horizontal
  // scrolling, including at the narrowest supported viewport.
  const taskTabs = page.getByRole("tablist", {
    name: "Application review tasks",
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await taskTabs.evaluate((list) => {
      const workspace = list
        .closest(".application-review-workspace")!
        .getBoundingClientRect();
      return Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).map(
        (tab) => {
          const bounds = tab.getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(tab);
          return {
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
            width: bounds.width,
            height: bounds.height,
            fontSize: parseFloat(getComputedStyle(tab).fontSize),
            clientWidth: tab.clientWidth,
            scrollWidth: tab.scrollWidth,
            workspaceLeft: workspace.left,
            workspaceRight: workspace.right,
            textRects: Array.from(text.getClientRects(), (rect) => ({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            })),
          };
        },
      );
    });
    expect(geometry, `three task tabs at ${width}px`).toHaveLength(3);
    for (const tab of geometry) {
      expect(tab.width).toBeGreaterThanOrEqual(72);
      expect(tab.height).toBeGreaterThanOrEqual(44);
      expect(tab.fontSize).toBeGreaterThanOrEqual(14);
      expect(tab.left).toBeGreaterThanOrEqual(tab.workspaceLeft);
      expect(tab.right).toBeLessThanOrEqual(tab.workspaceRight);
      expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth);
      expect(tab.textRects.length).toBeGreaterThan(0);
      for (const rect of tab.textRects) {
        expect(rect.left).toBeGreaterThanOrEqual(tab.left - 1);
        expect(rect.right).toBeLessThanOrEqual(tab.right + 1);
        expect(rect.top).toBeGreaterThanOrEqual(tab.top - 1);
        expect(rect.bottom).toBeLessThanOrEqual(tab.bottom + 1);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("tab", { name: "Screening answers", exact: true })
    .click();
  await testInfo.attach("applications-screening-mobile", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(0);
  expect(app.external.sends).toHaveLength(0);
});
