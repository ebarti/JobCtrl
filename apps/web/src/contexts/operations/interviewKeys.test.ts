import { describe, expect, it } from "vitest";
import type { TenantId } from "@jobctrl/domain-types";
import { interviewKeys } from "./interviewKeys.js";

const tenant = "tenant-a" as TenantId;
describe("interview query ownership", () => {
  it("keeps global catalog and private job notes in tenant-first independent branches", () => {
    expect(interviewKeys.catalog(tenant)).toEqual(["tenant", tenant, "interviews", "catalog"]);
    expect(interviewKeys.note(tenant, "job-a", "B11")).toEqual(["tenant", tenant, "interviews", "job", "job-a", "notes", "B11"]);
    expect(interviewKeys.history(tenant, "job-a")).toEqual(["tenant", tenant, "interviews", "job", "job-a", "history"]);
    expect(interviewKeys.note("tenant-b" as TenantId, "job-a", "B11")).not.toEqual(interviewKeys.note(tenant, "job-a", "B11"));
  });
});
