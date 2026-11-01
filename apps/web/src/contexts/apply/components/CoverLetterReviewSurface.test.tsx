import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { COVER_LETTER_RENDERER_VERSION, DEFAULT_COVER_LETTER_SETTINGS, type CoverLetterRenderRequest, type ApplyReviewQueueItem, type CoverLetterPreview } from "@jobctrl/contracts";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { sampleApplyReviewQueue } from "../../../test/fixtures/projections.js";
import { useCoverLetterReview } from "../hooks/useCoverLetterReview.js";
import { CoverLetterReviewSurface } from "./CoverLetterReviewSurface.js";

vi.mock("../../../shared/ui/PdfPreviewViewer.js", () => ({ PdfPreviewViewer: ({ url, title }: { url: string; title: string }) => <img src={url} alt={title} /> }));
const accepted = {
  source: { tenantId: "local", jobId: sampleApplyReviewQueue.items[0]!.jobKey, artifactId: "cover-source", generation: 1, textSha256: "a".repeat(64) },
  acceptedVersion: "b".repeat(64), pdfArtifactId: "accepted-cover", pdfSha256: "c".repeat(64), pdfSourceCurrent: true,
  settings: DEFAULT_COVER_LETTER_SETTINGS, rendererVersion: COVER_LETTER_RENDERER_VERSION,
};
function Surface({ item }: { item: ApplyReviewQueueItem }) { return <CoverLetterReviewSurface review={useCoverLetterReview(item)} />; }
describe("cover-letter formatting surface", () => {
  it("labels bounded controls and uses the same URL for preview and download; saves explicitly", async () => {
    const render = vi.fn(async (_job: string, body: CoverLetterRenderRequest): Promise<{ok:true;preview:CoverLetterPreview}> => ({ ok: true as const,
      preview: { ...body, previewId: "00000000-0000-4000-8000-000000001042", rendererVersion: COVER_LETTER_RENDERER_VERSION, pdfSha256: "d".repeat(64) } }));
    const save = vi.fn(async () => ({ ok: true as const, accepted: { ...accepted, settings: { ...accepted.settings, fontSizePt: 12 }, pdfSha256: "d".repeat(64), acceptedVersion: "e".repeat(64) } }));
    const ports = buildTestPorts({ api: { renderCoverLetterPreview: render, acceptCoverLetterPreview: save } });
    renderWithProviders(<Surface item={{ ...sampleApplyReviewQueue.items[0]!, materialsPreview: { ...sampleApplyReviewQueue.items[0]!.materialsPreview, coverLetter: accepted } }} />, { ports });
    expect(screen.getByLabelText("Font size (pt)")).toHaveAttribute("min", "9");
    expect(screen.getByLabelText("Margins (mm)")).toHaveAttribute("max", "28");
    expect(screen.getByRole("combobox", { name: "Paper size" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Font family" })).toBeVisible();
    expect(render).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Font size (pt)"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview cover-letter PDF" }));
    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save cover-letter PDF" })).toBeEnabled());
    const link = screen.getByRole("link", { name: "Download displayed cover-letter PDF" });
    expect(link.getAttribute("href")).toBe(screen.getByRole("img", { name: "Cover-letter PDF preview" }).getAttribute("src"));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save cover-letter PDF" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Font size (pt)")).toHaveValue(12);
  });
});
