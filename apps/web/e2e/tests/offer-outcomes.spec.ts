import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

// The composed Job Detail reads supporting histories through Python RPC.
// CI runs this scenario in its explicit production API/RPC step.
test.skip(
  process.env["JOBCTRL_E2E_ISOLATED"] === "1",
  "Runs in the separate production API/RPC browser gate",
);

const JOB = "90000000-0000-4000-8000-000000001033";
// The suite shares one independently owned workspace across specs. Do not let
// this scenario's synthetic records alter later job counts or visual fixtures.
test.afterEach(() => {
  const db = new Database(loadE2eDbPath());
  try {
    db.transaction(() => {
      db.prepare(
        "DELETE FROM contact_attributes WHERE tenant_id='local' AND contact_id IN (SELECT contact_id FROM contacts WHERE tenant_id='local' AND job_id=?)",
      ).run(JOB);
      db.prepare(
        "DELETE FROM contact_projections WHERE tenant_id='local' AND job_id=?",
      ).run(JOB);
      db.prepare(
        "DELETE FROM contacts WHERE tenant_id='local' AND job_id=?",
      ).run(JOB);
      for (const table of [
        "job_list_projections",
        "job_detail_projections",
        "application_outcomes",
        "job_events",
        "job_stage_states",
        "jobs",
      ]) {
        db.prepare(
          `DELETE FROM ${table} WHERE tenant_id='local' AND job_id=?`,
        ).run(JOB);
      }
    })();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM jobs WHERE tenant_id='local' AND job_id=?",
        )
        .get(JOB),
    ).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

async function openSelect(trigger: Locator) {
  // Keyboard opening leaves selection to the explicit option action below.
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function openOutcomes(page: Page) {
  await expect(page.locator("#job-detail-outcomes > .configuration-section__header [data-slot='collapsible-trigger']"))
    .toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  await page.getByRole("navigation", { name: "Job detail sections" })
    .getByRole("button", { name: "Application outcomes", exact: true }).click();
  return page.getByRole("region", { name: "Offer terms and decisions" });
}

test("section jumps keep keyboard focus without stealing a later selection", async ({
  page,
}) => {
  test.setTimeout(90000);
  const db = new Database(loadE2eDbPath());
  db.prepare(
    "INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,'https://synthetic.example/offer-focus-qa','Offer focus QA','Synthetic Employer')",
  ).run(JOB);
  db.close();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/jobs/${JOB}`);
  await expect(page).toHaveTitle(/JobCtrl/);
  await page.addStyleTag({
    // Keep the real closing transition pending long enough to exercise an
    // immediate subsequent user interaction deterministically.
    content: ".job-detail-sections-menu[data-closed] { animation-duration: 1500ms !important; }",
  });

  const sections = page.getByRole("button", { name: "Sections", exact: true });
  const menu = page.locator(".job-detail-sections-menu");
  const jump = page.getByRole("navigation", { name: "Job detail sections" })
    .getByRole("button", { name: "Application outcomes", exact: true });
  const disclosure = page.locator("#job-detail-outcomes > .configuration-section__header [data-slot='collapsible-trigger']");
  await sections.click();
  await jump.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(disclosure).toBeFocused();
  await expect(menu).toHaveCount(0);
  await expect(disclosure).toBeFocused();

  await disclosure.click();
  await sections.click();
  await jump.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toHaveAttribute("data-closed", "");
  await page.getByText("Record actual offer terms", { exact: true }).click();
  const amount = page.getByLabel("Amount 1", { exact: true });
  await amount.click();
  await expect(amount).toBeFocused();
  await amount.evaluate((element) => {
    element.addEventListener("blur", () => {
      element.setAttribute("data-test-focus-lost", "true");
    }, { once: true });
  });
  await expect(menu).toHaveCount(0);
  await expect(amount).toBeFocused();
  await expect(amount).not.toHaveAttribute("data-test-focus-lost", "true");

  await sections.click();
  await jump.click();
  await expect(menu).toHaveAttribute("data-closed", "");
  const timeBase = page.getByRole("combobox", { name: "Time base 1" });
  await openSelect(timeBase);
  await expect(menu).toHaveCount(0);
  await expect(timeBase).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("option", { name: "year", exact: true }).click();
  await expect(timeBase.locator("[data-slot=select-value]")).toHaveText("year");

  await sections.click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(sections).toBeFocused();
  expect(errors).toEqual([]);
});

test("actual offer terms, decisions and corrections through Job Detail", async ({
  page,
}) => {
  test.setTimeout(90000);
  const db = new Database(loadE2eDbPath());
  db.prepare(
    "INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,'https://synthetic.example/offer-qa','Offer workflow QA','Synthetic Employer')",
  ).run(JOB);
  db.close();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/jobs/${JOB}`);
  await expect(page).toHaveTitle(/JobCtrl/);
  await expect(page).toHaveURL(new RegExp(`/jobs/${JOB}(?:[?]|$)`));
  const panel = await openOutcomes(page);
  await expect(
    panel.getByText("No actual offer terms recorded."),
  ).toBeVisible();
  await panel.getByText("Record actual offer terms", { exact: true }).click();
  await panel.getByLabel("Amount 1", { exact: true }).fill("90000");
  await panel
    .getByLabel("Currency 1 (three-letter code; blank if unknown)")
    .fill("EUR");
  await openSelect(panel.getByRole("combobox", { name: "Time base 1" }));
  await page.getByRole("option", { name: "year", exact: true }).click();
  await panel
    .getByLabel("Offer source reference")
    .fill("Synthetic offer letter");
  await panel
    .getByLabel("Verbatim offer source quote")
    .fill(
      "Base EUR 90000 per year. Equity, benefits and deadline are unconfirmed.",
    );
  await panel
    .getByRole("checkbox", {
      name: "I confirm these are actual offered terms supported by this source.",
    })
    .check();
  await panel
    .getByRole("button", { name: "Save confirmed offer terms" })
    .click();
  await expect(
    panel.getByText("Equity: Unknown", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    panel.getByText("Benefits: Unknown", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    panel.getByText("Decision deadline: Unknown", { exact: true }).first(),
  ).toBeVisible();
  await panel.getByText("Record offer decision", { exact: true }).click();
  await panel
    .getByLabel("Decision source reference")
    .fill("Synthetic user attestation");
  await panel
    .getByLabel("Decision evidence or your attestation")
    .fill("I accepted these exact terms.");
  await panel
    .getByRole("checkbox", {
      name: "I attest to this offer decision on the current terms.",
    })
    .check();
  await panel.getByRole("button", { name: "Save offer decision" }).click();
  await expect(
    panel.getByText("Offer decision: accepted", { exact: true }),
  ).toBeVisible();
  // Saving retains the open form and its draft until an explicit review.
  // Clicking the renamed summary would close the preserved decision form.
  await expect(
    panel.getByRole("combobox", { name: "Offer decision", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Save offer decision" }),
  ).toBeDisabled();
  await openSelect(
    panel.getByRole("combobox", { name: "Offer decision", exact: true }),
  );
  await page.getByRole("option", { name: "declined", exact: true }).click();
  await panel
    .getByLabel("Decision source reference")
    .fill("Synthetic correction");
  await panel
    .getByLabel("Decision evidence or your attestation")
    .fill(
      "I declined these exact terms. The earlier attestation was incorrect.",
    );
  await panel
    .getByLabel("Decision correction reason")
    .fill("Corrected the synthetic decision");
  await panel
    .getByRole("button", {
      name: "Keep draft and review latest offer",
      exact: true,
    })
    .click();
  await expect(
    panel.getByText(
      "Review your retained draft against the latest offer and attest again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("combobox", { name: "Offer decision", exact: true })
      .locator("[data-slot=select-value]"),
  ).toHaveText("declined");
  await expect(panel.getByLabel("Decision source reference")).toHaveValue(
    "Synthetic correction",
  );
  await expect(panel.getByLabel("Decision evidence or your attestation")).toHaveValue(
    "I declined these exact terms. The earlier attestation was incorrect.",
  );
  await expect(panel.getByLabel("Decision correction reason")).toHaveValue(
    "Corrected the synthetic decision",
  );
  await expect(
    panel.getByRole("checkbox", {
      name: "I attest to this offer decision on the current terms.",
    }),
  ).not.toBeChecked();
  await panel
    .getByRole("checkbox", {
      name: "I attest to this offer decision on the current terms.",
    })
    .check();
  await panel.getByRole("button", { name: "Save offer decision" }).click();
  await expect(
    panel.getByText("Offer decision: declined", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openOutcomes(page);
  await expect(
    panel.getByText("Offer decision: declined", { exact: true }),
  ).toBeVisible();
  await panel.getByText("Offer history", { exact: true }).click();
  await expect(
    panel.getByText(/Corrected the synthetic decision/),
  ).toBeVisible();
  await panel.getByText("Offer history", { exact: true }).click();
  await page.getByText("Draft an offer communication", { exact: true }).click();
  await expect(
    page.getByText(
      "Link a confirmed contact in this job’s Contacts section to draft a message.",
    ),
  ).toBeVisible();
  const contactResponse = await page.evaluate(async (jobId) => {
    const response = await fetch("/v1/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        employer: "Synthetic Employer",
        role: "recruiter",
        attributes: [{ kind: "name", value: "Synthetic Offer Recruiter" }],
      }),
    });
    return { status: response.status, body: await response.json() };
  }, JOB);
  expect(contactResponse.status).toBe(200);
  await page.reload();
  await openOutcomes(page);
  await page.getByText("Draft an offer communication", { exact: true }).click();
  await openSelect(
    page.getByRole("combobox", { name: "Offer recipient", exact: true }),
  );
  await page
    .getByRole("option", { name: "Synthetic Offer Recruiter", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Generate offer draft", exact: true }),
  ).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await injectAxe(page);
  await checkA11y(page, 'section[aria-label="Offer terms and decisions"]', {
    axeOptions: {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    },
  });
  const screenshotRoot = process.env["JOBCTRL_OFFER_QA_SCREENSHOTS"];
  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotRoot, "offer-desktop.png"),
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(
    panel.getByText("Offer decision: declined", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (screenshotRoot)
    await page.screenshot({
      path: path.join(screenshotRoot, "offer-mobile.png"),
    });
  expect(errors).toEqual([]);
  const verify = new Database(loadE2eDbPath());
  const history = verify
    .prepare(
      "SELECT payload_json FROM job_events WHERE tenant_id='local' AND job_id=? AND entity_kind='offer' ORDER BY event_id",
    )
    .all(JOB) as { payload_json: string }[];
  expect(history).toHaveLength(3);
  expect(
    history
      .slice(1)
      .map((row) => JSON.parse(row.payload_json).decision.decision),
  ).toEqual(["accepted", "declined"]);
  expect(
    verify
      .prepare(
        "SELECT COUNT(*) count FROM application_review_decisions WHERE tenant_id='local' AND job_id=?",
      )
      .get(JOB),
  ).toEqual({ count: 0 });
  expect(
    verify
      .prepare(
        "SELECT COUNT(*) count FROM job_stage_states WHERE tenant_id='local' AND job_id=?",
      )
      .get(JOB),
  ).toEqual({ count: 0 });
  verify.close();
});
