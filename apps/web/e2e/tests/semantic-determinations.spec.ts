import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";
import {
  recordModelDecision,
  recordOutcomeDecision,
  seedSyntheticCompensation,
} from "../../../api/test/semantic-fixtures.js";

// The provider is an explicit model double. This verifies persistence/read/UI
// wiring; the chosen judgments are not a language classification corpus.
test("Discovery exposes every model verdict and unavailable pending listing with its receipt", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const db = new Database(loadE2eDbPath());
  const ids: string[] = [];
  try {
    for (const [index, status] of [
      "admit",
      "reject",
      "pending_triage",
    ].entries()) {
      const listing = {
        listing_id: `product-listing-${index}`,
        source_id: "synthetic-board",
        url: `https://example.org/owned/${index}`,
        title: `Owned listing ${index}`,
        company: "Synthetic employer",
        location: "Synthetic place",
        remote: null,
      };
      const receipt =
        status === "pending_triage"
          ? null
          : recordModelDecision(db, "posting_triage", "discovery:intake", {
              listings: [
                {
                  listing_id: listing.listing_id,
                  verdict: status,
                  reason_code:
                    status === "admit" ? "compatible" : "role_mismatch",
                  citations: [
                    {
                      source_id: `listing:${listing.listing_id}:title`,
                      quote: listing.title,
                      exact_values: [],
                    },
                  ],
                  rationale: "Explicit model admission decision",
                },
              ],
            });
      if (receipt) ids.push(receipt);
      db.prepare(
        "INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,status,reason_code,failure_code,determination_id,created_at) VALUES ('local',?,?,?,?,?,?,?,?,?,?)",
      ).run(
        listing.listing_id,
        String(index).repeat(64),
        "d".repeat(64),
        listing.source_id,
        JSON.stringify({
          listing,
          target_sources: [
            { source_id: "target:roles:0", text: "Synthetic saved target" },
          ],
          profile_version: 1,
        }),
        status,
        status === "admit"
          ? "compatible"
          : status === "reject"
            ? "role_mismatch"
            : null,
        status === "pending_triage" ? "provider_unavailable" : null,
        receipt,
        new Date().toISOString(),
      );
    }
  } finally {
    db.close();
  }
  const response = await page.request.get("/v1/discovery/triage");
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  expect(
    body.rows
      .filter((row: { listingId: string }) =>
        row.listingId.startsWith("product-listing-"),
      )
      .map((row: { status: string }) => row.status)
      .sort(),
  ).toEqual(["admit", "pending_triage", "reject"]);
  await page.goto("/discovery");
  await expect(page).toHaveTitle(/JobCtrl.*Discovery/);
  await expect(
    page.getByRole("button", { name: "Confirm this interpretation" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Listing decisions", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("admit: compatible", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("reject: role mismatch", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/pending triage.*provider unavailable/),
  ).toBeVisible();
  const listing = page.locator("li").filter({
    has: page.getByRole("link", { name: "Owned listing 0", exact: true }),
  });
  await listing.getByText("Decision sources", { exact: true }).click();
  await expect(listing.getByText(/posting-triage-v3-saved-targets/)).toBeVisible();
  await expect(
    listing.getByText(/listing:product-listing-0:title/),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("discovery-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText(/pending triage.*provider unavailable/),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("discovery-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Apply Review reads recorded line anchors and verification receipts", async ({
  page,
}, testInfo) => {
  const response = await page.request.get(`/v1/jobs/${QA_PLATFORM_JOB_ID}`);
  expect(response.status(), await response.text()).toBe(200);
  const job = await response.json();
  expect(job).toBeTruthy();
  const artifactResponse = await page.request.get(
    "/v1/artifacts/qa-platform-resume-text",
  );
  expect(artifactResponse.status(), await artifactResponse.text()).toBe(200);
  const artifact = await artifactResponse.json();
  expect(artifact.tailoringExplanation.bulletProvenance).toContainEqual(
    expect.objectContaining({
      bulletId: "summary",
      evidenceIds: ["ev-platform"],
      requirementIds: ["r1"],
    }),
  );
  expect(
    artifact.tailoringExplanation.determinations
      .map((receipt: { kind: string }) => receipt.kind)
      .sort(),
  ).toEqual(["artifact_quality", "claim_verification"]);
  await page.goto("/apply-review");
  await expect(
    page.getByRole("heading", { name: "Application review" }).first(),
  ).toBeVisible();
  await expect(page.locator(".apply-review-selected")).toBeVisible();
  await expect(
    page.locator("[data-resume-layout-target='summary']").first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("apply-review.png"),
    fullPage: true,
  });
});

test("Compensation displays only rows with persisted matching taxonomy classifications", async ({
  page,
}, testInfo) => {
  const db = new Database(loadE2eDbPath());
  try {
    seedSyntheticCompensation(db, QA_PLATFORM_JOB_ID);
  } finally {
    db.close();
  }
  const response = await page.request.get(
    `/v1/jobs/${QA_PLATFORM_JOB_ID}/compensation/market`,
  );
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const classification = body.estimate.determinations.find(
    (receipt: { kind: string }) => receipt.kind === "benchmark_classification",
  );
  const interpretation = body.estimate.determinations.find(
    (receipt: { kind: string }) => receipt.kind === "job_interpretation",
  );
  expect(body.estimate.evidence[0].determinationId).toBe(
    classification.determination_id,
  );
  expect(classification.result.occupation_family.value).toBe(
    interpretation.result.occupation_family.value,
  );
  expect(classification.result.seniority.value).toBe(
    interpretation.result.seniority.value,
  );
  expect(classification.result.places[0].country_code).toBe(
    interpretation.result.places[0].country_code,
  );
  await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
  const section = page.getByRole("region", {
    name: "Compensation evidence",
    exact: true,
  });
  await expect(section).toBeVisible();
  await section.getByText("Classification sources", { exact: true }).click();
  const receipt = section
    .locator("details")
    .filter({
      has: page.getByText("job interpretation · synthetic · synthetic", {
        exact: true,
      }),
    })
    .last();
  await receipt.locator("summary").first().click();
  await expect(section.getByText(/job-interpretation-v1.*input/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("compensation.png"),
    fullPage: true,
  });
});

test("Gmail shows the model's quoted outcome and an actionable unavailable refresh", async ({
  page,
}, testInfo) => {
  const quote = "Please choose a time for the interview.";
  const db = new Database(loadE2eDbPath());
  try {
    db.prepare(
      `INSERT INTO application_email_evidence (
      tenant_id,evidence_id,job_id,provider,provider_message_id,provider_thread_id,
      from_address,to_addresses_json,subject,snippet,received_at,linked_at,link_confidence,link_signals_json,body_text
    ) VALUES ('local','owned-email',?,'gmail','owned-message','owned-thread',
      'recruiting@example.org','["candidate@example.org"]','Owned synthetic application',?, ?, ?,0.9,'[]',?)`,
    ).run(
      QA_PLATFORM_JOB_ID,
      quote,
      new Date().toISOString(),
      new Date().toISOString(),
      quote,
    );
    db.prepare(
      `INSERT INTO application_outcome_suggestions (
      tenant_id,suggestion_id,job_id,evidence_id,suggested_kind,confidence,rationale,status,created_at
    ) VALUES ('local','owned-suggestion',?,'owned-email','interview',0.9,'Explicit model outcome','pending',?)`,
    ).run(QA_PLATFORM_JOB_ID, new Date().toISOString());
    recordOutcomeDecision(
      db,
      "owned-suggestion",
      "owned-message",
      "interview",
      0.9,
      quote,
    );
  } finally {
    db.close();
  }
  const response = await page.request.get(
    `/v1/jobs/${QA_PLATFORM_JOB_ID}/outcomes`,
  );
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  expect(body.interpretationStatus.status).toBe("available");
  expect(body.suggestions[0].citations[0]).toMatchObject({
    source_id: "message",
    quote,
  });
  await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
  await expect(
    page.locator("blockquote").filter({ hasText: quote }),
  ).toBeVisible();
  await expect(page.getByText(/message-outcome-v1/)).toBeVisible();
  const failed = new Database(loadE2eDbPath());
  try {
    failed
      .prepare(
        "INSERT INTO semantic_stage_states VALUES ('local','owned-message','message_outcome',?,'blocked','provider_unavailable',NULL,?)",
      )
      .run("f".repeat(64), new Date().toISOString());
  } finally {
    failed.close();
  }
  await page.reload();
  await expect(
    page.getByRole("status").filter({
      hasText: /Email outcome interpretation unavailable: provider_unavailable/,
    }),
  ).toBeVisible();
  await expect(
    page.locator("blockquote").filter({ hasText: quote }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("gmail.png"),
    fullPage: true,
  });
});
