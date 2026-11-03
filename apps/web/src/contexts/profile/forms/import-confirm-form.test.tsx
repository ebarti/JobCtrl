import { InMemoryStoragePort } from "../../../test/testPorts.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";
import { useProfileImportReviewStore } from "../stores/profile-import-review-store.js";
import { ImportConfirmForm } from "./import-confirm-form.js";
import { ImportPreviewForm } from "./import-preview-form.js";

const { importResume } = vi.hoisted(() => ({ importResume: vi.fn() }));
vi.mock("../hooks/useImportResumeMutation.js", () => ({
  useImportResumeMutation: () => ({
    mutateAsync: async (...args: unknown[]) => {
      const response = await importResume(...args);
      if (response && Object.hasOwn(response, "source")) return response;
      const attemptId = crypto.randomUUID();
      return { ...response, source: { attemptId, determinationId: "a".repeat(64),
        extractedPersonal: response?.profile?.personal ?? {},
        styleReceiptId: attemptId, inferredStyle: response?.style ?? {} } };
    }, error: null,
  }),
}));
vi.mock("../../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: () => <div>PDF preview</div>,
}));

const coordinator = new InMemoryStoragePort();

beforeEach(async () => {
  useProfileImportStore.setState({ pendingImports: [], completedImports: [] });
  useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
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
    profile: { synthetic: "draft", personal: { full_name: "Synthetic imported" } },
    style: { font_family: "roman" },
    action: { status: "ready" },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("resume import cleanup", () => {
  it("retains the returned draft separately from the upload and saved profile", async () => {
    const view = renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    await waitFor(() => expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1));
    const draft = useProfileImportReviewStore.getState().drafts[0]!;
    expect(draft.filename).toBe("synthetic.pdf");
    expect(draft.result.profile).toMatchObject({ personal: { full_name: "Synthetic imported" } });
    expect(draft.result.profile).not.toHaveProperty("synthetic");
    expect(draft.base.profileVersion).not.toBeUndefined();
    expect(importResume).toHaveBeenCalledOnce();
    view.unmount();
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
  });

  it("retains the upload if extracted personal provenance cannot be verified", async () => {
    importResume.mockResolvedValueOnce({ ok: true, profile: { personal: { email: "synthetic@example.invalid" } }, source: {} });
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    await screen.findByText(/personal fields could not be verified/i);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0);
    expect(useProfileImportStore.getState().filename).toBe("synthetic.pdf");
    expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  });

  it("preserves an earlier draft and the upload when extraction fails", async () => {
    await useProfileImportReviewStore.getState().stage({
      tenantId: "local", filename: "earlier.pdf", importProfile: true, importStyle: false,
      result: { profile: { synthetic: "earlier", personal: { full_name: "Synthetic imported" } } },
      base: { profileVersion: null, profile: {} },
    }, coordinator);
    importResume.mockRejectedValueOnce(new Error("synthetic failure"));
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    await screen.findByText(/import could not be completed/i);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(1);
    expect(useProfileImportStore.getState().filename).toBe("synthetic.pdf");
    expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  });

  it("retains the PDF for retry when extraction returns no reviewable fields", async () => {
    importResume.mockResolvedValueOnce({ ok: true, profile: {}, style: {} });
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    await screen.findByText(/no new reviewable fields were found/i);
    expect(useProfileImportReviewStore.getState().drafts).toHaveLength(0);
    expect(useProfileImportStore.getState().filename).toBe("synthetic.pdf");
    expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  });

  it("retains the extracted draft and PDF when durable review storage fails", async () => {
    const priorUpload = InMemoryStoragePort.transactionValues.get("jh:profile-import-v2");
    InMemoryStoragePort.failWrite = (value) => Array.isArray(JSON.parse(value).drafts);
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    await screen.findByText(/could not be saved for reload/i);
    expect(screen.getByRole("link", { name: "Review draft" })).toBeVisible();
    expect(useProfileImportReviewStore.getState()).toMatchObject({
      storageError: true, drafts: [{ filename: "synthetic.pdf" }],
    });
    expect(InMemoryStoragePort.transactionValues.get("jh:profile-import-v2")).toBe(priorUpload);
    InMemoryStoragePort.failWrite = null;
    expect(await useProfileImportReviewStore.getState().retry(coordinator)).toBe(true);
    useProfileImportReviewStore.setState({ drafts: [], pendingIds: [], storageError: false });
    expect(await useProfileImportReviewStore.getState().hydrate(coordinator)).toBe(true);
    expect(useProfileImportReviewStore.getState().drafts[0]?.filename).toBe("synthetic.pdf");
  });

  it("keeps the selected PDF and earlier draft when the same attempt has conflicting review data", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000001";
    expect(await useProfileImportReviewStore.getState().stage({
      tenantId: "local", filename: "earlier.pdf", importProfile: true, importStyle: false,
      result: { profile: { personal: { full_name: "Synthetic earlier" } }, source: {
        attemptId, determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic earlier" },
      } }, base: { profileVersion: null, profile: {} },
    }, coordinator)).toBe(true);
    const reviewKey = "jh:profile-import-review-v1";
    const uploadKey = "jh:profile-import-v2";
    const previousReview = InMemoryStoragePort.transactionValues.get(reviewKey);
    const previousUpload = InMemoryStoragePort.transactionValues.get(uploadKey);
    const previousDrafts = structuredClone(useProfileImportReviewStore.getState().drafts);
    importResume.mockResolvedValueOnce({ ok: true, profile: { personal: { full_name: "Synthetic conflicting" } },
      style: { font_family: "roman" }, source: { attemptId, determinationId: "a".repeat(64),
        extractedPersonal: { full_name: "Synthetic conflicting" }, styleReceiptId: attemptId, inferredStyle: { font_family: "roman" } } });
    renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import" }));
    await screen.findByText(/could not be saved for reload/i);
    expect(screen.getByRole("link", { name: "Review draft" })).toBeVisible();
    expect(InMemoryStoragePort.transactionValues.get(reviewKey)).toBe(previousReview);
    expect(InMemoryStoragePort.transactionValues.get(uploadKey)).toBe(previousUpload);
    expect(useProfileImportReviewStore.getState().drafts).toEqual(previousDrafts);
    expect(useProfileImportStore.getState()).toMatchObject({ filename: "synthetic.pdf", pdfBase64: "synthetic-pdf-bytes" });
    expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  });

  it("does not repeat a completed import when browser cleanup fails", async () => {
    const view = renderWithProviders(<ImportConfirmForm />, {
      withRouter: true,
    });
    await screen.findByRole("button", { name: "Confirm import" });
    InMemoryStoragePort.failWrite = (value) =>
      JSON.parse(value).state && !JSON.parse(value).state.filename;

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
      profile: { synthetic: "draft", personal: { full_name: "Synthetic imported" } },
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
      resolve({ ok: true, profile: { synthetic: "earlier draft", personal: { full_name: "Synthetic imported" } }, style: { font_family: "roman" } }),
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
    ).toMatchObject({ profile: { synthetic: "earlier draft", personal: { full_name: "Synthetic imported" } } });
    expect(useProfileImportReviewStore.getState().drafts).toMatchObject([
      { filename: "synthetic.pdf", result: { profile: { personal: { full_name: "Synthetic imported" } } } },
    ]);
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
      resolve({ ok: true, profile: { synthetic: "draft", personal: { full_name: "Synthetic imported" } }, style: { font_family: "roman" } }),
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
      resolve({ ok: true, profile: { synthetic: "draft", personal: { full_name: "Synthetic imported" } }, style: { font_family: "roman" } }),
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
      resolve({ ok: true, profile: { synthetic: "earlier", personal: { full_name: "Synthetic imported" } }, style: { font_family: "roman" } }),
    );
  });
});
