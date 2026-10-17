import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { server } from "../../../test/msw/server.js";
import { buildProviderHarness } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  exportJobId,
  sampleDocxReceipt,
  sampleMaterialExports,
} from "../../../test/fixtures/material-exports.js";
import { materialsKeys } from "../queryKeys.js";
import {
  AcceptedMaterialExports,
  AcceptedMaterialExportPanel,
} from "./AcceptedMaterialExports.js";

const route = `*/v1/jobs/${exportJobId}/material-exports`;
describe("accepted original DOCX UI", () => {
  it("sends the selected paper and exact accepted source/version/digests", () => {
    const onExport = vi.fn();
    render(
      <AcceptedMaterialExportPanel
        history={sampleMaterialExports()}
        pending={false}
        onExport={onExport}
        onDownload={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Letter" }));
    fireEvent.click(screen.getByRole("button", { name: "Export resume DOCX" }));
    expect(onExport).toHaveBeenCalledWith({
      operation: "export",
      sourceArtifactId: "accepted-resume",
      expectedGeneration: 1,
      expectedSourceSha256: "a".repeat(64),
      expectedMetadataSha256: "b".repeat(64),
      paper: "Letter",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Export cover letter DOCX" }),
    );
    expect(onExport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceArtifactId: "accepted-cover",
        expectedSourceSha256: "e".repeat(64),
        paper: "Letter",
      }),
    );
  });
  it("does not offer unbound exports and disables missing or stale sources", () => {
    const history = sampleMaterialExports();
    history.sources[0]!.sha256 = null;
    history.sources[0]!.unavailableReason =
      "source_bytes_or_metadata_unavailable";
    const view = render(
      <AcceptedMaterialExportPanel
        history={history}
        pending={false}
        onExport={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Export resume DOCX" }),
    ).toBeDisabled();
    view.rerender(
      <AcceptedMaterialExportPanel
        history={history}
        pending={false}
        sourceUnavailable
        onExport={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Export cover letter DOCX" }),
    ).toBeDisabled();
    view.rerender(
      <AcceptedMaterialExportPanel
        history={{ ...history, sources: [] }}
        pending={false}
        onExport={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(
      screen.getByText("No accepted text materials to export."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Export resume DOCX" }),
    ).not.toBeInTheDocument();
  });
  it("retains a successful export when the browser download fails and retries only the download", async () => {
    let history = sampleMaterialExports();
    const commands: unknown[] = [];
    server.use(
      http.post(route, async ({ request }) => {
        const body = (await request.json()) as { operation: string };
        if (body.operation === "export") {
          commands.push(body);
          history = {
            ...history,
            exports: [sampleDocxReceipt],
            exportedArtifactId: sampleDocxReceipt.artifactId,
          };
          return HttpResponse.json(history);
        }
        return HttpResponse.json({ ...history, exportedArtifactId: null });
      }),
    );
    const downloadDocx = vi
      .fn()
      .mockRejectedValueOnce(new Error("download offline"))
      .mockResolvedValue(undefined);
    const harness = buildProviderHarness({
      ports: buildTestPorts({ artifactDownload: { downloadDocx } }),
    });
    render(<AcceptedMaterialExports jobId={exportJobId} />, {
      wrapper: harness.Wrapper,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Export resume DOCX" }),
    );
    await screen.findByText("Download failed");
    expect(screen.getByRole("button", { name: "Download DOCX" })).toBeEnabled();
    expect(
      harness.queryClient.getQueryData(
        materialsKeys.exports(LOCAL_TENANT, exportJobId),
      ),
    ).toMatchObject({ exports: [sampleDocxReceipt] });
    fireEvent.click(screen.getByRole("button", { name: "Download DOCX" }));
    await screen.findByText(
      "Download started. A retained copy remains available below.",
    );
    expect(downloadDocx).toHaveBeenCalledTimes(2);
    expect(downloadDocx).toHaveBeenLastCalledWith("1030", "resume-g1-A4.docx");
    expect(commands).toHaveLength(1);
  });
  it("retains earlier exports on a stale export refusal and a failed history refresh", async () => {
    let failHistory = false;
    server.use(
      http.post(route, async ({ request }) => {
        const body = (await request.json()) as { operation: string };
        if (body.operation === "export") {
          failHistory = true;
          return HttpResponse.json(
            { ok: false, error: "stale_export_source" },
            { status: 409 },
          );
        }
        if (failHistory)
          return HttpResponse.json(
            { ok: false, error: "export_worker_unavailable" },
            { status: 503 },
          );
        return HttpResponse.json(sampleMaterialExports(true));
      }),
    );
    const harness = buildProviderHarness();
    render(<AcceptedMaterialExports jobId={exportJobId} />, {
      wrapper: harness.Wrapper,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Export resume DOCX" }),
    );
    await screen.findByText("DOCX export failed");
    await screen.findByText("Export list unavailable");
    expect(screen.getByText(/The accepted source changed/)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Download DOCX" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByRole("button", { name: "Export resume DOCX" }),
    ).toBeDisabled();
    expect(
      harness.queryClient.getQueryData(
        materialsKeys.exports(LOCAL_TENANT, exportJobId),
      ),
    ).toEqual(sampleMaterialExports(true));
  });
  it("explains demo unavailability without calling the local worker", () => {
    const ports = buildTestPorts();
    const history = vi.spyOn(ports.api, "acceptedMaterialExports");
    ports.featureFlags = {
      get: (_key, fallback) =>
        typeof fallback === "boolean" ? (true as typeof fallback) : fallback,
    };
    const harness = buildProviderHarness({ ports });
    render(<AcceptedMaterialExports jobId={exportJobId} />, {
      wrapper: harness.Wrapper,
    });
    expect(
      screen.getByText(
        "DOCX export requires accepted materials saved in your local workspace.",
      ),
    ).toBeVisible();
    expect(history).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "has no critical or serious accessibility violations, retained=%s",
    async (retained) => {
      const view = render(
        <AcceptedMaterialExportPanel
          history={sampleMaterialExports(retained)}
          pending={false}
          onExport={vi.fn()}
          onDownload={vi.fn()}
        />,
      );
      const result = await axe(view.container);
      expect(
        result.violations.filter(
          (row) => row.impact === "critical" || row.impact === "serious",
        ),
      ).toEqual([]);
    },
  );
});
