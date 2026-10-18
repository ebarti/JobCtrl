import { expect, test } from "@playwright/test";

test("desktop route identity and sidebar collapse persist across reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/jobs");

  const breadcrumb = page.getByRole("navigation", { name: "breadcrumb" });
  await expect(breadcrumb).toBeVisible({ timeout: 30_000 });
  await expect(breadcrumb.locator('[data-slot="breadcrumb-item"]')).toHaveText([
    "Pipeline",
    "Jobs",
  ]);
  await expect(
    page.getByRole("heading", { level: 1, name: "Jobs" }),
  ).toBeAttached();

  const shell = page.locator(".app-shell");
  const mainNavigation = page.getByRole("navigation", {
    name: "Main navigation",
  });
  const jobsLink = mainNavigation.getByRole("link", {
    name: "Jobs",
    exact: true,
  });
  const jobsLabel = jobsLink.locator(".side-rail__label");
  const toggle = page.getByTitle("Collapse or expand navigation");

  await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  await expect(toggle).toBeVisible();
  await expect(jobsLink).toBeVisible();
  await expect(jobsLabel).toBeVisible();

  await toggle.click();
  await expect(shell).toHaveAttribute("data-sidebar-open", "false");
  await expect(jobsLink).toBeVisible();
  await expect(jobsLabel).toBeHidden();
  await expect(
    mainNavigation.locator(".side-rail__group-label").first(),
  ).toBeHidden();

  await page.reload();
  await expect(shell).toHaveAttribute("data-sidebar-open", "false");
  await expect(jobsLink).toBeVisible();
  await expect(jobsLabel).toBeHidden();

  await toggle.click();
  await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  await expect(jobsLabel).toBeVisible();
  await expect(
    mainNavigation.locator(".side-rail__group-label").first(),
  ).toBeVisible();
});

test("mobile keeps the navigation sheet trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs");

  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  await expect(openNavigation).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTitle("Collapse or expand navigation")).toBeHidden();

  await page.keyboard.press("Control+b");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await openNavigation.click();
  const navigationSheet = page.getByRole("dialog");
  await expect(navigationSheet).toBeVisible();
  await expect(
    navigationSheet.getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(
    navigationSheet.getByRole("link", { name: "Apply review", exact: true }),
  ).toBeVisible();
});

// These reads use the owned synthetic fixture API/dispatcher configured by the
// existing Playwright harness. Faults affect GET transport only; no fixture or
// user workspace is mutated by this coverage.
const loaderRoutes = [
  {
    entry: "/dashboard",
    heading: "Dashboard",
    reads: [
      "/v1/dashboard/summary",
      "/v1/outcomes",
      "/v1/digest",
      "/v1/workflow-runs",
    ],
  },
  {
    entry: "/profile",
    heading: "Profile",
    reads: ["/v1/profile", "/v1/settings"],
  },
  {
    entry: "/preferences",
    heading: "Preferences",
    reads: ["/v1/profile", "/v1/settings"],
  },
  { entry: "/discovery", heading: "Discovery", reads: ["/v1/profile"] },
  {
    entry: "/debug?q=workflow&page=1",
    heading: "Debug",
    reads: ["/v1/debug/activity"],
  },
  {
    entry: "/apply-review",
    heading: "Application review",
    reads: ["/v1/apply/review-queue"],
  },
  {
    entry: "/analytics?dimension=fit_band",
    heading: "Outcome analytics",
    reads: ["/v1/analytics/outcomes"],
  },
  {
    entry: "/artifacts?q=resume",
    heading: "Artifacts",
    reads: ["/v1/artifacts"],
  },
  {
    entry: "/outreach?employer=Acme",
    heading: "Contacts",
    reads: ["/v1/contacts"],
  },
  {
    entry: "/runs?status=all",
    heading: "Workflow runs",
    reads: ["/v1/workflow-runs"],
  },
  {
    entry: "/evidence-map",
    heading: "Career evidence map",
    reads: ["/v1/evidence-map"],
  },
];

for (const scenario of loaderRoutes) {
  test(`loader navigation, reload and Back preserve reads: ${scenario.entry}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const requests: {
      path: string;
      search: string;
      method: string;
      status: number;
    }[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/v1/"))
        requests.push({
          path: url.pathname,
          search: url.search,
          method: response.request().method(),
          status: response.status(),
        });
    });
    await page.goto(scenario.entry);
    const heading = page.getByRole("heading", {
      level: 1,
      name: scenario.heading,
      exact: true,
    });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const initialUrl = page.url();
    for (const path of scenario.reads)
      await expect
        .poll(() =>
          requests.some(
            (r) => r.path === path && r.method === "GET" && r.status === 200,
          ),
        )
        .toBe(true);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Jobs", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Jobs", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(heading).toBeVisible();
    await expect(page).toHaveURL(initialUrl);
    const beforeReload = requests.length;
    await page.reload();
    await expect(heading).toBeVisible();
    await expect(page).toHaveURL(initialUrl);
    for (const path of scenario.reads)
      await expect
        .poll(() =>
          requests
            .slice(beforeReload)
            .some(
              (r) => r.path === path && r.method === "GET" && r.status === 200,
            ),
        )
        .toBe(true);
    await testInfo.attach("passive-read-requests", {
      body: JSON.stringify(requests, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("reloaded-route", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });

  test(`failed loader read renders and recovers: ${scenario.entry}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const marker = "Synthetic loader read unavailable";
    const path = scenario.reads[0]!;
    let failures = 0;
    await page.route(
      (url) => url.pathname === path,
      async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        failures++;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, message: marker }),
        });
      },
    );
    await page.goto(scenario.entry);
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(failures).toBeGreaterThan(0);
    await testInfo.attach("failed-read", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.unrouteAll({ behavior: "wait" });
    const recovered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await page.reload();
    await recovered;
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: scenario.heading,
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(marker, { exact: false })).toHaveCount(0);
    await testInfo.attach("read-recovery", {
      body: JSON.stringify({
        entry: scenario.entry,
        path,
        failures,
        recoveredStatus: 200,
      }),
      contentType: "application/json",
    });
  });
}

test("Activity ensure read propagates a failure and reload recovers the same event", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const activity = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/debug/activity" &&
      response.status() === 200,
  );
  await page.goto("/debug");
  const payload = (await (await activity).json()) as {
    items: { eventId: string; message: string }[];
  };
  const event = payload.items[0];
  expect(event).toBeDefined();
  const path = `/v1/debug/activity/${encodeURIComponent(event!.eventId)}`;
  const entry = `/activity/${encodeURIComponent(event!.eventId)}`;
  let failures = 0;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      failures++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          message: "Synthetic activity read unavailable",
        }),
      });
    },
  );
  await page.goto(entry);
  await expect(
    page.getByText("Something went wrong!", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect(failures).toBeGreaterThan(0);
  await testInfo.attach("activity-loader-error", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.unrouteAll({ behavior: "wait" });
  const recovered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.status() === 200,
  );
  await page.reload();
  await recovered;
  const heading = page.getByRole("heading", {
    level: 1,
    name: event!.message,
    exact: true,
  });
  await expect(heading).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Jobs", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Jobs", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(heading).toBeVisible();
  await testInfo.attach("activity-read-recovery", {
    body: JSON.stringify({ entry, path, failures, eventId: event!.eventId }),
    contentType: "application/json",
  });
});
