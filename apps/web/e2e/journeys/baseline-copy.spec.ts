import { createHash } from "node:crypto";
import { test, expect, json } from "../harness/fixtures.js";
import {
  baseline,
  createBaseline,
  createPosting,
  current,
  getResume,
  type Resume,
} from "./core-data.js";

test("approved baseline copy preserves every role, requires exact edit approval and serves historical PDF bytes with zero model calls", async ({
  page,
  api,
  app,
}, testInfo) => {
  const { library } = await createBaseline(api);
  const posting = await createPosting(api);
  await page.goto(`/jobs/${posting.job_id}`);
  await page
    .getByRole("button", { name: "Copy baseline", exact: true })
    .click();
  let resume: Resume | undefined;
  await expect
    .poll(async () => {
      const list = await json<{ resumes: Resume[] }>(
        api,
        "get",
        `/v1/resumes?jobId=${posting.job_id}`,
      );
      resume = list.resumes[0];
      return resume?.version;
    })
    .toBe(1);
  const copied = current(resume!);
  expect(copied.mode).toBe("baseline_copy");
  expect(copied.review.status).toBe("not_applicable");
  expect(copied.document.experience.map((role) => role.id)).toEqual(
    baseline.resume.experience_entries.map((role) => role.id),
  );
  expect(
    copied.document.experience.flatMap((role) =>
      role.bullets.map((bullet) => bullet.text),
    ),
  ).toEqual(baseline.resume.experience_entries.flatMap((role) => role.bullets));
  expect(copied.selected_variants.map((variant) => variant.variant_id)).toEqual(
    library.roles.flatMap((role) =>
      role.achievements.map((achievement) => achievement.baseline_variant_id),
    ),
  );

  // The explicit review endpoint must also honor off mode.
  await json(api, "post", `/v1/resumes/${resume!.resume_id}/review`, {
    expected_version: resume!.version,
  });
  await page
    .getByRole("button", { name: "Render resume", exact: true })
    .click();
  await expect
    .poll(
      async () => {
        resume = (
          await json<{ resume: Resume }>(
            api,
            "get",
            `/v1/resumes/${resume!.resume_id}`,
          )
        ).resume;
        return current(resume).renders.length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(current(resume!).renders[0]!.layout_conflicts).toEqual([]);
  await page
    .getByRole("button", { name: "Accept resume", exact: true })
    .click();
  await expect
    .poll(async () => {
      resume = (
        await json<{ resume: Resume }>(
          api,
          "get",
          `/v1/resumes/${resume!.resume_id}`,
        )
      ).resume;
      return resume.accepted_revision_id;
    })
    .toBe(copied.revision_id);

  const pdf = await api.get(
    `/v1/resumes/${resume!.resume_id}/export?format=pdf&accepted=true`,
  );
  expect(pdf.status(), await pdf.text()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  const bytes = await pdf.body();
  const firstDigest = createHash("sha256").update(bytes).digest("hex");
  const firstArtifact = current(resume!).renders.at(-1)!.artifact_id;
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.byteLength).toBeGreaterThan(1_000);
  const inspected = await app.inspectPdf(bytes);
  expect(inspected.pages).toBeGreaterThanOrEqual(1);
  expect(inspected.text).toContain(baseline.personal.full_name);
  for (const role of baseline.resume.experience_entries) {
    expect(inspected.text).toContain(role.company);
    expect(inspected.text).toContain(role.title);
    for (const text of role.bullets)
      expect(inspected.text.replace(/\s+/g, " ")).toContain(text);
  }
  await testInfo.attach("accepted-resume.pdf", {
    body: bytes,
    contentType: "application/pdf",
  });
  for (const [index, image] of inspected.images.entries()) {
    await testInfo.attach(`accepted-pdf-page-${index + 1}`, {
      body: image,
      contentType: "image/png",
    });
  }
  await testInfo.attach("accepted-pdf-digest", {
    body: firstDigest,
    contentType: "text/plain",
  });
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Export accepted PDF", exact: true }),
  ).toBeVisible();
  await testInfo.attach("accepted-baseline", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Edit the mounted Plate surface through real browser input. A saved draft
  // must not replace the accepted PDF before exact approval and a new render.
  const editedText =
    "Documented the durable workflow service and its recovery process.";
  const editor = page.getByRole("textbox", {
    name: "Resume editor",
    exact: true,
  });
  await editor
    .getByText(baseline.resume.experience_entries[0]!.bullets[0]!, {
      exact: true,
    })
    .fill(editedText);
  await page.getByRole("button", { name: "Save resume", exact: true }).click();
  await expect
    .poll(async () => {
      resume = await getResume(api, resume!.resume_id);
      return current(resume).document.experience[0]!.bullets[0]!.text;
    })
    .toBe(editedText);
  expect(current(resume!).mechanical.status).toBe("invalid");
  expect(resume!.accepted_revision_id).toBe(copied.revision_id);
  const refused = await api.post(`/v1/resumes/${resume!.resume_id}/accept`, {
    data: { expected_version: resume!.version, override_review: false },
  });
  expect(refused.status()).toBe(422);
  const retainedPdf = await api.get(
    `/v1/resumes/${resume!.resume_id}/export?format=pdf&accepted=true`,
  );
  expect(retainedPdf.status()).toBe(200);
  expect(
    createHash("sha256")
      .update(await retainedPdf.body())
      .digest("hex"),
  ).toBe(firstDigest);
  const approval = page.getByRole("region", {
    name: "Approve edited wording",
    exact: true,
  });
  await expect(approval.getByText(editedText, { exact: true })).toBeVisible();
  await approval
    .getByRole("button", { name: "Approve these exact edits", exact: true })
    .click();
  await expect
    .poll(async () => {
      resume = await getResume(api, resume!.resume_id);
      return current(resume).mechanical.status;
    })
    .toBe("valid");
  const editedRevision = resume!.current_revision;
  expect(editedRevision).not.toBe(copied.revision_id);
  await page
    .getByRole("button", { name: "Render resume", exact: true })
    .click();
  await expect
    .poll(
      async () => {
        resume = await getResume(api, resume!.resume_id);
        return current(resume).renders.length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Accept resume", exact: true })
    .click();
  await expect
    .poll(async () => {
      resume = await getResume(api, resume!.resume_id);
      return resume.accepted_revision_id;
    })
    .toBe(editedRevision);
  const editedPdf = await api.get(
    `/v1/resumes/${resume!.resume_id}/export?format=pdf&accepted=true`,
  );
  expect(editedPdf.status()).toBe(200);
  const editedBytes = await editedPdf.body();
  expect(createHash("sha256").update(editedBytes).digest("hex")).not.toBe(
    firstDigest,
  );
  expect(
    (await app.inspectPdf(editedBytes)).text.replace(/\s+/g, " "),
  ).toContain(editedText);

  // The catalog's PDF.js preview and download must select the older registered
  // artifact even after the same resume has a newer accepted file.
  await page.goto(`/artifacts/${encodeURIComponent(firstArtifact)}`);
  const preview = page.getByRole("region", {
    name: "Recorded PDF preview",
    exact: true,
  });
  const firstPage = preview.getByRole("img", {
    name: "Recorded resume PDF page 1",
    exact: true,
  });
  await expect(firstPage).toBeVisible();
  await expect
    .poll(() =>
      firstPage.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.getByText(firstDigest, { exact: true })).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download recorded PDF", exact: true })
    .click();
  const download = await downloading;
  const stream = await download.createReadStream();
  if (!stream)
    throw new Error(
      "The browser download did not expose the recorded PDF bytes",
    );
  const downloadedHash = createHash("sha256");
  for await (const chunk of stream) downloadedHash.update(chunk);
  expect(await download.failure()).toBeNull();
  expect(downloadedHash.digest("hex")).toBe(firstDigest);
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(0);
});
