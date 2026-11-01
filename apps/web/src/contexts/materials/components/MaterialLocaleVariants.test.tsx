import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildProviderHarness } from "../../../test/render.js";
import { MaterialLocalePanel, MaterialLocaleVariants } from "./MaterialLocaleVariants.js";
import { sampleLocaleHistory } from "./MaterialLocaleVariants.stories.js";

const JOB = "90000000-0000-4000-8000-000000000039";
describe("reviewed locale variants", () => {
  it("requires independent review and sends version-fenced decisions", () => {
    const onRequest = vi.fn();
    render(<MaterialLocalePanel history={sampleLocaleHistory()} pending={false} onRequest={onRequest} onExport={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept locale revision" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve terminology" }));
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ operation: "review", dimension: "terminology", expectedVersion: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Reject formatting" }));
    expect(onRequest).toHaveBeenLastCalledWith(expect.objectContaining({ dimension: "formatting", decision: "rejected" }));
    fireEvent.click(screen.getByText("Recorded verification sources"));
    expect(screen.getByText("Explicit synthetic verdict")).toBeVisible();
  });
  it("shows both source and accepted translated content and offers all formats", () => {
    const onExport = vi.fn();
    render(<MaterialLocalePanel history={sampleLocaleHistory(true)} pending={false} onRequest={vi.fn()} onExport={onExport} />);
    expect(screen.getByText("Original accepted source")).toBeVisible();
    expect(screen.getByText("Translated descriptions")).toBeVisible();
    for (const format of ["TXT", "HTML", "PDF", "DOCX"]) fireEvent.click(screen.getByRole("button", { name: `Export ${format}` }));
    expect(onExport.mock.calls.map(call => call[0].format)).toEqual(["txt", "html", "pdf", "docx"]);
  });
  it("retains accepted history during a failed refresh and stale review", async () => {
    const previous = sampleLocaleHistory(true);
    const base = buildProviderHarness();
    const api = Object.assign(Object.create(Object.getPrototypeOf(base.ports.api)), base.ports.api, {
      materialLocaleVariants: vi.fn(async (_jobId, request) => {
        if (request.operation !== "history") throw new Error("stale_locale_source");
        return previous;
      }),
    });
    const harness = buildProviderHarness({ ports: { ...base.ports, api } });
    render(<MaterialLocaleVariants jobId={JOB} />, { wrapper: harness.Wrapper });
    await screen.findByRole("button", { name: "Export TXT" });
    fireEvent.click(screen.getByRole("button", { name: "Generate locale variant" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Export TXT" })).toBeVisible();
    expect(screen.getAllByText(/Synthetic Name · Historical Title/)).toHaveLength(2);
    await waitFor(() => expect(api.materialLocaleVariants).toHaveBeenCalledWith(JOB, expect.objectContaining({ operation: "generate", expectedGeneration: 1, expectedProfileVersion: 1 })));
  });
  it("reports unavailable history without offering unbound generation or claiming it is still loading", async () => {
    const base = buildProviderHarness();
    const api = Object.assign(Object.create(Object.getPrototypeOf(base.ports.api)), base.ports.api, {
      materialLocaleVariants: vi.fn(async () => { throw new Error("locale_worker_unavailable"); }),
    });
    const harness = buildProviderHarness({ ports: { ...base.ports, api } });
    render(<MaterialLocaleVariants jobId={JOB} />, { wrapper: harness.Wrapper });
    await screen.findByRole("alert");
    expect(screen.queryByText("Loading locale history…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate locale variant" })).not.toBeInTheDocument();
  });
});
