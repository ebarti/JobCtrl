import { expect, test } from "@playwright/test";

const storageKey = "jh:profile-import-v2";

type UploadTestWindow = Window & {
  uploadReads: Record<string, (value: ArrayBuffer) => void>;
  failResumeWrite: boolean;
  failResumeRemove: boolean;
  failResumeRead: boolean;
};

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
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const pdf = syntheticPdf();

async function selectPdf(page: import("@playwright/test").Page, name: string) {
  await page
    .getByLabel("Resume PDF")
    .setInputFiles({ name, mimeType: "application/pdf", buffer: pdf });
}

async function readCurrent(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  return page.evaluate(
    (key) =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open("jobctrl-profile-import", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db
            .transaction("records", "readonly")
            .objectStore("records")
            .get(key);
          request.onsuccess = () => {
            resolve((request.result as string | undefined) ?? null);
            db.close();
          };
          request.onerror = () => {
            reject(request.error);
            db.close();
          };
        };
      }),
    storageKey,
  );
}

async function trackTransactions(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const native = IDBDatabase.prototype.transaction;
    const state = window as unknown as { transactionCount: number };
    state.transactionCount = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === "jobctrl-profile-import" && args[1] === "readwrite")
        state.transactionCount += 1;
      return native.apply(this, args);
    };
  });
}
async function waitForTransaction(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { transactionCount: number }).transactionCount,
      ),
    )
    .toBeGreaterThan(0);
}
async function holdTransaction(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("jobctrl-profile-import", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("records", "readwrite");
          const store = tx.objectStore("records");
          let hold = true;
          (
            window as unknown as { releaseTransaction: () => void }
          ).releaseTransaction = () => {
            hold = false;
          };
          const pump = () => {
            if (!hold) return;
            const read = store.get("jh:profile-import-v2");
            read.onsuccess = pump;
            read.onerror = () => reject(read.error);
          };
          tx.oncomplete = () => db.close();
          pump();
          resolve();
        };
      }),
  );
}
async function releaseTransaction(page: import("@playwright/test").Page) {
  await page.evaluate(() =>
    (
      window as unknown as { releaseTransaction: () => void }
    ).releaseTransaction(),
  );
}

test("newer reads win, and leaving cancels an unfinished selection", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const testWindow = window as unknown as UploadTestWindow;
    testWindow.uploadReads = {};
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith("delayed-")) return original.call(this);
      return new Promise<ArrayBuffer>((resolve) => {
        testWindow.uploadReads[this.name] = resolve;
      });
    };
  });
  await page.goto("/profile/import/upload");
  await expect(
    page.getByRole("heading", { name: "Choose your source resume" }),
  ).toBeVisible();
  await selectPdf(page, "delayed-first.pdf");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as UploadTestWindow).uploadReads[
            "delayed-first.pdf"
          ],
        ),
      ),
    )
    .toBe(true);
  await selectPdf(page, "delayed-second.pdf");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as UploadTestWindow).uploadReads[
            "delayed-second.pdf"
          ],
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as unknown as UploadTestWindow).uploadReads["delayed-second.pdf"]!(
      new TextEncoder().encode("second").buffer,
    ),
  );
  await expect(page.getByText("delayed-second.pdf")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as UploadTestWindow).uploadReads["delayed-first.pdf"]!(
      new TextEncoder().encode("first").buffer,
    ),
  );
  await expect
    .poll(() => readCurrent(page).then((raw) => JSON.parse(raw!).state))
    .toMatchObject({
      filename: "delayed-second.pdf",
      pdfBase64: Buffer.from("second").toString("base64"),
    });

  await selectPdf(page, "delayed-late.pdf");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as UploadTestWindow).uploadReads[
            "delayed-late.pdf"
          ],
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("navigation", { name: "Resume import steps" })
      .getByRole("link", { name: /Preview options/i }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await page.evaluate(() =>
    (window as unknown as UploadTestWindow).uploadReads["delayed-late.pdf"]!(
      new TextEncoder().encode("late").buffer,
    ),
  );
  await page.getByRole("link", { name: "Import resume" }).click();
  await expect(page.getByText("delayed-second.pdf")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("retained-selection.png"),
  });
  expect(pageErrors).toEqual([]);
});

test("storage failures preserve the prior PDF and allow explicit retry and removal", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const testWindow = window as unknown as UploadTestWindow;
    testWindow.failResumeWrite = false;
    testWindow.failResumeRemove = false;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === "jh:profile-import-v2") {
        if (testWindow.failResumeWrite)
          throw new DOMException("Full", "QuotaExceededError");
        if (
          testWindow.failResumeRemove &&
          !JSON.parse(value as string).state.filename
        )
          throw new DOMException("Denied", "SecurityError");
      }
      return put.call(this, value, key);
    };
  });
  await page.goto("/profile/import/upload");
  await selectPdf(page, "accepted.pdf");
  await expect(page.getByText("accepted.pdf")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeWrite = true;
  });
  await selectPdf(page, "replacement.pdf");
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("could not be saved");
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
    )
    .toBe("accepted.pdf");
  await page.screenshot({ path: testInfo.outputPath("failed-save.png") });

  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeWrite = false;
  });
  await page.getByRole("button", { name: "Retry saving PDF" }).click();
  await expect(page.getByText("replacement.pdf")).toBeVisible();
  await expect
    .poll(() =>
      readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
    )
    .toBe("replacement.pdf");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await page.getByRole("link", { name: "Import resume" }).click();
  await expect(page.getByText("replacement.pdf")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeRemove = true;
  });
  await page.getByRole("button", { name: "Remove saved PDF" }).click();
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("could not be removed");
  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeRemove = false;
  });
  await page.getByRole("button", { name: "Retry removing PDF" }).click();
  await expect
    .poll(() =>
      readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
    )
    .toBe("");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test("an unavailable saved selection is reported and can be read again after storage recovers", async ({
  page,
}) => {
  await page.addInitScript(
    ({ encodedPdf }) => {
      const testWindow = window as unknown as UploadTestWindow;
      window.localStorage.setItem(
        "jh:profile-import",
        JSON.stringify({
          version: 1,
          state: {
            filename: "saved.pdf",
            pdfBase64: encodedPdf,
            importProfile: true,
            importStyle: true,
          },
        }),
      );
      testWindow.failResumeRead = true;
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key === "jh:profile-import" && testWindow.failResumeRead)
          throw new DOMException("Denied", "SecurityError");
        return getItem.call(this, key);
      };
    },
    { encodedPdf: pdf.toString("base64") },
  );
  await page.goto("/profile/import/upload");
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("could not be read");
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeDisabled();
  await page.getByLabel("Resume PDF").setInputFiles({
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic"),
  });
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("Choose a PDF file");
  await page.getByRole("button", { name: "Discard selection" }).click();
  await expect(
    page.getByRole("button", { name: "Retry browser storage" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeRead = false;
  });
  await page.getByRole("button", { name: "Retry browser storage" }).click();
  await expect(page.getByText("saved.pdf")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeEnabled();
});

test("an option round trip cannot duplicate an in-flight import, while different options can proceed", async ({
  page,
}) => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const requests: Array<{ importProfile: boolean }> = [];
  await page.route("**/v1/profile/import-resume", async (route) => {
    const index = requests.length;
    requests.push(route.request().postDataJSON() as { importProfile: boolean });
    const response = await route.fetch();
    await (index === 0 ? firstGate : secondGate);
    await route.fulfill({ response });
  });
  try {
    await page.goto("/profile/import/upload");
    await selectPdf(page, "synthetic.pdf");
    await page.getByRole("button", { name: "Continue to options" }).click();
    await page
      .getByRole("button", { name: "Continue to confirmation" })
      .click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect.poll(() => requests.length).toBe(1);
    await page.getByRole("link", { name: "Back", exact: true }).click();
    const profileOption = page.getByRole("checkbox", { name: "Profile data" });
    await profileOption.click();
    await profileOption.click();
    await page
      .getByRole("button", { name: "Continue to confirmation" })
      .click();
    await expect(
      page.getByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    expect(requests).toHaveLength(1);

    await page.getByRole("link", { name: "Back", exact: true }).click();
    await page.getByRole("checkbox", { name: "Profile data" }).click();
    await page
      .getByRole("button", { name: "Continue to confirmation" })
      .click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests.map((request) => request.importProfile)).toEqual([
      true,
      false,
    ]);
    const firstResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/profile/import-resume") &&
        response.request().postDataJSON().importProfile === true,
    );
    releaseFirst();
    await firstResponse;
    await expect(
      page.getByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    const secondResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/profile/import-resume") &&
        response.request().postDataJSON().importProfile === false,
    );
    releaseSecond();
    await secondResponse;
    await expect(page).toHaveURL(/\/profile$/);
  } finally {
    releaseFirst();
    releaseSecond();
  }
});

test("successful import is not repeated when removing the stored PDF fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as unknown as UploadTestWindow;
    testWindow.failResumeRemove = false;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (
        key === "jh:profile-import-v2" &&
        testWindow.failResumeRemove &&
        !JSON.parse(value as string).state.filename
      )
        throw new DOMException("Denied", "SecurityError");
      return put.call(this, value, key);
    };
  });
  let importCalls = 0;
  await page.route("**/v1/profile/import-resume", async (route) => {
    importCalls += 1;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.goto("/profile/import/upload");
  await selectPdf(page, "synthetic.pdf");
  await page.getByRole("button", { name: "Continue to options" }).click();
  await expect(page).toHaveURL(/\/profile\/import\/preview$/);
  await page.getByRole("button", { name: "Continue to confirmation" }).click();
  await expect(page).toHaveURL(/\/profile\/import\/confirm$/);
  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeRemove = true;
  });
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The import request completed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm import" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry removing saved PDF" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "could not be removed" }),
  ).toBeVisible();
  expect(importCalls).toBe(1);
  await page.evaluate(() => {
    (window as unknown as UploadTestWindow).failResumeRemove = false;
  });
  await page.getByRole("button", { name: "Retry removing saved PDF" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  expect(importCalls).toBe(1);
  expect(
    await readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
  ).toBe("");
});

test("the same PDF can be deliberately imported again after successful cleanup", async ({
  page,
}) => {
  let importCalls = 0;
  await page.route("**/v1/profile/import-resume", async (route) => {
    importCalls += 1;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.goto("/profile/import/upload");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await selectPdf(page, "same.pdf");
    await page.getByRole("button", { name: "Continue to options" }).click();
    await page
      .getByRole("button", { name: "Continue to confirmation" })
      .click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    expect(importCalls).toBe(attempt);
    if (attempt === 1) {
      await page.getByRole("link", { name: "Import resume" }).click();
      await expect(page).toHaveURL(/\/profile\/import\/upload$/);
    }
  }
});

test("a late import response cannot remove a newer selection or pull the user back", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let importCalls = 0;
  await page.route("**/v1/profile/import-resume", async (route) => {
    importCalls += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto("/profile/import/upload");
  await selectPdf(page, "previous.pdf");
  await page.getByRole("button", { name: "Continue to options" }).click();
  await page.getByRole("button", { name: "Continue to confirmation" }).click();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect.poll(() => importCalls).toBe(1);
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await page.getByRole("link", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/profile\/import\/upload$/);
  await selectPdf(page, "newer.pdf");
  await expect(page.getByText("newer.pdf")).toBeVisible();
  const response = page.waitForResponse("**/v1/profile/import-resume");
  release();
  await response;
  await expect(page).toHaveURL(/\/profile\/import\/upload$/);
  await expect(page.getByText("newer.pdf")).toBeVisible();
  expect(JSON.parse((await readCurrent(page))!).state.filename).toBe(
    "newer.pdf",
  );
  expect(importCalls).toBe(1);
});

test("another tab's later selection survives an earlier import completion", async ({
  page,
  context,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/v1/profile/import-resume", async (route) => {
    requests += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/profile/import/upload");
    await selectPdf(page, "first.pdf");
    await page.getByRole("button", { name: "Continue to options" }).click();
    await page
      .getByRole("button", { name: "Continue to confirmation" })
      .click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect.poll(() => requests).toBe(1);
    const other = await context.newPage();
    await other.goto("/profile/import/upload");
    await expect(other.getByText("first.pdf")).toBeVisible();
    await selectPdf(other, "second.pdf");
    await expect(other.getByText("second.pdf")).toBeVisible();
    release();
    await expect(
      page.getByRole("status").filter({ hasText: "newer selection was kept" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm import" }),
    ).toHaveCount(0);
    expect(
      await readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
    ).toBe("second.pdf");
    await page.getByRole("link", { name: "Return to upload" }).click();
    await expect(
      page.getByRole("button", { name: "Load latest saved PDF" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Load latest saved PDF" }).click();
    await expect(page.getByText("second.pdf")).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    release();
  }
});

test("competing upload and removal are serialized before checking ownership", async ({
  page,
  context,
}) => {
  await page.goto("/profile/import/upload");
  await selectPdf(page, "first.pdf");
  await expect(page.getByText("first.pdf")).toBeVisible();
  const writer = await context.newPage();
  await writer.goto("/profile/import/upload");
  await expect(writer.getByText("first.pdf")).toBeVisible();
  const holder = await context.newPage();
  await holder.goto("/profile/import/upload");
  await holdTransaction(holder);
  await trackTransactions(writer);
  await trackTransactions(page);
  await selectPdf(writer, "second.pdf");
  await expect(writer.getByText("Reading the selected file…")).toBeVisible();
  await waitForTransaction(writer);
  await page.getByRole("button", { name: "Remove saved PDF" }).click();
  await waitForTransaction(page);
  await releaseTransaction(holder);
  await expect(writer.getByText("second.pdf")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("Another tab changed");
  expect(
    await readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
  ).toBe("second.pdf");
  await page.getByRole("button", { name: "Load latest saved PDF" }).click();
  await expect(page.getByText("second.pdf")).toBeVisible();
});

test("legacy data stays intact while old-tab writes cannot erase the current record", async ({
  page,
  context,
}) => {
  const legacy = JSON.stringify({
    version: 1,
    state: {
      filename: "legacy.pdf",
      pdfBase64: pdf.toString("base64"),
      importProfile: true,
      importStyle: true,
    },
  });
  await page.addInitScript((value) => {
    if (localStorage.getItem("jh:profile-import") === null)
      localStorage.setItem("jh:profile-import", value);
  }, legacy);
  await page.goto("/profile/import/upload");
  await expect(page.getByText("legacy.pdf")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download earlier saved PDF" }),
  ).toBeVisible();
  await selectPdf(page, "current.pdf");
  await expect(page.getByText("current.pdf")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("jh:profile-import")),
  ).toBe(legacy);
  const oldTab = await context.newPage();
  await oldTab.goto("/profile/import/upload");
  const laterLegacy = legacy.replace("legacy.pdf", "old-tab-later.pdf");
  await oldTab.evaluate(
    (value) => localStorage.setItem("jh:profile-import", value),
    laterLegacy,
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("jh:profile-import")))
    .toBe(laterLegacy);
  await page.getByRole("button", { name: "Remove saved PDF" }).click();
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("Another tab changed");
  expect(
    await readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
  ).toBe("current.pdf");
  await page.getByRole("button", { name: "Load latest saved PDF" }).click();
  await page.getByRole("button", { name: "Remove saved PDF" }).click();
  await expect(
    page.getByRole("button", { name: "Continue to options" }),
  ).toBeDisabled();
  await expect.poll(async () => JSON.parse((await readCurrent(page))!).state.filename).toBe("");
  expect(
    await page.evaluate(() => localStorage.getItem("jh:profile-import")),
  ).toBe(laterLegacy);
  await oldTab.evaluate(() => localStorage.removeItem("jh:profile-import"));
  expect(
    await readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
  ).toBe("");
});

test("unavailable transactional storage preserves legacy data and permits retry", async ({
  page,
}) => {
  const legacy = JSON.stringify({
    version: 1,
    state: {
      filename: "legacy.pdf",
      pdfBase64: pdf.toString("base64"),
      importProfile: true,
      importStyle: true,
    },
  });
  await page.addInitScript((value) => {
    localStorage.setItem("jh:profile-import", value);
    const testWindow = window as unknown as { savedIndexedDB: IDBFactory };
    testWindow.savedIndexedDB = indexedDB;
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: undefined,
    });
  }, legacy);
  await page.goto("/profile/import/upload");
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("could not be read");
  await selectPdf(page, "synthetic.pdf");
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("could not be saved");
  await page.getByRole("button", { name: "Discard selection" }).click();
  await expect(
    page.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("could not be read");
  expect(
    await page.evaluate(() => localStorage.getItem("jh:profile-import")),
  ).toBe(legacy);
  await page.evaluate(() =>
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: (window as unknown as { savedIndexedDB: IDBFactory })
        .savedIndexedDB,
    }),
  );
  await page.getByRole("button", { name: "Retry browser storage" }).click();
  await expect(page.getByText("legacy.pdf")).toBeVisible();
  expect(await readCurrent(page)).toBeNull();
});

test("two tabs competing to save different PDFs cannot overwrite the winner", async ({
  page,
  context,
}) => {
  await page.goto("/profile/import/upload");
  const other = await context.newPage();
  await other.goto("/profile/import/upload");
  const holder = await context.newPage();
  await holder.goto("/profile/import/upload");
  await holdTransaction(holder);
  await trackTransactions(page);
  await trackTransactions(other);
  await selectPdf(page, "first.pdf");
  await expect(page.getByText("Reading the selected file…")).toBeVisible();
  await waitForTransaction(page);
  await selectPdf(other, "second.pdf");
  await expect(other.getByText("Reading the selected file…")).toBeVisible();
  await waitForTransaction(other);
  await releaseTransaction(holder);
  await expect(page.getByText("first.pdf")).toBeVisible();
  await expect(
    other.getByRole("region", { name: "Resume import" }).getByRole("alert"),
  ).toContainText("Another tab changed");
  expect(
    await readCurrent(page).then((raw) => JSON.parse(raw!).state.filename),
  ).toBe("first.pdf");
  await other.getByRole("button", { name: "Load latest saved PDF" }).click();
  await expect(other.getByText("first.pdf")).toBeVisible();
});

test("a pending transaction is cancelled by replacement or leaving the upload step", async ({
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/profile/import/upload");
  const holder = await context.newPage();
  await holder.goto("/profile/import/upload");
  await holdTransaction(holder);
  await trackTransactions(page);
  await selectPdf(page, "first.pdf");
  await waitForTransaction(page);
  await selectPdf(page, "second.pdf");
  await releaseTransaction(holder);
  await expect(page.getByText("second.pdf")).toBeVisible();
  expect(JSON.parse((await readCurrent(page))!).state.filename).toBe(
    "second.pdf",
  );

  await holdTransaction(holder);
  await trackTransactions(page);
  await selectPdf(page, "late.pdf");
  await waitForTransaction(page);
  await page.getByRole("link", { name: "Cancel" }).click();
  await releaseTransaction(holder);
  await expect(page).toHaveURL(/\/profile$/);
  await page.getByRole("link", { name: "Import resume" }).click();
  await expect(page.getByText("second.pdf")).toBeVisible();
  expect(JSON.parse((await readCurrent(page))!).state.filename).toBe(
    "second.pdf",
  );
  expect(pageErrors).toEqual([]);
});

test("leaving confirmation aborts a queued post-import cleanup", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let releaseResponse!: () => void;
  let calls = 0;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/v1/profile/import-resume", async (route) => {
    calls += 1;
    const response = await route.fetch();
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/profile/import/upload");
    await selectPdf(page, "accepted.pdf");
    await page.getByRole("button", { name: "Continue to options" }).click();
    await page
      .getByRole("button", { name: "Continue to confirmation" })
      .click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect.poll(() => calls).toBe(1);
    await trackTransactions(page);
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("jobctrl-profile-import", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = IDBDatabase.prototype.transaction;
      let gateNext = true;
      IDBDatabase.prototype.transaction = function (...args) {
        const current = transaction.apply(this, args);
        if (gateNext && this.name === "jobctrl-profile-import" && args[1] === "readwrite") {
          gateNext = false;
          current.addEventListener("complete", () => {
            const held = database.transaction("records", "readwrite");
            const store = held.objectStore("records");
            let active = true;
            (window as unknown as { releasePostDraft: () => void }).releasePostDraft = () => { active = false; };
            held.oncomplete = () => database.close();
            const pump = () => {
              if (!active) return;
              const read = store.get("jh:profile-import-v2");
              read.onsuccess = pump;
            };
            pump();
          }, { once: true });
        }
        return current;
      };
    });
    releaseResponse();
    // Draft commit, the test holder, then the queued cleanup transaction.
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { transactionCount: number }).transactionCount,
    )).toBeGreaterThanOrEqual(3);
    await page.getByRole("link", { name: "Return to profile" }).click();
    await page.evaluate(() => (window as unknown as { releasePostDraft: () => void }).releasePostDraft());
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("heading", { name: "Review imported resume" })).toBeVisible();
    expect(JSON.parse((await readCurrent(page))!).state.filename).toBe(
      "accepted.pdf",
    );
    expect(calls).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    releaseResponse();
    await page.evaluate(() => (window as unknown as { releasePostDraft?: () => void }).releasePostDraft?.()).catch(() => undefined);
  }
});

test("loading the latest saved PDF cancels an unfinished replacement read", async ({
  page,
  context,
}) => {
  await page.goto("/profile/import/upload");
  await selectPdf(page, "first.pdf");
  await expect(page.getByText("first.pdf")).toBeVisible();
  const stale = await context.newPage();
  await stale.addInitScript(() => {
    const state = window as unknown as UploadTestWindow;
    state.uploadReads = {};
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "delayed-third.pdf") return read.call(this);
      return new Promise<ArrayBuffer>((resolve) => {
        state.uploadReads[this.name] = resolve;
      });
    };
  });
  await stale.goto("/profile/import/upload");
  await expect(stale.getByText("first.pdf")).toBeVisible();
  await selectPdf(page, "second.pdf");
  await expect(page.getByText("second.pdf")).toBeVisible();
  await stale.getByRole("button", { name: "Remove saved PDF" }).click();
  await expect(
    stale.getByRole("button", { name: "Load latest saved PDF" }),
  ).toBeVisible();
  await selectPdf(stale, "delayed-third.pdf");
  await expect
    .poll(() =>
      stale.evaluate(() =>
        Boolean(
          (window as unknown as UploadTestWindow).uploadReads[
            "delayed-third.pdf"
          ],
        ),
      ),
    )
    .toBe(true);
  await stale.getByRole("button", { name: "Load latest saved PDF" }).click();
  await expect(stale.getByText("second.pdf")).toBeVisible();
  await stale.evaluate(() =>
    (window as unknown as UploadTestWindow).uploadReads["delayed-third.pdf"]!(
      new TextEncoder().encode("late").buffer,
    ),
  );
  expect(JSON.parse((await readCurrent(stale))!).state.filename).toBe(
    "second.pdf",
  );
});

test("a fresh tab hydrates the stored PDF before a direct preview or confirmation route", async ({
  page,
  context,
}) => {
  await page.goto("/profile/import/upload");
  await selectPdf(page, "saved.pdf");
  await expect(page.getByText("saved.pdf")).toBeVisible();
  const fresh = await context.newPage();
  await fresh.goto("/profile/import/preview");
  await expect(fresh).toHaveURL(/\/profile\/import\/preview$/);
  await expect(
    fresh.getByRole("heading", {
      name: "Review the PDF and choose the import scope",
    }),
  ).toBeVisible();
  await fresh.goto("/profile/import/confirm");
  await expect(fresh).toHaveURL(/\/profile\/import\/confirm$/);
  await expect(
    fresh.getByRole("button", { name: "Confirm import" }),
  ).toBeVisible();
  await expect(fresh.getByText("saved.pdf")).toBeVisible();
});
