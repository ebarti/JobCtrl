import { describe, expect, it } from "vitest";

import {
  formatProfileDateRange,
  formatProfileMonth,
  parseProfileDateRange,
  parseProfileMonth,
} from "./profile-date-fields.js";

describe("profile date field helpers", () => {
  it("parses and formats month names used by profile date ranges", () => {
    expect(parseProfileMonth("Mar 2024")).toEqual({ month: "03", year: "2024" });
    expect(parseProfileMonth("2024-03")).toEqual({ month: "03", year: "2024" });
    expect(formatProfileMonth({ month: "06", year: "2013" })).toBe("Jun 2013");
  });

  it("parses and formats current role ranges", () => {
    const parsed = parseProfileDateRange("Mar 2024 -- Present");

    expect(parsed).toEqual({
      start: { month: "03", year: "2024" },
      end: { month: "", year: "" },
      present: true,
    });
    expect(formatProfileDateRange(parsed)).toBe("Mar 2024 -- Present");
  });

  it("parses compact year ranges without opening native date pickers", () => {
    const parsed = parseProfileDateRange("2022-2025");

    expect(parsed).toEqual({
      start: { month: "", year: "2022" },
      end: { month: "", year: "2025" },
      present: false,
    });
    expect(formatProfileDateRange(parsed)).toBe("2022 -- 2025");
  });
});
