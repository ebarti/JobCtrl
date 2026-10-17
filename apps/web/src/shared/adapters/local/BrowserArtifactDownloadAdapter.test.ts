import { afterEach, expect, it, vi } from "vitest";
import { BrowserArtifactDownloadAdapter } from "./BrowserArtifactDownloadAdapter.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("downloads validated bytes through the browser port and releases its temporary URL", async () => {
  vi.useFakeTimers();
  const blob = new Blob(["owned bytes"]);
  const createObjectURL = vi.fn(() => "blob:owned");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("resume-g1-A4.docx");
      expect(this.href).toBe("blob:owned");
    });
  const api = { downloadMaterialDocx: vi.fn(async () => blob) };
  await new BrowserArtifactDownloadAdapter(api).downloadDocx(
    "12",
    "resume-g1-A4.docx",
  );
  expect(api.downloadMaterialDocx).toHaveBeenCalledWith("12");
  expect(createObjectURL).toHaveBeenCalledWith(blob);
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector("a[download]")).toBeNull();
  await vi.runAllTimersAsync();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:owned");
});
it("does not claim or start a download after an API failure", async () => {
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const adapter = new BrowserArtifactDownloadAdapter({
    downloadMaterialDocx: async () => {
      throw new Error("file missing");
    },
  });
  await expect(adapter.downloadDocx("12", "resume.docx")).rejects.toThrow(
    "file missing",
  );
  expect(click).not.toHaveBeenCalled();
});
