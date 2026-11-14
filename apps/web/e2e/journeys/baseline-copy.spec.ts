import { createHash } from "node:crypto";
import type { Route } from "@playwright/test";
import { test, expect, json, completed } from "../harness/fixtures.js";
import {
  baseline,
  createBaseline,
  createPosting,
  current,
  getResume,
  type Profile,
  type Resume,
} from "./core-data.js";

test("approved baseline copy preserves every role, requires exact edit approval and serves historical PDF bytes with zero model calls", async ({
  page,
  api,
  app,
}, testInfo) => {
  const languages = [{ id: "english", language: "English", proficiency: "Professional working proficiency" }, { id: "catalan", language: "Catalan", proficiency: "Native proficiency" }];
  const { library } = await createBaseline(api, { ...baseline, resume: { ...baseline.resume, language_entries: languages } });
  const posting = await createPosting(api);
  await page.goto(`/jobs/${posting.job_id}`);
  await page
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("baseline");
  const admission = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/actions/preparation.run" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Prepare resume", exact: true })
    .click();
  const admitted = await admission;
  expect(admitted.status()).toBe(202);
  expect(admitted.request().postDataJSON()).toMatchObject({
    recipe: "prepare",
    scope: "selected",
    job_ids: [posting.job_id],
    limit: 1,
    resume_mode: "baseline",
  });
  const preparation = (await admitted.json()) as { runId: string };
  await completed(api, preparation.runId);
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
    .toBe(2);
  await expect(
    page.getByRole("tab", { name: "Resume", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const copied = current(resume!);
  expect(copied.mode).toBe("baseline_copy");
  expect(copied.document.languages).toEqual(languages);
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
  for (const language of languages) {
    expect(inspected.text).toContain(language.language);
    expect(inspected.text).toContain(language.proficiency);
  }
  for (const format of ["txt", "html", "docx"] as const) {
    const exported = await api.get(`/v1/resumes/${resume!.resume_id}/export?format=${format}&accepted=true`);
    expect(exported.status(), await exported.text()).toBe(200);
    const text = format === "docx" ? await app.inspectDocx(await exported.body()) : await exported.text();
    for (const language of languages) {
      expect(text).toContain(language.language);
      expect(text).toContain(language.proficiency);
    }
  }
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
  for (const language of languages) await expect(editor).toContainText(language.proficiency);
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
  expect(current(resume!).document.languages).toEqual(languages);
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
    .locator("summary:visible")
    .filter({ hasText: /^Document validation and recovery tools$/ })
    .click();
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
  // Applications uses the same one-step preparation contract and selects the
  // exact produced document while retaining the earlier accepted export.
  const profileForApplication = await json<Profile>(api, "get", "/v1/profile");
  const applicationName = "Synthetic Application Resume Candidate";
  await json<Profile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: profileForApplication.profileVersion,
    profile: {
      ...profileForApplication.profile,
      personal: {
        ...profileForApplication.profile.personal,
        full_name: applicationName,
      },
    },
  });
  await page.goto(`/apply-review?jobKey=${encodeURIComponent(posting.job_id)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("baseline");
  // Delay only delivery of the real terminal run-list response. The actual
  // Python workflow, database, renderer and browser editor remain in use.
  let applicationRunId: string | null = null;
  let completionHeld = false;
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const preparationListUrl = new URL("/v1/preparation/runs", app.baseURL);
  const matchesPreparationList = (url: URL) => url.href === preparationListUrl.href;
  const forwardingPreparationReads: Promise<void>[] = [];
  const forwardPreparationList = async (route: Route) => {
    const response = await route.fetch();
    try {
      const listed = (await response.json()) as { runs: { runId: string; status: string }[] };
      if (applicationRunId && listed.runs.some((run) => run.runId === applicationRunId && run.status === "succeeded")) {
        completionHeld = true;
        await completionGate;
      }
      await route.fulfill({ response });
    } finally {
      await response.dispose();
    }
  };
  const delayPreparationList = async (route: Route) => {
    const forwarding = forwardPreparationList(route);
    forwardingPreparationReads.push(forwarding);
    await forwarding;
  };
  await page.route(matchesPreparationList, delayPreparationList);
  const applicationEditor = page.getByRole("textbox", {
    name: "Resume editor",
    exact: true,
  });
  try {
    const applicationAdmission = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/actions/preparation.run" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Prepare resume", exact: true })
      .click();
    const applicationResponse = await applicationAdmission;
    expect(applicationResponse.status()).toBe(202);
    expect(applicationResponse.request().postDataJSON()).toMatchObject({
      recipe: "prepare",
      scope: "selected",
      job_ids: [posting.job_id],
      resume_mode: "baseline",
    });
    applicationRunId = ((await applicationResponse.json()) as { runId: string }).runId;
    await completed(api, applicationRunId);
    await expect.poll(() => completionHeld).toBe(true);
    await expect(applicationEditor).toContainText(applicationName);
    resume = await getResume(api, resume!.resume_id);
    expect(current(resume).document.personal.full_name).toBe(applicationName);
    expect(current(resume).document.experience.map((role) => role.id)).toEqual(
      baseline.resume.experience_entries.map((role) => role.id),
    );
    expect(resume.accepted_revision_id).toBe(editedRevision);
    const unchangedAccepted = await api.get(
      `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
    );
    expect(unchangedAccepted.status()).toBe(200);
    expect(
      createHash("sha256")
        .update(await unchangedAccepted.body())
        .digest("hex"),
    ).toBe(createHash("sha256").update(editedBytes).digest("hex"));
    await testInfo.attach("applications-prepared-baseline-mobile", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await applicationEditor.getByText(applicationName, { exact: true }).click();
    await page.keyboard.press("End");
    await expect(applicationEditor).toBeFocused();
    releaseCompletion();
    await expect(page.getByText("Preparation ready for review.", { exact: true })).toBeVisible();
    await expect(applicationEditor).toBeFocused();
    await page.keyboard.insertText(" — retained application draft");
    await expect(applicationEditor).toContainText("— retained application draft");
    await expect(page.getByLabel("Editable baseline resume page", { exact: true })).toHaveAttribute("data-draft-dirty", "true");
    await expect(page.getByRole("button", { name: "Save resume", exact: true })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Prepare resume", exact: true }),
    ).toBeDisabled();
    await testInfo.attach("preparation-completion-preserves-plate-focus", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    // Deliberate Review navigation remains a focus-moving user action.
    await page.getByRole("button", { name: "Review unsaved edits", exact: true }).click();
    await expect(page.getByRole("region", { name: "Application resume workspace", exact: true })).toBeFocused();
  } finally {
    releaseCompletion();
    await page.unroute(matchesPreparationList, delayPreparationList);
    await Promise.all(forwardingPreparationReads);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "Jobs", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Jobs sections", exact: true })
    .getByRole("link", { name: "Applications", exact: true })
    .click();
  await expect(applicationEditor).toContainText("retained application draft");
  await expect(
    page.getByRole("button", { name: "Prepare resume", exact: true }),
  ).toBeDisabled();
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(0);
});
