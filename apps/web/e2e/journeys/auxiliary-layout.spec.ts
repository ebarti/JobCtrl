import { test, expect, json } from "../harness/fixtures.js";
import { acceptBaseline, createBaseline, createPosting, current } from "./core-data.js";
import { actionIdentitySnapshot, captureExpanded, visitExpanded } from "./expanded-layout-data.js";
import type { Contact } from "./optional-data.js";

// e2e-uCg5Zt reproduced Playwright's DOM-snapshot script injection being
// refused by the deliberately script-free accepted-HTML sandbox. Match the
// existing demo negative-control setup: keep screenshots, sources and strict
// console checks, while leaving product sandbox permissions unchanged.
// Trace is worker scoped, so this sandboxed-artifact case owns its own file.
test.use({ trace: { mode: "retain-on-failure", snapshots: false, screenshots: true, sources: true } });

test("auxiliary saved evidence contact artifact source tools and import review screens stay readable without import or model submission", async ({ api, app, page }, testInfo) => {
  const { profile } = await createBaseline(api);
  const job = await createPosting(api, "expanded-auxiliary");
  const resume = await acceptBaseline(api, job.job_id, profile.profileVersion);
  const artifactId = current(resume).renders[0]!.artifact_id;
  const { contact } = await json<{ contact: Contact }>(api, "post", "/v1/contacts", {
    jobId: job.job_id, employer: "Synthetic Hiring Company", role: "recruiter",
    attributes: [{ kind: "name", value: "Synthetic Auxiliary Recruiter" }, { kind: "email", value: "recruiter@example.com" }],
  });
  const profileBefore = await json(api, "get", "/v1/profile");
  const callsBefore = app.external.calls.filter((item) => item.path === "/model").length;
  const actionsBefore = await actionIdentitySnapshot(api);
  for (const [name, path, heading] of [
    ["evidence-map", `/evidence-map?job=${encodeURIComponent(job.job_id)}`, "Career evidence map"],
    ["learning", "/learning", "Learning"],
    ["contact-detail", `/outreach/${contact.contactId}`, "Synthetic Auxiliary Recruiter"],
    ["artifact-detail", `/artifacts/${encodeURIComponent(artifactId)}`, "Synthetic Reliability Engineer"],
  ] as const) {
    await visitExpanded(page, testInfo, name, path, heading);
    if (name === "evidence-map") {
      const insets = await page.locator(".evidence-map-view > :is(.profile-evidence-panel, .evidence-map-panel)").evaluateAll((panels) => panels.map((panel) => {
        const outer = panel.getBoundingClientRect();
        const heading = panel.querySelector(":scope > h2, :scope > header")!.getBoundingClientRect();
        return { outer: { left: outer.left, right: outer.right }, heading: { left: heading.left, right: heading.right } };
      }));
      expect(insets).toHaveLength(3);
      for (const item of insets) {
        expect(item.heading.left - item.outer.left).toBeGreaterThan(1);
        expect(item.outer.right - item.heading.right).toBeGreaterThan(1);
      }
    }
    if (name === "artifact-detail") {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const source = page.locator('iframe[title="Recorded resume source HTML"]');
        await source.scrollIntoViewIfNeeded();
        await expect(source).toBeVisible();
        const sourceElement = await source.elementHandle();
        expect(sourceElement).not.toBeNull();
        const sourceFrame = await sourceElement!.contentFrame();
        await sourceElement!.dispose();
        expect(sourceFrame).not.toBeNull();
        // A child locator installs Playwright's global input listeners even
        // without hover interception. Read the real DOM in the main world until
        // native input is complete; retain the child visibility checks below.
        await expect.poll(() => sourceFrame!.evaluate(() => document.body?.innerText.includes("Synthetic Candidate") ?? false)).toBe(true);
        await testInfo.attach(`artifact-source-html-${width}-viewport`, {
          contentType: "image/png", body: await page.screenshot({ animations: "disabled" }),
        });
        // A full-page capture can reach an offscreen iframe before Chromium
        // paints it. Retain a second ordinary viewport after browser paint.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await testInfo.attach(`artifact-source-html-${width}-after-paint-viewport`, {
          contentType: "image/png", body: await page.screenshot({ animations: "disabled" }),
        });
        if (width === 390) {
          const before = await sourceFrame!.evaluate(() => {
            const scroller = document.scrollingElement ?? document.documentElement;
            return { clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth, scrollLeft: scroller.scrollLeft, overflowX: getComputedStyle(scroller).overflowX };
          });
          expect(before.scrollWidth - before.clientWidth).toBeGreaterThan(1);
          expect(["hidden", "clip"]).not.toContain(before.overflowX);
          // Exercise native Chromium input without Playwright's private frame
          // event listeners, which cannot execute in this script-free sandbox.
          const sourceBounds = await source.boundingBox();
          expect(sourceBounds).not.toBeNull();
          const nativeInput = await page.context().newCDPSession(page);
          try {
            const point = { x: sourceBounds!.x + sourceBounds!.width / 2, y: sourceBounds!.y + sourceBounds!.height / 2 };
            await nativeInput.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
            await nativeInput.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: Math.min(600, before.scrollWidth - before.clientWidth), deltaY: 0 });
            await expect.poll(() => sourceFrame!.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollLeft)).toBeGreaterThan(before.scrollLeft);
            // Leave the frame before the later locator visibility checks install
            // their listeners, including across the subsequent viewport changes.
            await nativeInput.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10, buttons: 0 });
          } finally {
            await nativeInput.detach();
          }
          const after = await sourceFrame!.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollLeft);
          await testInfo.attach("artifact-source-html-390-horizontal-scroll", {
            contentType: "application/json", body: JSON.stringify({ ...before, afterScrollLeft: after }),
          });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await testInfo.attach("artifact-source-html-390-scrolled-viewport", {
            contentType: "image/png", body: await page.screenshot({ animations: "disabled" }),
          });
        }
      }
      // Keep the same real text visibility assertion at both supported widths
      // after all native input, when its private input helper cannot interfere.
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('iframe[title="Recorded resume source HTML"]').scrollIntoViewIfNeeded();
        await expect(page.frameLocator('iframe[title="Recorded resume source HTML"]').getByText("Synthetic Candidate", { exact: true }).first()).toBeVisible();
      }
    }
  }
  await visitExpanded(page, testInfo, "import-upload", "/profile/import/upload", "Import resume");
  const pdf = await api.get(`/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`);
  expect(pdf.status(), await pdf.text()).toBe(200);
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic-layout-resume.pdf", mimeType: "application/pdf", buffer: await pdf.body() });
  await expect(page.getByText("synthetic-layout-resume.pdf", { exact: true })).toBeVisible();
  await captureExpanded(page, testInfo, "import-upload-selected", "Import resume");
  await visitExpanded(page, testInfo, "import-preview", "/profile/import/preview", "Import resume");
  await expect(page.getByRole("heading", { name: "Review the PDF and choose the import scope", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Uploaded resume page 1", exact: true })).toBeVisible();
  await captureExpanded(page, testInfo, "import-preview-rendered-pdf", "Import resume");
  await visitExpanded(page, testInfo, "import-confirm", "/profile/import/confirm", "Import resume");
  await expect(page.getByRole("heading", { name: "Review the final import", exact: true })).toBeVisible();
  expect(app.external.calls.filter((item) => item.path === "/model")).toHaveLength(callsBefore);
  expect(await actionIdentitySnapshot(api)).toEqual(actionsBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", `/v1/resumes/${resume.resume_id}`)).toMatchObject({ resume: { accepted_revision_id: resume.accepted_revision_id } });
});
