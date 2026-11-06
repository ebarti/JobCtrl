import type { Request } from "@playwright/test";
import { test, expect, json } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";

test("Python boundary, real manual capture and one committed event connection", async ({
  page,
  api,
  app,
  playwright,
}, testInfo) => {
  const { library } = await createBaseline(api);
  const health = await json<{
    application: string;
    worker: { healthy: boolean; pid: number };
    features: string[];
  }>(api, "get", "/v1/health");
  expect(health.application).toBe("jobctrl-python");
  expect(health.worker.healthy).toBe(true);
  expect(health.worker.pid).toBe(app.workerPid);
  expect(health.features).toEqual(
    expect.arrayContaining(["profile", "jobs", "resumes"]),
  );

  const badHost = await api.get("/v1/health", {
    headers: { Host: "evil.invalid" },
  });
  expect(badHost.status()).toBe(403);
  const badOrigin = await api.post("/v1/jobs/capture", {
    headers: { Origin: "https://evil.invalid" },
    data: { title: "Must never persist", url: "https://example.com/rejected" },
  });
  expect(badOrigin.status()).toBe(403);

  const activeStreams = new Set<Request>();
  let maxStreams = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/events/stream") {
      activeStreams.add(request);
      maxStreams = Math.max(maxStreams, activeStreams.size);
    }
  });
  const completed = (request: Request) => {
    activeStreams.delete(request);
  };
  page.on("requestfinished", completed);
  page.on("requestfailed", completed);

  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/jobs/);
  await expect(page).toHaveTitle(/JobCtrl/);
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect
    .poll(() => activeStreams.size, {
      message: "one live shell event connection",
    })
    .toBe(1);

  await page.getByText("Manual capture", { exact: true }).click();
  const manual = page.getByRole("group").filter({
    has: page.getByRole("button", { name: "Save job", exact: true }),
  });
  await manual
    .getByLabel("Posting URL", { exact: true })
    .fill("https://example.com/jobs/e2e-manual");
  await manual
    .getByLabel("Job title", { exact: true })
    .fill("Synthetic Reliability Engineer");
  await manual
    .getByLabel("Company", { exact: true })
    .fill("Synthetic Example Company");
  await manual.getByLabel("Location", { exact: true }).fill("Remote");
  await manual
    .getByLabel("Posting description", { exact: true })
    .fill(
      "Maintain durable workflow services and retain clear failure evidence.",
    );
  await manual.getByRole("button", { name: "Save job", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open job", exact: true }),
  ).toBeVisible();

  // An independent HTTP writer must reach the browser through committed SSE.
  // It does not mutate the UI cache or replace the API response.
  const peer = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/e2e-peer",
    title: "Synthetic Peer Engineer",
    company: "Synthetic Peer Company",
    description: "Inspect committed changes from a second client.",
    location: "Remote",
  });
  await expect(
    page.getByText("Synthetic Peer Engineer", { exact: true }).first(),
  ).toBeVisible();
  const duplicatePayload = {
    url: "https://example.com/jobs/e2e-peer",
    title: "Synthetic Peer Engineer",
    company: "Synthetic Peer Company",
    description: "Inspect committed changes from a second client.",
    location: "Remote",
  };
  const duplicates = await Promise.all([
    json<{ job_id: string }>(api, "post", "/v1/jobs/capture", duplicatePayload),
    json<{ job_id: string }>(api, "post", "/v1/jobs/capture", duplicatePayload),
  ]);
  expect(duplicates.map((item) => item.job_id)).toEqual([
    peer.job_id,
    peer.job_id,
  ]);
  const readPaths = [
    "/v1/settings",
    "/v1/profile",
    "/v1/profile/wording",
    "/v1/profile/sources",
    "/v1/jobs",
    `/v1/jobs/${peer.job_id}`,
    `/v1/jobs/${peer.job_id}/snapshots`,
    "/v1/resumes",
    "/v1/resume-templates",
    "/v1/requirements",
    "/v1/contacts",
    "/v1/contacts/research",
    "/v1/interviews/catalog",
  ];
  const beforeHeadEvents = await json(api, "get", "/v1/events");
  const untrusted = await playwright.request.newContext({
    baseURL: app.baseURL,
  });
  try {
    for (const url of readPaths) {
      const before = await api.get(url);
      expect(before.status(), `GET ${url}`).toBe(200);
      const body = await before.json();
      const achievement = library.roles[0]!.achievements[0]!;
      const malicious =
        url === "/v1/profile"
          ? {
              expectedProfileVersion: library.profileVersion,
              profile: {
                ...baseline,
                personal: {
                  ...baseline.personal,
                  full_name: "HEAD must not save this",
                },
              },
            }
          : url === "/v1/profile/wording"
            ? {
                expectedProfileVersion: library.profileVersion,
                achievementId: achievement.achievement_id,
                text: "HEAD must not create this wording.",
                sourceRefs: achievement.source_refs,
              }
            : url === "/v1/profile/sources"
              ? {
                  expectedProfileVersion: library.profileVersion,
                  source: { text: "HEAD must not attach this source." },
                }
              : url === "/v1/contacts"
                ? {
                    employer: "HEAD must not create this contact",
                    attributes: [{ kind: "name", value: "HEAD writer" }],
                  }
                : {
                    url: "https://example.com/head-cannot-write",
                    title: "HEAD must not create this job",
                    company: "HEAD company",
                    description: "A valid body cannot turn HEAD into a write.",
                  };
      const head = await untrusted.head(url, { data: malicious });
      expect(head.status(), `HEAD ${url} must remain a read`).toBe(
        before.status(),
      );
      expect(await head.body()).toHaveLength(0);
      expect(
        await (await api.get(url)).json(),
        `HEAD ${url} changed canonical data`,
      ).toEqual(body);
    }
  } finally {
    await untrusted.dispose();
  }
  expect(await json(api, "get", "/v1/events")).toEqual(beforeHeadEvents);
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL(/\/profile/);
  await expect.poll(() => activeStreams.size).toBe(1);
  expect(maxStreams).toBe(1);
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(0);
  await testInfo.attach("real-app", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
