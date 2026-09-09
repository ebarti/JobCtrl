import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchFailureFromStageMetadata, parseFetchFailure } from "../src/fetch-failure.js";

const cases = JSON.parse(fs.readFileSync(new URL(
  "../../../packages/domain-types/test/fixtures/public_fetch_failure.json", import.meta.url,
), "utf8")) as Array<{ name: string; metadata: unknown; expected: unknown }>;

describe("safe public-fetch diagnostics across both projection writers", () => {
  it.each(cases)("$name", ({ metadata, expected }) => {
    const result = fetchFailureFromStageMetadata(JSON.stringify(metadata));
    expect(result).toEqual(expected);
    expect(parseFetchFailure(result)).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("must-not-project");
  });

  it.each([null, "{", "null", "[]"])("ignores malformed metadata %s", (value) => {
    expect(fetchFailureFromStageMetadata(value)).toBeNull();
  });
});
