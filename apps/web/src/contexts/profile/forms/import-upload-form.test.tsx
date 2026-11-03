import { buildTestPorts, InMemoryStoragePort } from "../../../test/testPorts.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileToBase64 } from "../../../shared/lib/file.js";
import { renderWithProviders } from "../../../test/render.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";
import { ImportUploadForm } from "./import-upload-form.js";

vi.mock("../../../shared/lib/file.js", () => ({ fileToBase64: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function selectFile(filename: string) {
  fireEvent.change(screen.getByLabelText("Resume PDF"), {
    target: {
      files: [new File([filename], filename, { type: "application/pdf" })],
    },
  });
}

const coordinator = new InMemoryStoragePort();

beforeEach(async () => {
  vi.mocked(fileToBase64).mockReset();
  window.localStorage.clear();
  InMemoryStoragePort.transactionValues.clear();
  InMemoryStoragePort.failTransaction = null;
  InMemoryStoragePort.failWrite = null;
  await useProfileImportStore.getState().retryStorage(coordinator);
});

afterEach(() => vi.restoreAllMocks());

describe("<ImportUploadForm>", () => {
  it("keeps removal ordered after a pending load of the latest saved PDF", async () => {
    const firstLegacy = JSON.stringify({ version: 1, state: {
      filename: "legacy.pdf", pdfBase64: "legacy", importProfile: true, importStyle: true,
    } });
    window.localStorage.setItem("jh:profile-import", firstLegacy);
    const storage = new InMemoryStoragePort();
    await useProfileImportStore.getState().retryStorage(storage);
    await useProfileImportStore.getState().setUpload("current.pdf", "current", storage);
    renderWithProviders(<ImportUploadForm />, {
      withRouter: true,
      ports: { ...buildTestPorts(), storage },
    });
    window.localStorage.setItem("jh:profile-import", firstLegacy.replace("legacy.pdf", "later.pdf"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved PDF" }));
    await screen.findByRole("button", { name: "Load latest saved PDF" });
    const started = deferred<void>();
    const release = deferred<void>();
    const transact = storage.transact.bind(storage);
    vi.spyOn(storage, "transact").mockImplementationOnce(async (name, operation, signal) => {
      started.resolve();
      await release.promise;
      return transact(name, operation, signal);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load latest saved PDF" }));
    await started.promise;
    const remove = screen.getByRole("button", { name: "Remove saved PDF" });
    expect(remove).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the latest saved PDF");
    fireEvent.click(remove);
    expect(JSON.parse(InMemoryStoragePort.transactionValues.get("jh:profile-import-v2")!).state.filename).toBe("current.pdf");
    await act(async () => release.resolve());
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(useProfileImportStore.getState().filename).toBe(""));
    expect(JSON.parse(InMemoryStoragePort.transactionValues.get("jh:profile-import-v2")!).state.filename).toBe("");
    expect(window.localStorage.getItem("jh:profile-import")).toBe(firstLegacy.replace("legacy.pdf", "later.pdf"));
  });
  it("keeps continuation disabled until upload state is complete", async () => {
    renderWithProviders(<ImportUploadForm />, { withRouter: true });

    expect(
      await screen.findByRole("button", { name: "Continue to options" }),
    ).toBeDisabled();
  });

  it("restores read recovery after an invalid selection is discarded", async () => {
    const payload = JSON.stringify({
      version: 1,
      state: {
        filename: "accepted.pdf",
        pdfBase64: "accepted-content",
        importProfile: true,
        importStyle: true,
      },
    });
    window.localStorage.setItem("jh:profile-import", payload);
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage unavailable");
      },
    });
    try {
      expect(
        await useProfileImportStore.getState().retryStorage(coordinator),
      ).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }

    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByRole("button", { name: "Retry browser storage" });
    fireEvent.change(screen.getByLabelText("Resume PDF"), {
      target: {
        files: [new File(["invalid"], "bad.txt", { type: "text/plain" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard selection" }));
    expect(
      screen.getByRole("button", { name: "Retry browser storage" }),
    ).toBeVisible();
    expect(window.localStorage.getItem("jh:profile-import")).toBe(payload);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry browser storage" }),
    );
    expect(await screen.findByText("accepted.pdf")).toBeVisible();
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-content",
    });
  });

  it("restores read recovery after a replacement write fails and is discarded", async () => {
    window.localStorage.setItem(
      "jh:profile-import",
      JSON.stringify({
        version: 1,
        state: {
          filename: "accepted.pdf",
          pdfBase64: "accepted-content",
          importProfile: true,
          importStyle: true,
        },
      }),
    );
    await useProfileImportStore.getState().retryStorage(coordinator);
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage unavailable");
      },
    });
    try {
      expect(
        await useProfileImportStore.getState().retryStorage(coordinator),
      ).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }
    vi.mocked(fileToBase64).mockResolvedValueOnce("replacement-content");
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByRole("button", { name: "Retry browser storage" });
    InMemoryStoragePort.failTransaction = "write";
    selectFile("replacement.pdf");
    await screen.findByRole("button", { name: "Retry saving PDF" });
    fireEvent.click(
      screen.getByRole("button", { name: "Keep previously saved PDF" }),
    );
    InMemoryStoragePort.failTransaction = null;
    expect(
      screen.getByRole("button", { name: "Retry browser storage" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry browser storage" }),
    );
    expect(await screen.findByText("accepted.pdf")).toBeVisible();
  });

  it("keeps the latest selection when file reads complete out of order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    vi.mocked(fileToBase64)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");

    selectFile("first.pdf");
    selectFile("second.pdf");
    await act(async () => second.resolve("second-content"));
    await act(async () => first.resolve("first-content"));

    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "second.pdf",
      pdfBase64: "second-content",
    });
    expect(screen.getByText("second.pdf")).toBeVisible();
  });

  it("does not publish a read that completes after the selection is cleared", async () => {
    const read = deferred<string>();
    vi.mocked(fileToBase64).mockReturnValueOnce(read.promise);
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");
    selectFile("late.pdf");
    fireEvent.change(screen.getByLabelText("Resume PDF"), {
      target: { files: [] },
    });
    await act(async () => read.resolve("late-content"));

    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "",
      pdfBase64: "",
    });
  });

  it("does not publish an unfinished selection after loading the latest saved PDF", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted", coordinator);
    const read = deferred<string>();
    vi.mocked(fileToBase64).mockReturnValueOnce(read.promise);
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");
    act(() => useProfileImportStore.setState({ storageFailure: "conflict" }));
    selectFile("late.pdf");
    fireEvent.click(
      screen.getByRole("button", { name: "Load latest saved PDF" }),
    );
    await waitFor(() =>
      expect(useProfileImportStore.getState().storageFailure).toBeNull(),
    );
    await act(async () => read.resolve("late"));
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted",
    });
    expect(
      JSON.parse(
        InMemoryStoragePort.transactionValues.get("jh:profile-import-v2")!,
      ).state.filename,
    ).toBe("accepted.pdf");
  });

  it("does not publish a read after the form unmounts", async () => {
    const read = deferred<string>();
    vi.mocked(fileToBase64).mockReturnValueOnce(read.promise);
    const view = renderWithProviders(<ImportUploadForm />, {
      withRouter: true,
    });
    await screen.findByLabelText("Resume PDF");
    selectFile("late.pdf");
    view.unmount();
    await act(async () => read.resolve("late-content"));

    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "",
      pdfBase64: "",
    });
  });

  it("keeps the accepted PDF when the file picker is dismissed during a new read", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-content", coordinator);
    const read = deferred<string>();
    vi.mocked(fileToBase64).mockReturnValueOnce(read.promise);
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");
    selectFile("late.pdf");
    fireEvent.change(screen.getByLabelText("Resume PDF"), {
      target: { files: [] },
    });
    await act(async () => read.resolve("late-content"));
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-content",
    });
  });

  it("does not restore a late read after the saved PDF is explicitly removed", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-content", coordinator);
    const read = deferred<string>();
    vi.mocked(fileToBase64).mockReturnValueOnce(read.promise);
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");
    selectFile("late.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Remove saved PDF" }));
    await act(async () => read.resolve("late-content"));
    await waitFor(() =>
      expect(useProfileImportStore.getState()).toMatchObject({
        filename: "",
        pdfBase64: "",
      }),
    );
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state.filename,
    ).toBe("");
  });

  it("keeps the previously saved file when browser storage refuses a replacement", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-content", coordinator);
    vi.mocked(fileToBase64).mockResolvedValueOnce("replacement-content");
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");
    InMemoryStoragePort.failTransaction = "write";
    selectFile("replacement.pdf");

    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-content",
    });
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state,
    ).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-content",
    });
    expect(
      screen.getByRole("button", { name: "Continue to options" }),
    ).toBeDisabled();

    InMemoryStoragePort.failTransaction = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry saving PDF" }));
    await waitFor(() =>
      expect(useProfileImportStore.getState()).toMatchObject({
        filename: "replacement.pdf",
        pdfBase64: "replacement-content",
      }),
    );
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state,
    ).toMatchObject({
      filename: "replacement.pdf",
      pdfBase64: "replacement-content",
    });
    expect(
      screen.getByRole("button", { name: "Continue to options" }),
    ).toBeEnabled();
  });

  it("reports failed removal and lets the user retry without losing the accepted file", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-content", coordinator);
    renderWithProviders(<ImportUploadForm />, { withRouter: true });
    await screen.findByLabelText("Resume PDF");
    InMemoryStoragePort.failWrite = (value) =>
      !JSON.parse(value).state.filename;

    fireEvent.click(screen.getByRole("button", { name: "Remove saved PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be removed",
    );
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-content",
    });
    expect(
      screen.getByRole("button", { name: "Continue to options" }),
    ).toBeDisabled();

    InMemoryStoragePort.failWrite = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry removing PDF" }));
    await waitFor(() =>
      expect(useProfileImportStore.getState()).toMatchObject({
        filename: "",
        pdfBase64: "",
      }),
    );
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state.filename,
    ).toBe("");
  });
});
