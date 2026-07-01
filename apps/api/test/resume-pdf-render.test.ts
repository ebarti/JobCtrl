import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "node:child_process";

import { defaultResumeHtmlPdfRenderer } from "../src/resume-pdf-render.js";

const execFileSyncMock = vi.mocked(execFileSync);

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe("defaultResumeHtmlPdfRenderer", () => {
  it("bounds the synchronous render subprocess with a timeout and generous maxBuffer", () => {
    execFileSyncMock.mockReturnValue(Buffer.from(""));

    defaultResumeHtmlPdfRenderer({ htmlPath: "/tmp/resume.html", pdfPath: "/tmp/resume.pdf" });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const options = execFileSyncMock.mock.calls[0]![2] as { timeout?: number; maxBuffer?: number };
    expect(options.timeout).toBe(120_000);
    expect(options.maxBuffer).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it("surfaces a subprocess timeout as a render failure the persist path can catch", () => {
    const timeoutError = Object.assign(new Error("spawnSync uv ETIMEDOUT"), {
      code: "ETIMEDOUT",
      killed: true,
      stderr: Buffer.from(""),
    });
    execFileSyncMock.mockImplementation(() => {
      throw timeoutError;
    });

    expect(() =>
      defaultResumeHtmlPdfRenderer({ htmlPath: "/tmp/resume.html", pdfPath: "/tmp/resume.pdf" }),
    ).toThrow(/Resume HTML-to-PDF render failed/);
  });
});
