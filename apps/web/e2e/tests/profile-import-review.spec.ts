import { expect, test, type Page } from "@playwright/test";

function syntheticPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 4 >>\nstream\nq\nQ\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(
    `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

async function savedProfile(page: Page) {
  const response = await page.request.get("/v1/profile");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function storedUploadFilename(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("jobctrl-profile-import", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const raw = await new Promise<string | undefined>((resolve, reject) => {
        const request = db.transaction("records").objectStore("records").get("jh:profile-import-v2");
        request.onsuccess = () => resolve(request.result as string | undefined);
        request.onerror = () => reject(request.error);
      });
      return raw ? JSON.parse(raw).state.filename : null;
    } finally { db.close(); }
  });
}

async function requestExtraction(page: Page, filename = "synthetic-review.pdf") {
  await page.goto("/profile/import/upload");
  await page.getByLabel("Resume PDF").setInputFiles({
    name: filename,
    mimeType: "application/pdf",
    buffer: syntheticPdf(),
  });
  await page.getByRole("button", { name: "Continue to options" }).click();
  await page.getByRole("button", { name: "Continue to confirmation" }).click();
  const extraction = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/profile/import-resume") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Confirm import" }).click();
  return extraction;
}

async function extract(page: Page, filename = "synthetic-review.pdf") {
  expect((await requestExtraction(page, filename)).status()).toBe(200);
  await expect(page).toHaveURL(/\/profile$/);
  await expect(
    page.getByRole("heading", { name: "Review imported resume" }),
  ).toBeVisible();
  await expect(
    page.getByText("Full name: E2E Imported Candidate"),
  ).toBeVisible();
}

test("real import route presents an unsaved draft and accepts only the chosen section", async ({
  page,
}, testInfo) => {
  const before = await savedProfile(page);
  await extract(page);
  await testInfo.attach("import-review", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  if (process.env.JOBCTRL_IMPORT_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.JOBCTRL_IMPORT_QA_SCREENSHOT, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Review imported resume" })).toBeVisible();
  expect(await page.locator(".profile-import-review").evaluate((card) =>
    card.scrollWidth <= card.clientWidth + 1 &&
    [...card.querySelectorAll("button")].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }),
  )).toBe(true);
  if (process.env.JOBCTRL_IMPORT_QA_MOBILE_SCREENSHOT) {
    await page.screenshot({ path: process.env.JOBCTRL_IMPORT_QA_MOBILE_SCREENSHOT, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(await savedProfile(page)).toEqual(before);
  await page.getByRole("checkbox", { name: "Personal details" }).check();
  await page.getByRole("checkbox", { name: "Experience" }).check();
  const save = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/profile") &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  expect((await save).status()).toBe(200);
  const after = await savedProfile(page);
  expect(after.profile.personal.full_name).toBe("E2E Imported Candidate");
  expect(after.profile.resume.experience_entries.slice(0, -1)).toEqual(before.profile.resume.experience_entries);
  expect(after.profile.resume.experience_entries.at(-1)).toMatchObject({
    title: "Synthetic imported role", bullets: ["Synthetic imported bullet"], achievement_evidence: [],
  });
  expect(after.style).toEqual(before.style);
  await expect(page.getByText("Selected import sections saved.")).toBeVisible();
});

test("a concurrent saved edit rejects stale acceptance and keeps the draft for renewed review", async ({
  page,
}) => {
  let before = await savedProfile(page);
  const original = structuredClone(before.profile);
  original.personal.full_name = "Synthetic initial profile";
  let response = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: original, expectedProfileVersion: before.profileVersion },
  });
  expect(response.ok()).toBe(true);
  before = await savedProfile(page);
  await extract(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review imported resume" })).toBeVisible();
  await expect(page.getByText("Full name: E2E Imported Candidate")).toBeVisible();
  let releaseRead!: () => void;
  let readCaptured!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const captured = new Promise<void>((resolve) => { readCaptured = resolve; });
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const read = await route.fetch();
    readCaptured();
    await readGate;
    await route.fulfill({ response: read });
  });
  await page.getByRole("checkbox", { name: "Personal details" }).check();
  const rejected = page.waitForResponse(
    (item) =>
      item.url().endsWith("/v1/profile") && item.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  await captured;
  const newer = structuredClone(before.profile);
  newer.personal.full_name = "Synthetic newer edit";
  response = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: newer, expectedProfileVersion: before.profileVersion },
  });
  expect(response.ok()).toBe(true);
  releaseRead();
  expect((await rejected).status()).toBe(409);
  await page.unroute("**/v1/profile");
  await expect(page.getByText(/saved profile changed/i)).toBeVisible();
  expect((await savedProfile(page)).profile.personal.full_name).toBe(
    "Synthetic newer edit",
  );
  await page.reload();
  await expect(page.getByText("Full name: E2E Imported Candidate")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Personal details" })).not.toBeChecked();
  await page.getByRole("button", { name: "Load latest saved profile" }).click();
  await expect(page.getByText(/latest saved profile loaded/i)).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Personal details" }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Personal details" }).check();
  const accepted = page.waitForResponse(
    (item) =>
      item.url().endsWith("/v1/profile") && item.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  expect((await accepted).status()).toBe(200);
  const after = await savedProfile(page);
  expect(after.profile.personal.full_name).toBe("E2E Imported Candidate");
  expect(after.profile.resume.experience_entries).toEqual(
    before.profile.resume.experience_entries,
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Resume data" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review imported resume" })).toHaveCount(0);
});

test("a failed draft write keeps the PDF and allows storage retry before reload", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { failDraftWrite: boolean }).failDraftWrite = true;
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === "jh:profile-import-review-v1" && (window as unknown as { failDraftWrite: boolean }).failDraftWrite)
        throw new DOMException("Synthetic storage failure", "SecurityError");
      return put.call(this, value, key);
    };
  });
  let before = await savedProfile(page);
  const baseline = structuredClone(before.profile);
  baseline.personal.full_name = "Synthetic storage-failure baseline";
  const prepared = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: baseline, expectedProfileVersion: before.profileVersion },
  });
  expect(prepared.ok()).toBe(true);
  before = await savedProfile(page);
  await page.goto("/profile/import/upload");
  await page.getByLabel("Resume PDF").setInputFiles({ name: "synthetic-retained.pdf", mimeType: "application/pdf", buffer: syntheticPdf() });
  await page.getByRole("button", { name: "Continue to options" }).click();
  await page.getByRole("button", { name: "Continue to confirmation" }).click();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText(/could not be saved for reload/i)).toBeVisible();
  expect(await storedUploadFilename(page)).toBe("synthetic-retained.pdf");
  expect(await savedProfile(page)).toEqual(before);
  await page.getByRole("link", { name: "Review draft", exact: true }).click();
  await expect(page.getByText("Full name: E2E Imported Candidate")).toBeVisible();
  await page.evaluate(() => { (window as unknown as { failDraftWrite: boolean }).failDraftWrite = false; });
  await page.getByRole("button", { name: "Retry browser storage" }).click();
  await expect(page.getByText(/review drafts could not be read or saved/i)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Full name: E2E Imported Candidate")).toBeVisible();
  expect(await storedUploadFilename(page)).toBe("synthetic-retained.pdf");
  expect(await savedProfile(page)).toEqual(before);
});

test("a saved draft retained after cleanup failure cannot replay over a newer deletion", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { failDraftRemoval: boolean }).failDraftRemoval = false;
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === "jh:profile-import-review-v1" &&
          (window as unknown as { failDraftRemoval: boolean }).failDraftRemoval &&
          JSON.parse(value as string).drafts.length === 0)
        throw new DOMException("Synthetic removal failure", "SecurityError");
      return put.call(this, value, key);
    };
  });
  let before = await savedProfile(page);
  const baseline = structuredClone(before.profile);
  baseline.personal.full_name = "Synthetic replay baseline";
  let response = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: baseline, expectedProfileVersion: before.profileVersion },
  });
  expect(response.ok()).toBe(true);
  before = await savedProfile(page);
  await extract(page, "synthetic-replay.pdf");
  await page.evaluate(() => { (window as unknown as { failDraftRemoval: boolean }).failDraftRemoval = true; });
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/profile") && request.method() === "PATCH") writes += 1;
  });
  await page.getByRole("checkbox", { name: "Experience" }).check();
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  await expect(page.getByText(/selected sections were saved, but the review draft changed or could not be removed/i)).toBeVisible();
  const committed = await savedProfile(page);
  expect(committed.profile.resume.experience_entries.filter((entry: { title: string }) => entry.title === "Synthetic replay role")).toHaveLength(1);
  const later = structuredClone(committed.profile);
  later.personal.full_name = "Synthetic newer edit";
  later.resume.experience_entries = later.resume.experience_entries.filter((entry: { title: string }) => entry.title !== "Synthetic replay role");
  response = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: later, expectedProfileVersion: committed.profileVersion },
  });
  expect(response.ok()).toBe(true);
  const newer = await savedProfile(page);
  await page.reload();
  await expect(page.getByText(/previous save was attempted/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load latest saved profile" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry original save" }).click();
  await expect(page.getByText(/cannot be retried or rebased safely/i)).toBeVisible();
  expect(writes).toBe(1);
  expect(await savedProfile(page)).toEqual(newer);
  await expect(page.getByText("Synthetic replay role — Synthetic company")).toBeVisible();
});

test("a damaged stored base cannot erase canonical confirmed evidence", async ({ page }) => {
  let before = await savedProfile(page);
  const baseline = structuredClone(before.profile);
  baseline.personal.full_name = "Synthetic evidence baseline";
  baseline.resume.experience_entries[0].achievement_evidence = [{
    id: "synthetic-accepted-proof", source_text: "Synthetic confirmed evidence", user_confirmed: true,
    evidence_strength: "verified", claim_confidence: 1,
  }];
  const prepared = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: baseline, expectedProfileVersion: before.profileVersion },
  });
  expect(prepared.ok()).toBe(true);
  before = await savedProfile(page);
  await extract(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("jobctrl-profile-import", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite");
        const store = tx.objectStore("records");
        const read = store.get("jh:profile-import-review-v1");
        read.onsuccess = () => {
          const value = JSON.parse(read.result as string);
          value.drafts[0].base.profile.resume = { experience_entries: [{ id: "synthetic-damaged-entry" }] };
          store.put(JSON.stringify(value), "jh:profile-import-review-v1");
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  await page.reload();
  await expect(page.getByText("Full name: E2E Imported Candidate")).toBeVisible();
  await page.getByRole("checkbox", { name: "Personal details" }).check();
  const save = page.waitForResponse((item) => item.url().endsWith("/v1/profile") && item.request().method() === "PATCH");
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  expect((await save).status()).toBe(200);
  const after = await savedProfile(page);
  expect(after.profile.personal.full_name).toBe("E2E Imported Candidate");
  expect(after.profile.resume.experience_entries).toEqual(before.profile.resume.experience_entries);
});

test("a hidden imported field requires a fresh explicit review", async ({ page }) => {
  let before = await savedProfile(page);
  const baseline = structuredClone(before.profile);
  baseline.personal.full_name = "Synthetic consent baseline";
  baseline.personal.email = "saved@example.invalid";
  const prepared = await page.request.patch("/v1/profile", {
    headers: { origin: "http://127.0.0.1:5174" },
    data: { profile: baseline, expectedProfileVersion: before.profileVersion },
  });
  expect(prepared.ok()).toBe(true);
  before = await savedProfile(page);
  await extract(page, "synthetic-consent.pdf");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("jobctrl-profile-import", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite");
        const store = tx.objectStore("records");
        const read = store.get("jh:profile-import-review-v1");
        read.onsuccess = () => {
          const value = JSON.parse(read.result as string);
          value.drafts[0].base.profile.personal.email = "imported@example.invalid";
          store.put(JSON.stringify(value), "jh:profile-import-review-v1");
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  await page.reload();
  await expect(page.getByText("Full name: E2E Imported Candidate")).toBeVisible();
  await expect(page.getByText("Email: imported@example.invalid")).toHaveCount(0);
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/profile") && request.method() === "PATCH") writes += 1;
  });
  await page.getByRole("checkbox", { name: "Personal details" }).check();
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  await expect(page.getByText(/review fields changed against the saved profile/i)).toBeVisible();
  expect(writes).toBe(0);
  expect(await savedProfile(page)).toEqual(before);
  await expect(page.getByRole("checkbox", { name: "Personal details" })).toBeChecked();
  await page.getByRole("button", { name: "Load latest saved profile" }).click();
  await expect(page.getByText("Email: imported@example.invalid")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Personal details" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Personal details" }).check();
  const saved = page.waitForResponse((item) => item.url().endsWith("/v1/profile") && item.request().method() === "PATCH");
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  expect((await saved).status()).toBe(200);
  const after = await savedProfile(page);
  expect(after.profile.personal.email).toBe("imported@example.invalid");
  expect(after.profile.resume.experience_entries).toEqual(before.profile.resume.experience_entries);
});

test("browser-only personal fields cannot become a verified import draft", async ({ page }) => {
  const before = await savedProfile(page);
  await page.route("**/v1/profile/import-resume", async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    result.profile.personal.email = "tampered@example.invalid";
    await route.fulfill({ response, json: result });
  });
  expect((await requestExtraction(page, "synthetic-consent.pdf")).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "The extracted personal fields could not be verified" })).toBeVisible();
  await expect(page).toHaveURL(/\/profile\/import\/confirm$/);
  expect(await storedUploadFilename(page)).toBe("synthetic-consent.pdf");
  expect(await savedProfile(page)).toEqual(before);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Review imported resume" })).toHaveCount(0);
});

test("browser-only experience changes are rejected against the persisted extraction", async ({ page }) => {
  const before = await savedProfile(page);
  await page.route("**/v1/profile/import-resume", async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    result.profile.resume.experience_entries[0].title = "Tampered imported role";
    await route.fulfill({ response, json: result });
  });
  expect((await requestExtraction(page)).status()).toBe(200);
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText("Tampered imported role — Synthetic company")).toBeVisible();
  await page.getByRole("checkbox", { name: "Experience" }).check();
  const save = page.waitForResponse((response) =>
    response.url().endsWith("/v1/profile") && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Accept selected sections" }).click();
  const rejected = await save;
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).message).toMatch(/extraction receipt/i);
  expect(await savedProfile(page)).toEqual(before);
  await page.reload();
  await expect(page.getByText("Tampered imported role — Synthetic company")).toBeVisible();
});
