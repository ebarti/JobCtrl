import { InMemoryStoragePort } from "../../../test/testPorts.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportConfirmForm } from "./import-confirm-form.js";
import { ImportPreviewForm } from "./import-preview-form.js";

const { importResume } = vi.hoisted(() => ({ importResume: vi.fn() }));
vi.mock("../hooks/useImportResumeMutation.js", () => ({
  useImportResumeMutation: () => ({ mutateAsync: importResume, error: null }),
}));
vi.mock("../../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: () => <div>PDF preview</div>,
}));

const coordinator = new InMemoryStoragePort();

beforeEach(async () => {
  useProfileImportStore.setState({ pendingImports: [], completedImports: [] });
  window.localStorage.clear();
  InMemoryStoragePort.transactionValues.clear();
  InMemoryStoragePort.failTransaction = null;
  InMemoryStoragePort.failWrite = null;
  await useProfileImportStore.getState().retryStorage(coordinator);
  await useProfileImportStore
    .getState()
    .setUpload("synthetic.pdf", "synthetic-pdf-bytes", coordinator);
  importResume.mockReset().mockResolvedValue({
    ok: true,
    profile: { synthetic: "draft" },
    action: { status: "ready" },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("resume import cleanup", () => {
  it("does not repeat a completed import when browser cleanup fails", async () => {
    const view = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    await screen.findByRole("button", { name: "Confirm import" });
    InMemoryStoragePort.failWrite = (value) =>
      !JSON.parse(value).state.filename;

    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    await screen.findByText(
      /import request completed, but the PDF is still saved/i,
    );
    expect(
      screen.queryByRole("button", { name: "Confirm import" }),
    ).not.toBeInTheDocument();
    expect(importResume).toHaveBeenCalledTimes(1);
    expect(useProfileImportStore.getState().filename).toBe("synthetic.pdf");
    expect(
      useProfileImportStore.getState().completedImports.at(-1)?.result,
    ).toMatchObject({
      profile: { synthetic: "draft" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Retry removing saved PDF" }),
    );
    expect(importResume).toHaveBeenCalledTimes(1);

    view.unmount();
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    expect(
      await screen.findByRole("button", { name: "Retry removing saved PDF" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Confirm import" }),
    ).not.toBeInTheDocument();

    InMemoryStoragePort.failWrite = null;
    fireEvent.click(
      screen.getByRole("button", { name: "Retry removing saved PDF" }),
    );
    await waitFor(() =>
      expect(useProfileImportStore.getState().filename).toBe(""),
    );
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state.filename,
    ).toBe("");
    expect(importResume).toHaveBeenCalledTimes(1);
  });

  it("does not remove a newer PDF when an earlier import finishes after navigation", async () => {
    let resolve!: (value: unknown) => void;
    importResume.mockReturnValueOnce(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const view = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm import" }),
    );
    await waitFor(() => expect(importResume).toHaveBeenCalledTimes(1));
    view.unmount();
    await useProfileImportStore
      .getState()
      .setUpload("newer.pdf", "newer-pdf-bytes", coordinator);
    await act(async () =>
      resolve({ ok: true, profile: { synthetic: "earlier draft" } }),
    );
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "newer.pdf",
      pdfBase64: "newer-pdf-bytes",
    });
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state.filename,
    ).toBe("newer.pdf");
    expect(
      useProfileImportStore.getState().completedImports.at(-1)?.result,
    ).toMatchObject({ profile: { synthetic: "earlier draft" } });
  });

  it("does not start a second request if the confirmation is remounted while the first is pending", async () => {
    let resolve!: (value: unknown) => void;
    importResume.mockReturnValueOnce(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const view = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm import" }),
    );
    await waitFor(() => expect(importResume).toHaveBeenCalledTimes(1));
    view.unmount();
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    expect(
      await screen.findByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    await act(async () =>
      resolve({ ok: true, profile: { synthetic: "draft" } }),
    );
    expect(
      await screen.findByRole("button", { name: "Remove saved PDF" }),
    ).toBeVisible();
    expect(importResume).toHaveBeenCalledTimes(1);
    expect(useProfileImportStore.getState().filename).toBe("synthetic.pdf");
  });

  it("allows deliberately importing the same PDF again after successful cleanup", async () => {
    const first = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm import" }),
    );
    await waitFor(() =>
      expect(useProfileImportStore.getState().filename).toBe(""),
    );
    expect(importResume).toHaveBeenCalledTimes(1);
    first.unmount();
    await useProfileImportStore
      .getState()
      .setUpload("synthetic.pdf", "synthetic-pdf-bytes", coordinator);
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    const confirm = await screen.findByRole("button", {
      name: "Confirm import",
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(importResume).toHaveBeenCalledTimes(2));
  });

  it("recognizes an identical pending and completed import after an option round trip", async () => {
    let resolve!: (value: unknown) => void;
    importResume.mockReturnValueOnce(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const first = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm import" }),
    );
    await waitFor(() => expect(importResume).toHaveBeenCalledTimes(1));
    first.unmount();
    const preview = renderWithProviders(<ImportPreviewForm />, {
      withRouter: true,
    });
    const checkbox = await screen.findByRole("checkbox", {
      name: "Profile data",
    });
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(useProfileImportStore.getState().pendingWrites).toBe(0),
    );
    preview.unmount();
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    expect(
      await screen.findByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    expect(importResume).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({ ok: true, profile: { synthetic: "draft" } }),
    );
    expect(
      await screen.findByRole("button", { name: "Remove saved PDF" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Confirm import" }),
    ).not.toBeInTheDocument();
    expect(importResume).toHaveBeenCalledTimes(1);
  });

  it("allows a different option selection while a prior import is pending", async () => {
    let resolve!: (value: unknown) => void;
    importResume.mockReturnValueOnce(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const first = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm import" }),
    );
    await waitFor(() => expect(importResume).toHaveBeenCalledTimes(1));
    first.unmount();
    const preview = renderWithProviders(<ImportPreviewForm />, {
      withRouter: true,
    });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Profile data" }),
    );
    await waitFor(() =>
      expect(useProfileImportStore.getState().pendingWrites).toBe(0),
    );
    preview.unmount();
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    const confirm = await screen.findByRole("button", {
      name: "Confirm import",
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(importResume).toHaveBeenCalledTimes(2));
    expect(importResume.mock.calls[0]?.[0]).not.toEqual(
      importResume.mock.calls[1]?.[0],
    );
    await act(async () =>
      resolve({ ok: true, profile: { synthetic: "earlier" } }),
    );
  });
});
