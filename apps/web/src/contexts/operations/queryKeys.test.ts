import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { describe, expect, it } from "vitest";

import { applyRunsKeys } from "./applyRunsKeys.js";
import { applyReviewKeys } from "./applyReviewKeys.js";
import { activityKeys } from "./activityKeys.js";
import { analyticsKeys } from "./analyticsKeys.js";
import { artifactsKeys } from "./artifactsKeys.js";
import { dashboardKeys } from "./dashboardKeys.js";
import { healthKeys } from "./healthKeys.js";
import { jobsKeys } from "./jobsKeys.js";
import { outcomesKeys } from "./outcomesKeys.js";

describe("operations queryKeys", () => {
  it("scopes every jobs key under tenant + jobs prefix", () => {
    expect(jobsKeys.all(LOCAL_TENANT)).toEqual(["tenant", LOCAL_TENANT, "jobs"]);
    expect(jobsKeys.lists(LOCAL_TENANT)).toEqual(["tenant", LOCAL_TENANT, "jobs", "list"]);
    expect(jobsKeys.list(LOCAL_TENANT, { page: 2, deleted: "active" })).toEqual([
      "tenant",
      LOCAL_TENANT,
      "jobs",
      "list",
      { page: 2, deleted: "active" },
    ]);
    expect(jobsKeys.details(LOCAL_TENANT)).toEqual(["tenant", LOCAL_TENANT, "jobs", "detail"]);
    expect(jobsKeys.detail(LOCAL_TENANT, "job-1")).toEqual([
      "tenant",
      LOCAL_TENANT,
      "jobs",
      "detail",
      "job-1",
    ]);
  });

  it("scopes dashboard keys under tenant + dashboard prefix", () => {
    expect(dashboardKeys.summary(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "dashboard",
      "summary",
    ]);
  });

  it("scopes outcome analytics keys under tenant + analytics prefix", () => {
    expect(analyticsKeys.outcomes(LOCAL_TENANT, { dimension: "fit_band" })).toEqual([
      "tenant",
      LOCAL_TENANT,
      "analytics",
      "outcomes",
      { dimension: "fit_band" },
    ]);
  });

  it("scopes activity keys under tenant + activity prefix", () => {
    expect(activityKeys.lists(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "activity",
      "list",
    ]);
    expect(activityKeys.list(LOCAL_TENANT, { page: 2 })).toEqual([
      "tenant",
      LOCAL_TENANT,
      "activity",
      "list",
      { page: 2 },
    ]);
  });

  it("scopes artifacts keys under tenant + artifacts prefix", () => {
    expect(artifactsKeys.lists(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "artifacts",
      "list",
    ]);
    expect(artifactsKeys.detail(LOCAL_TENANT, "artifact-7")).toEqual([
      "tenant",
      LOCAL_TENANT,
      "artifacts",
      "detail",
      "artifact-7",
    ]);
  });

  it("scopes apply-run keys under tenant + applyRuns prefix", () => {
    expect(applyRunsKeys.lists(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "applyRuns",
      "list",
    ]);
    expect(applyRunsKeys.detail(LOCAL_TENANT, "run-abc")).toEqual([
      "tenant",
      LOCAL_TENANT,
      "applyRuns",
      "detail",
      "run-abc",
    ]);
  });

  it("scopes apply-review keys under tenant + apply-review prefix", () => {
    expect(applyReviewKeys.queue(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "apply-review",
      "queue",
    ]);
  });

  it("scopes outcome keys under tenant + outcomes prefix", () => {
    expect(outcomesKeys.list(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "outcomes",
      "list",
      "global",
    ]);
    expect(outcomesKeys.detail(LOCAL_TENANT, "job-1")).toEqual([
      "tenant",
      LOCAL_TENANT,
      "outcomes",
      "job",
      "job-1",
    ]);
  });

  it("scopes health keys under tenant + health prefix", () => {
    expect(healthKeys.live(LOCAL_TENANT)).toEqual([
      "tenant",
      LOCAL_TENANT,
      "health",
      "live",
    ]);
  });

  it("returns referentially-different arrays per call", () => {
    const a = jobsKeys.lists(LOCAL_TENANT);
    const b = jobsKeys.lists(LOCAL_TENANT);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
