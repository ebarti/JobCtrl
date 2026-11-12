import { test, expect, json, modelCall } from "../harness/fixtures.js";
import { acceptBaseline, type Library, type Profile } from "./core-data.js";
import { createScoredFit, groupedCoverageDecision } from "./fit-data.js";

const viewports = [
  { width: 1440, height: 1000 },
  { width: 1860, height: 1227 },
  { width: 2943, height: 1227 },
  { width: 390, height: 844 },
];
const activeSections: Record<string, readonly [string, string]> = {
  "search-preferences": ["My profile sections", "Search preferences"],
  "profile-resume": ["My profile sections", "Resume"],
  "settings-data": ["Settings sections", "Data & diagnostics"],
  materials: ["Jobs sections", "Materials"],
};

test("Original redesign renders all twenty-six primary workspace surfaces at normal, desktop, wide and mobile widths", async ({
  page,
  api,
  app,
}, testInfo) => {
  const seed = await createScoredFit(api, app, "redesign-surface-inventory", {
    twoRequirements: true,
    sameAchievement: true,
  });
  const achievement = seed.library.roles[0]!.achievements[0]!;
  const coverageRequest = api.post(
    `/v1/jobs/${seed.posting.job_id}/fit/coverage/refresh`,
    { data: { prepare_wording: false } },
  );
  const coverage = await modelCall(app, "fit.wording-coverage-grouped");
  coverage.reply(
    groupedCoverageDecision(coverage, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`,
      status: "covered",
      action: "reuse_approved",
      reusableVariantId: achievement.baseline_variant_id,
    }),
  );
  expect((await coverageRequest).status()).toBe(200);
  await json<Library>(api, "post", "/v1/profile/wording", {
    expectedProfileVersion: seed.library.profileVersion,
    achievementId: achievement.achievement_id,
    sourceRefs: achievement.source_refs,
    text: "Implemented durable workflow recovery with a retained operational review record.",
  });
  const currentProfile = await json<Profile>(api, "get", "/v1/profile");
  const resume = await acceptBaseline(
    api,
    seed.posting.job_id,
    currentProfile.profileVersion,
  );
  const job = `/jobs/${seed.posting.job_id}`;
  const routes: {
    name: string;
    path: string;
    heading: string;
    workspace: "Jobs" | "My profile" | "Settings";
  }[] = [
    { name: "jobs", path: "/jobs", heading: "Jobs", workspace: "Jobs" },
    {
      name: "job-fit",
      path: `${job}?jobTab=fit`,
      heading: "Synthetic Reliability Engineer",
      workspace: "Jobs",
    },
    {
      name: "job-resume",
      path: `${job}?jobTab=resume`,
      heading: "Synthetic Reliability Engineer",
      workspace: "Jobs",
    },
    {
      name: "job-application",
      path: `${job}?jobTab=application`,
      heading: "Synthetic Reliability Engineer",
      workspace: "Jobs",
    },
    {
      name: "job-people",
      path: `${job}?jobTab=people`,
      heading: "Synthetic Reliability Engineer",
      workspace: "Jobs",
    },
    {
      name: "job-offer",
      path: `${job}?jobTab=offer`,
      heading: "Synthetic Reliability Engineer",
      workspace: "Jobs",
    },
    {
      name: "requirements",
      path: "/requirements",
      heading: "Requirements library",
      workspace: "Jobs",
    },
    {
      name: "profile-experience",
      path: "/profile?section=experience",
      heading: "Experience",
      workspace: "My profile",
    },
    {
      name: "profile-skills",
      path: "/profile?section=skills",
      heading: "Skills",
      workspace: "My profile",
    },
    {
      name: "profile-education",
      path: "/profile?section=education",
      heading: "Education",
      workspace: "My profile",
    },
    {
      name: "profile-personal",
      path: "/profile?section=personal",
      heading: "Personal details",
      workspace: "My profile",
    },
    {
      name: "profile-resume",
      path: "/profile?section=resume",
      heading: "Resume",
      workspace: "My profile",
    },
    {
      name: "search-preferences",
      path: "/preferences",
      heading: "Search preferences",
      workspace: "My profile",
    },
    {
      name: "search-for-jobs",
      path: "/discovery",
      heading: "Search for jobs",
      workspace: "Jobs",
    },
    {
      name: "learning",
      path: "/learning",
      heading: "Learning",
      workspace: "My profile",
    },
    {
      name: "settings-connections",
      path: "/settings",
      heading: "Settings",
      workspace: "Settings",
    },
    {
      name: "settings-budgets",
      path: "/settings/budgets",
      heading: "Settings",
      workspace: "Settings",
    },
    {
      name: "settings-automation",
      path: "/settings/automation",
      heading: "Settings",
      workspace: "Settings",
    },
    {
      name: "settings-appearance",
      path: "/settings/appearance",
      heading: "Settings",
      workspace: "Settings",
    },
    {
      name: "settings-data",
      path: "/settings/data",
      heading: "Settings",
      workspace: "Settings",
    },
    {
      name: "applications",
      path: "/apply-review",
      heading: "Applications",
      workspace: "Jobs",
    },
    {
      name: "outcomes",
      path: "/analytics",
      heading: "Outcome analytics",
      workspace: "Jobs",
    },
    {
      name: "interviews",
      path: "/interviews",
      heading: "Interviews",
      workspace: "Jobs",
    },
    {
      name: "contacts",
      path: "/outreach",
      heading: "Contacts",
      workspace: "Jobs",
    },
    {
      name: "materials",
      path: "/artifacts",
      heading: "Materials",
      workspace: "Jobs",
    },
    {
      name: "dashboard",
      path: "/dashboard",
      heading: "Dashboard",
      workspace: "Jobs",
    },
  ];
  const afterAuthoredSetup = app.external.calls.length;
  const materialControlGeometry = async (state: string, width: number) => {
    const geometry = await page
      .getByRole("form", { name: "Material filters", exact: true })
      .evaluate((form) => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        const bounds = (element: Element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
          };
        };
        return {
          form: bounds(form),
          controls: Array.from(
            form.querySelectorAll<HTMLElement>("input, select, button"),
          ).map((element) => {
            const style = getComputedStyle(element);
            context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const displayedText =
              element instanceof HTMLInputElement
                ? element.placeholder
                : element instanceof HTMLSelectElement
                  ? element.selectedOptions[0]!.text
                  : "";
            const range = document.createRange();
            range.selectNodeContents(element);
            return {
              tag: element.tagName,
              text: element.textContent?.trim(),
              box: bounds(element),
              minimumReadableWidth: displayedText
                ? context.measureText(displayedText).width +
                  Number.parseFloat(style.paddingLeft) +
                  Number.parseFloat(style.paddingRight) +
                  Number.parseFloat(style.borderLeftWidth) +
                  Number.parseFloat(style.borderRightWidth)
                : 0,
              textBoxes:
                element instanceof HTMLButtonElement
                  ? Array.from(range.getClientRects()).map((box) => ({
                      left: box.left,
                      right: box.right,
                      top: box.top,
                      bottom: box.bottom,
                    }))
                  : [],
            };
          }),
        };
      });
    expect(geometry.controls.length).toBeGreaterThanOrEqual(3);
    for (const [index, control] of geometry.controls.entries()) {
      expect(control.box.width).toBeGreaterThanOrEqual(
        control.minimumReadableWidth - 1,
      );
      expect(control.box.left).toBeGreaterThanOrEqual(geometry.form.left - 1);
      expect(control.box.right).toBeLessThanOrEqual(geometry.form.right + 1);
      for (const text of control.textBoxes) {
        expect(text.left).toBeGreaterThanOrEqual(control.box.left - 1);
        expect(text.right).toBeLessThanOrEqual(control.box.right + 1);
        expect(text.top).toBeGreaterThanOrEqual(control.box.top - 1);
        expect(text.bottom).toBeLessThanOrEqual(control.box.bottom + 1);
      }
      for (const other of geometry.controls.slice(index + 1))
        expect(
          Math.min(control.box.right, other.box.right) <=
            Math.max(control.box.left, other.box.left) ||
            Math.min(control.box.bottom, other.box.bottom) <=
              Math.max(control.box.top, other.box.top),
          "Material filter controls must not overlap",
        ).toBe(true);
    }
    await testInfo.attach(`material-controls-${width}-${state}`, {
      contentType: "application/json",
      body: JSON.stringify(geometry),
    });
  };
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const [index, route] of routes.entries()) {
      await page.goto(route.path);
      await expect(page).toHaveTitle(/JobCtrl/);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: route.heading,
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      if (route.name === "jobs")
        await expect(
          page
            .getByRole("table", { name: "Jobs table", exact: true })
            .locator("tbody tr"),
        ).toHaveCount(1);
      if (route.name === "job-fit")
        await expect(
          page.getByText("Score 10/10", { exact: true }),
        ).toBeVisible();
      if (route.name === "job-resume")
        await expect(
          page.getByRole("textbox", { name: "Resume editor", exact: true }),
        ).toContainText(currentProfile.profile.personal.full_name);
      if (route.name === "requirements")
        await expect(
          page.getByRole("button", { name: "Link achievement", exact: true }),
        ).toBeEnabled();
      if (route.name === "profile-experience")
        await expect(
          page
            .getByRole("article", { name: "Current wording", exact: true })
            .first(),
        ).toBeVisible();
      if (route.name === "profile-experience") {
        const roles = await page
          .locator(".profile-career-role")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const box = element.getBoundingClientRect();
              return {
                x: box.x,
                y: box.y,
                right: box.right,
                bottom: box.bottom,
                children: Array.from(element.children).map((child) => {
                  const line = child.getBoundingClientRect();
                  return {
                    x: line.x,
                    y: line.y,
                    right: line.right,
                    bottom: line.bottom,
                  };
                }),
              };
            }),
          );
        expect(roles).toHaveLength(2);
        for (const [index, role] of roles.entries()) {
          for (const line of role.children) {
            expect(line.x).toBeGreaterThanOrEqual(role.x - 1);
            expect(line.right).toBeLessThanOrEqual(role.right + 1);
            expect(line.y).toBeGreaterThanOrEqual(role.y - 1);
            expect(line.bottom).toBeLessThanOrEqual(role.bottom + 1);
          }
          for (const other of roles.slice(index + 1))
            expect(
              Math.min(role.right, other.right) <= Math.max(role.x, other.x) ||
                Math.min(role.bottom, other.bottom) <=
                  Math.max(role.y, other.y),
              "Career role buttons must not overlap",
            ).toBe(true);
        }
        await testInfo.attach(`career-role-geometry-${viewport.width}`, {
          contentType: "application/json",
          body: JSON.stringify(roles),
        });
      }
      if (route.name === "profile-skills")
        await expect(
          page.getByRole("textbox", { name: "Skill group title", exact: true }),
        ).toHaveValue("Engineering");
      if (route.name === "profile-education")
        await expect(
          page.getByRole("textbox", { name: "Degree", exact: true }),
        ).toHaveValue("Synthetic Engineering Degree");
      if (route.name === "profile-personal")
        await expect(
          page.getByRole("textbox", { name: "Full name", exact: true }),
        ).toHaveValue(currentProfile.profile.personal.full_name);
      if (route.name === "profile-resume")
        await expect(
          page.getByRole("textbox", {
            name: "Baseline resume editor editor",
            exact: true,
          }),
        ).toContainText(currentProfile.profile.personal.full_name);
      if (
        route.name === "search-preferences" ||
        route.name === "search-for-jobs"
      )
        await expect(
          page.getByRole("textbox", { name: "Target roles 1", exact: true }),
        ).toBeEnabled();
      if (route.name === "settings-connections")
        await expect(
          page.getByRole("button", { name: "Check connections", exact: true }),
        ).toBeEnabled();
      if (route.name === "settings-budgets")
        await expect(
          page.getByRole("spinbutton", {
            name: "Daily LLM budget (USD)",
            exact: true,
          }),
        ).toBeEnabled();
      if (route.name === "settings-automation") {
        await page
          .locator("summary")
          .filter({ hasText: /^Runtime and provider limits$/ })
          .click();
        await expect(
          page.getByRole("spinbutton", {
            name: "Worker activity slots",
            exact: true,
          }),
        ).toBeEnabled();
      }
      if (route.name === "settings-appearance")
        await expect(
          page.getByRole("combobox", { name: "Color scheme", exact: true }),
        ).toBeEnabled();
      if (route.name === "job-application") {
        await expect(
          page.getByText("No reviewed outcomes yet.", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("No pending outcome suggestions.", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("region", { name: "Application review", exact: true }),
        ).toBeVisible();
      }
      if (route.name === "job-people") {
        await expect(
          page.getByText("No contacts linked to this job yet.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByText("No interview prep generated.", { exact: true }),
        ).toBeVisible();
      }
      if (route.name === "job-offer")
        await expect(
          page.getByText("No actual offer terms recorded.", { exact: true }),
        ).toBeVisible();
      if (route.name === "applications")
        await expect(
          page.getByRole("textbox", { name: "Resume editor", exact: true }),
        ).toContainText(currentProfile.profile.personal.full_name);
      await expect(
        page
          .locator("main")
          .getByText(
            /^(?:Loading(?:[ .…]|$)|Refreshing saved Profile evidence…$|Checking (?:saved|the) .*)/,
          )
          .filter({ visible: true }),
      ).toHaveCount(0);
      await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      if (route.name === "materials")
        await materialControlGeometry("all", viewport.width);
      const activeSection = activeSections[route.name];
      if (activeSection) {
        const navigation = page.getByRole("navigation", {
          name: activeSection[0],
          exact: true,
        });
        const active = navigation.getByRole("link", {
          name: activeSection[1],
          exact: true,
        });
        await expect(active).toHaveAttribute("aria-current", "page");
        const geometry = await navigation.evaluate((element) => {
          const selected = element.querySelector('a[aria-current="page"]')!;
          const strip = element.getBoundingClientRect();
          const tab = selected.getBoundingClientRect();
          return {
            left: strip.left,
            right: strip.left + element.clientWidth,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            scrollLeft: element.scrollLeft,
            activeLeft: tab.left,
            activeRight: tab.right,
            pageScrollTop: window.scrollY,
          };
        });
        expect(geometry.activeLeft).toBeGreaterThanOrEqual(geometry.left - 1);
        expect(geometry.activeRight).toBeLessThanOrEqual(geometry.right + 1);
        expect(geometry.pageScrollTop).toBe(0);
        if (viewport.width === 390)
          expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
        await testInfo.attach(`active-tab-${route.name}-${viewport.width}`, {
          contentType: "application/json",
          body: JSON.stringify(geometry),
        });
      }
      if (route.name === "settings-data") {
        const diagnostics = page.getByRole("region", {
          name: "Workspace and diagnostics",
          exact: true,
        });
        for (const [label, path] of [
          ["Dashboard", "/dashboard"],
          ["Accepted materials", "/artifacts"],
          ["Career evidence", "/evidence-map"],
          ["Preparation", "/pipelines"],
          ["Task history", "/runs"],
          ["Recorded events", "/debug"],
        ] as const) {
          const link = diagnostics.getByRole("link", {
            name: label,
            exact: true,
          });
          await expect(link).toBeVisible();
          await expect(link).toHaveAttribute("href", path);
          expect(
            await link.evaluate(
              (element) => getComputedStyle(element).textDecorationLine,
            ),
          ).toContain("underline");
        }
      }
      if (route.name === "dashboard") {
        const captured = page.getByRole("region", {
          name: "Captured jobs",
          exact: true,
        });
        await expect(captured).toContainText("1 saved postings");
        const padding = await captured.evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ].map(Number.parseFloat);
        });
        for (const side of padding) expect(side).toBeGreaterThan(0);
        for (const label of ["Synthetic Reliability Engineer", "Open jobs"]) {
          const link = captured.getByRole("link", { name: label, exact: true });
          await expect(link).toBeVisible();
          expect(
            await link.evaluate(
              (element) => getComputedStyle(element).textDecorationLine,
            ),
          ).toContain("underline");
        }
      }
      const width = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      if (width > viewport.width)
        await testInfo.attach(`overflow-${route.name}-${viewport.width}`, {
          contentType: "application/json",
          body: JSON.stringify(
            await page.locator("body *").evaluateAll((elements) =>
              elements.flatMap((element) => {
                const box = element.getBoundingClientRect();
                return box.right > window.innerWidth + 1 && box.width > 0
                  ? [
                      {
                        tag: element.tagName,
                        id: element.id,
                        className: element.className,
                        x: box.x,
                        width: box.width,
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                      },
                    ]
                  : [];
              }),
            ),
          ),
        });
      expect(
        width,
        `${route.name} must fit the ${viewport.width}px viewport`,
      ).toBeLessThanOrEqual(viewport.width);
      if (viewport.width >= 1440)
        await expect(
          page
            .getByRole("navigation", { name: "Main navigation", exact: true })
            .getByRole("link", { name: route.workspace, exact: true }),
        ).toHaveAttribute("aria-current", "page");
      const name = `${String(index + 1).padStart(2, "0")}-${route.name}-${viewport.width}x${viewport.height}`;
      const screenshotPath = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(name, {
        contentType: "image/png",
        path: screenshotPath,
      });
      if (
        ["profile-experience", "requirements"].includes(route.name) &&
        [1440, 2943, 390].includes(viewport.width)
      ) {
        const fullPath = testInfo.outputPath(`${name}-full-height.png`);
        await page.screenshot({ path: fullPath, fullPage: true });
        await testInfo.attach(`${name}-full-height`, {
          contentType: "image/png",
          path: fullPath,
        });
      }
      if (
        route.name === "profile-experience" &&
        [1440, 2943, 390].includes(viewport.width)
      ) {
        const rolesPath = testInfo.outputPath(`${name}-roles-and-wording.png`);
        await page
          .locator(".profile-experience-workspace")
          .screenshot({ path: rolesPath });
        await testInfo.attach(`${name}-roles-and-wording`, {
          contentType: "image/png",
          path: rolesPath,
        });
      }
      if (
        route.name === "settings-data" &&
        [1440, 390].includes(viewport.width)
      ) {
        await page
          .getByRole("region", {
            name: "Workspace and diagnostics",
            exact: true,
          })
          .getByRole("link", { name: "Dashboard", exact: true })
          .click();
        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(
          page.getByRole("heading", {
            name: "Dashboard",
            level: 1,
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("region", { name: "Captured jobs", exact: true }),
        ).toContainText("Synthetic Reliability Engineer");
      }
      if (route.name === "materials" && viewport.width === 390) {
        const filters = page.getByRole("form", {
          name: "Material filters",
          exact: true,
        });
        const search = filters.getByRole("textbox", {
          name: "Search saved materials",
          exact: true,
        });
        const artifact = page.getByRole("link", {
          name: "Synthetic Reliability Engineer",
          exact: true,
        });
        await expect(artifact).toHaveCount(1);
        await search.fill("Reliability");
        await filters
          .getByRole("button", { name: "Search", exact: true })
          .click();
        await expect(page).toHaveURL(
          (url) => url.searchParams.get("q") === "Reliability",
        );
        await expect(artifact).toHaveCount(1);
        await expect(
          filters.getByRole("button", { name: "Clear search", exact: true }),
        ).toBeVisible();
        await materialControlGeometry("search-and-clear", viewport.width);
        const searchedPath = testInfo.outputPath(`${name}-search-results.png`);
        await page.screenshot({ path: searchedPath });
        await testInfo.attach(`${name}-search-results`, {
          contentType: "image/png",
          path: searchedPath,
        });
        await search.fill("no-synthetic-artifact-matches-this-literal");
        await filters
          .getByRole("button", { name: "Search", exact: true })
          .click();
        await expect(
          page.getByText("No recorded PDF files match these filters.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(artifact).toHaveCount(0);
        await filters
          .getByRole("button", { name: "Clear search", exact: true })
          .click();
        await expect(search).toHaveValue("");
        await expect(page).toHaveURL((url) => url.searchParams.get("q") === "");
        await expect(artifact).toHaveCount(1);
        const recordedState = filters.getByRole("combobox", {
          name: "Recorded state",
          exact: true,
        });
        await recordedState.selectOption("candidate");
        await expect(page).toHaveURL(
          (url) => url.searchParams.get("status") === "candidate",
        );
        await expect(artifact).toHaveCount(0);
        await expect(
          page.getByText("No recorded PDF files match these filters.", {
            exact: true,
          }),
        ).toBeVisible();
        await recordedState.selectOption("accepted");
        await expect(recordedState).toHaveValue("accepted");
        await expect(artifact).toHaveCount(1);
        await expect(
          page
            .getByRole("list", { name: "Materials", exact: true })
            .getByText("Accepted", { exact: true }),
        ).toBeVisible();
        await recordedState.selectOption("all");
        await expect(artifact).toHaveCount(1);
      }
    }
  }
  expect(
    app.external.calls
      .slice(afterAuthoredSetup)
      .filter((call) => call.path === "/model"),
  ).toEqual([]);
  const preserved = await api.get(
    `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
  );
  expect(preserved.status()).toBe(200);
});
