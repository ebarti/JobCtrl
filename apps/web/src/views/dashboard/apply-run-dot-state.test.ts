import { describe, expect, it } from "vitest";

import { applyRunDotState } from "./apply-run-dot-state.js";

describe("applyRunDotState", () => {
  it.each([
    ["starting", "running"],
    ["in_progress", "running"],
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["expired", "failed"],
    ["terminated", "failed"],
    ["timed_out", "failed"],
    ["captcha", "blocked"],
    ["login_issue", "blocked"],
    ["manual", "blocked"],
    ["dry_run_complete", "skipped"],
    ["canceled", "canceled"],
    ["finished", "succeeded"],
    ["unknown-status", "running"],
  ] as const)("maps %s to %s", (status, dotState) => {
    expect(applyRunDotState(status)).toBe(dotState);
  });
});
