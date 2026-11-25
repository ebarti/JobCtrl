import { test, expect, json } from "../harness/fixtures.js";
import { acceptBaseline, createBaseline, createPosting, getResume, type Library, type Profile } from "./core-data.js";

// The runtime archives the exact current SQLite application revision, starts its
// real HTTP server without a workflow worker, and imports into an owned database.
test.use({ sqlitePredecessor: true });

test("current SQLite workspace survives PostgreSQL import and an identical retry", async ({ api, app, page }, testInfo) => {
  const { profile, library } = await createBaseline(api);
  const achievement = library.roles[0]!.achievements[0]!;
  const text = "Documented durable workflow recovery for the service team.";
  const proposed = await json<Library>(api, "post", "/v1/profile/wording", {
    expectedProfileVersion: profile.profileVersion,
    achievementId: achievement.achievement_id,
    text,
    sourceRefs: achievement.source_refs,
  });
  const variant = proposed.variants.find((row) => row.text === text)!;
  expect(variant).toBeTruthy();
  const approved = await json<Library>(api, "post", `/v1/profile/wording/${variant.variant_id}/decision`, {
    expectedProfileVersion: proposed.profileVersion,
    expectedVariantRevision: variant.revision,
    exactText: text,
    decision: "approve",
  });
  expect(approved.variants.find((row) => row.variant_id === variant.variant_id)?.status).toBe("approved");
  const posting = await createPosting(api, "postgres-migration");
  const beforeProfile = await json<Profile>(api, "get", "/v1/profile");
  const beforeWording = await json<Library>(api, "get", "/v1/profile/wording");
  const accepted = await acceptBaseline(api, posting.job_id, beforeProfile.profileVersion);
  expect(accepted.accepted_revision_id).toBeTruthy();
  const beforeResume = await getResume(api, accepted.resume_id);
  const beforePdf = await api.get(`/v1/resumes/${accepted.resume_id}/export?format=pdf&accepted=true`);
  expect(beforePdf.status(), await beforePdf.text()).toBe(200);
  const bytes = await beforePdf.body();
  expect(bytes.length).toBeGreaterThan(0);
  const beforeJobs = await json(api, "get", "/v1/jobs/query");
  const calls = app.external.calls.length;

  const result = await app.upgradeSqliteToPostgres();
  expect(result.first.state).toBe("active");
  expect(result.first.rows).toBeGreaterThan(0);
  expect(result.repeated).toEqual(result.first);
  expect(await json(api, "get", "/v1/profile")).toEqual(beforeProfile);
  expect(await json(api, "get", "/v1/profile/wording")).toEqual(beforeWording);
  expect(await json(api, "get", "/v1/jobs/query")).toEqual(beforeJobs);
  expect(await getResume(api, accepted.resume_id)).toEqual(beforeResume);
  const afterPdf = await api.get(`/v1/resumes/${accepted.resume_id}/export?format=pdf&accepted=true`);
  expect(afterPdf.status(), await afterPdf.text()).toBe(200);
  expect(await afterPdf.body()).toEqual(bytes);
  await page.goto("/profile");
  await expect(page.getByText("Synthetic Example Company", { exact: false }).first()).toBeVisible();
  await page.goto(`/jobs/${posting.job_id}`);
  await expect(page.getByText("Synthetic Reliability Engineer", { exact: false }).first()).toBeVisible();
  expect(app.external.calls).toHaveLength(calls);
  expect(app.external.sends).toHaveLength(0);
  await testInfo.attach("sqlite-postgres-upgrade", { contentType: "application/json", body: JSON.stringify({ predecessor: "db8043d5f86389e1427d5335e3da336dc35437f6", result, acceptedRevision: accepted.accepted_revision_id, pdfBytes: bytes.length }) });
});
