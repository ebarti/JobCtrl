import { InMemoryStoragePort } from "../../../test/testPorts.js";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportPreviewForm } from "./import-preview-form.js";

vi.mock("../../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: () => <div>PDF preview</div>,
}));

const coordinator = new InMemoryStoragePort();

beforeEach(async () => {
  window.localStorage.clear();
  InMemoryStoragePort.transactionValues.clear();
  InMemoryStoragePort.failTransaction = null;
  InMemoryStoragePort.failWrite = null;
  await useProfileImportStore.getState().retryStorage(coordinator);
  await useProfileImportStore
    .getState()
    .setUpload("synthetic.pdf", "synthetic-pdf-bytes", coordinator);
});

afterEach(() => vi.restoreAllMocks());

describe("resume import options", () => {
  it("shows a failed options save and retries the intended selection", async () => {
    renderWithProviders(<ImportPreviewForm />, { withRouter: true });
    await screen.findByRole("checkbox", { name: "Profile data" });
    InMemoryStoragePort.failTransaction = "write";
    fireEvent.click(screen.getByRole("checkbox", { name: "Profile data" }));
    await screen.findByText(/import options could not be saved/i);
    expect(useProfileImportStore.getState().importProfile).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to confirmation" }),
    );
    expect(useProfileImportStore.getState().importProfile).toBe(true);

    InMemoryStoragePort.failTransaction = null;
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to confirmation" }),
    );
    await waitFor(() =>
      expect(useProfileImportStore.getState().importProfile).toBe(false),
    );
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state.importProfile,
    ).toBe(false);
  });
});
