import { describe, expect, it } from "vitest";

import { detectSupportedAts } from "./ats";

describe("supported ATS detection", () => {
  it.each([
    ["https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/1", "workday"],
    ["https://boards.greenhouse.io/acme/jobs/1", "greenhouse"],
    ["https://jobs.lever.co/acme/1", "lever"],
    ["https://jobs.ashbyhq.com/acme/1", "ashby"],
  ])("detects %s", (url, expected) => {
    expect(detectSupportedAts(url)).toBe(expected);
  });

  it("rejects unsupported hosts", () => {
    expect(detectSupportedAts("https://example.com/jobs/1")).toBeNull();
  });
});
