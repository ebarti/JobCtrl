import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchExtensionContext } from "./chromium-extension-test-context.js";

afterEach(() => vi.restoreAllMocks());

describe("required extension browser launch", () => {
  it.each([
    "Missing X server",
    "no DISPLAY",
    "Host system is missing dependencies",
    "Unexpected Chromium crash",
  ])("fails the check when launch reports %s", async (message) => {
    const failure = new Error(message);
    vi.spyOn(chromium, "launchPersistentContext").mockRejectedValue(failure);
    await expect(
      launchExtensionContext("synthetic-unused-profile"),
    ).rejects.toBe(failure);
  });
});
