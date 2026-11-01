import { InMemoryStoragePort } from "../../../test/testPorts.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasCompletedImport,
  hasPendingImport,
  hasProfileImportUpload,
  useProfileImportStore,
} from "./profile-import-store.js";

const coordinator = new InMemoryStoragePort();

beforeEach(async () => {
  useProfileImportStore.setState({ pendingImports: [], completedImports: [] });
  window.localStorage.clear();
  InMemoryStoragePort.transactionValues.clear();
  InMemoryStoragePort.failTransaction = null;
  InMemoryStoragePort.failWrite = null;
  await useProfileImportStore.getState().retryStorage(coordinator);
});

afterEach(() => vi.restoreAllMocks());

describe("profile import persistence", () => {
  it("matches exact import inputs through option and file reselection while allowing different PDFs", async () => {
    const store = useProfileImportStore;
    await store.getState().setUpload("same.pdf", "pdf-one", coordinator);
    const firstRevision = store.getState().selectionRevision;
    expect(await store.getState().beginImport(firstRevision, coordinator)).toBe(
      true,
    );
    await store.getState().setOptions(false, true, coordinator);
    await store.getState().setOptions(true, true, coordinator);
    expect(hasPendingImport(store.getState())).toBe(true);
    expect(
      await store
        .getState()
        .beginImport(store.getState().selectionRevision, coordinator),
    ).toBe(false);
    await store.getState().setUpload("same.pdf", "pdf-one", coordinator);
    expect(hasPendingImport(store.getState())).toBe(true);
    expect(
      await store
        .getState()
        .beginImport(store.getState().selectionRevision, coordinator),
    ).toBe(false);

    await store.getState().setUpload("same.pdf", "pdf-two", coordinator);
    const differentRevision = store.getState().selectionRevision;
    expect(hasPendingImport(store.getState())).toBe(false);
    expect(
      await store.getState().beginImport(differentRevision, coordinator),
    ).toBe(true);
    store.getState().finishImport(firstRevision, {
      ok: true,
      profile: { synthetic: "first" },
    });
    expect(hasCompletedImport(store.getState())).toBe(false);
    store.getState().finishImport(differentRevision, {
      ok: true,
      profile: { synthetic: "second" },
    });
    expect(hasCompletedImport(store.getState())).toBe(true);
    await store.getState().setOptions(false, true, coordinator);
    expect(hasCompletedImport(store.getState())).toBe(false);
    await store.getState().setOptions(true, true, coordinator);
    expect(hasCompletedImport(store.getState())).toBe(true);
    expect(
      await store
        .getState()
        .beginImport(store.getState().selectionRevision, coordinator),
    ).toBe(false);
  });

  it("allows retry of the same request after its earlier attempt fails", async () => {
    const store = useProfileImportStore;
    await store.getState().setUpload("same.pdf", "pdf-one", coordinator);
    const revision = store.getState().selectionRevision;
    expect(await store.getState().beginImport(revision, coordinator)).toBe(
      true,
    );
    store.getState().finishImport(revision);
    expect(await store.getState().beginImport(revision, coordinator)).toBe(
      true,
    );
  });

  it("keeps identical pending work fenced across cleanup but permits a new request after it settles", async () => {
    const store = useProfileImportStore;
    await store.getState().setUpload("same.pdf", "pdf-one", coordinator);
    const originalRevision = store.getState().selectionRevision;
    expect(
      await store.getState().beginImport(originalRevision, coordinator),
    ).toBe(true);
    expect(await store.getState().reset(coordinator)).toBe(true);
    await store.getState().setUpload("same.pdf", "pdf-one", coordinator);
    const newRevision = store.getState().selectionRevision;
    expect(hasPendingImport(store.getState())).toBe(true);
    expect(await store.getState().beginImport(newRevision, coordinator)).toBe(
      false,
    );
    store.getState().finishImport(originalRevision, { ok: true });
    expect(hasPendingImport(store.getState())).toBe(false);
    expect(hasCompletedImport(store.getState())).toBe(false);
    expect(await store.getState().beginImport(newRevision, coordinator)).toBe(
      true,
    );
  });

  it("keeps completed-request authority when cleanup fails", async () => {
    const store = useProfileImportStore;
    await store.getState().setUpload("same.pdf", "pdf-one", coordinator);
    const revision = store.getState().selectionRevision;
    expect(await store.getState().beginImport(revision, coordinator)).toBe(
      true,
    );
    store.getState().finishImport(revision, { ok: true });
    InMemoryStoragePort.failWrite = (value) =>
      !JSON.parse(value).state.filename;
    expect(await store.getState().reset(coordinator)).toBe(false);
    expect(
      await store.getState().setUpload("same.pdf", "pdf-one", coordinator),
    ).toBe(true);
    expect(hasCompletedImport(store.getState())).toBe(true);
    expect(
      await store
        .getState()
        .beginImport(store.getState().selectionRevision, coordinator),
    ).toBe(false);
  });
  it("preserves the last accepted upload if storage access throws, then allows retry", async () => {
    expect(
      await useProfileImportStore
        .getState()
        .setUpload("accepted.pdf", "accepted-bytes", coordinator),
    ).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Denied", "SecurityError");
      },
    });
    try {
      useProfileImportStore.getState().beginSelection();
      expect(
        await useProfileImportStore
          .getState()
          .setUpload("new.pdf", "new-bytes", coordinator),
      ).toBe(false);
      expect(useProfileImportStore.getState()).toMatchObject({
        filename: "accepted.pdf",
        pdfBase64: "accepted-bytes",
        storageFailure: "write",
      });
      expect(hasProfileImportUpload(useProfileImportStore.getState())).toBe(
        false,
      );
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }
    expect(
      await useProfileImportStore
        .getState()
        .setUpload("new.pdf", "new-bytes", coordinator),
    ).toBe(true);
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state,
    ).toMatchObject({
      filename: "new.pdf",
      pdfBase64: "new-bytes",
    });
  });

  it("leaves options and upload unchanged when writing options fails", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-bytes", coordinator);
    const saved =
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null;
    InMemoryStoragePort.failTransaction = "write";
    expect(
      await useProfileImportStore
        .getState()
        .setOptions(false, true, coordinator),
    ).toBe(false);
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-bytes",
      importProfile: true,
      importStyle: true,
      storageFailure: "write",
    });
    expect(
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null,
    ).toBe(saved);
  });

  it("reports failed reads without replacing accepted state, and can read the saved current payload again", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-bytes", coordinator);
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
      expect(useProfileImportStore.getState()).toMatchObject({
        filename: "accepted.pdf",
        storageFailure: "read",
      });
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }
    const saved =
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null;
    expect(
      await useProfileImportStore
        .getState()
        .setOptions(false, true, coordinator),
    ).toBe(false);
    expect(
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null,
    ).toBe(saved);
    expect(useProfileImportStore.getState().storageFailure).toBe("read");
    expect(
      await useProfileImportStore.getState().retryStorage(coordinator),
    ).toBe(true);
    expect(useProfileImportStore.getState()).toMatchObject({
      filename: "accepted.pdf",
      pdfBase64: "accepted-bytes",
      storageFailure: null,
    });
  });

  it("reports unavailable storage at startup and restores the prior selection only after retry", async () => {
    await useProfileImportStore
      .getState()
      .setUpload("accepted.pdf", "accepted-bytes", coordinator);
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Denied", "SecurityError");
      },
    });
    try {
      vi.resetModules();
      const { useProfileImportStore: freshStore } =
        await import("./profile-import-store.js");
      await freshStore.getState().hydrate(coordinator);
      expect(freshStore.getState()).toMatchObject({
        filename: "",
        pdfBase64: "",
        storageFailure: "read",
      });
      Object.defineProperty(window, "localStorage", descriptor);
      expect(await freshStore.getState().retryStorage(coordinator)).toBe(true);
      expect(freshStore.getState()).toMatchObject({
        filename: "accepted.pdf",
        pdfBase64: "accepted-bytes",
        storageFailure: null,
      });
    } finally {
      Object.defineProperty(window, "localStorage", descriptor);
    }
  });

  it("rejects an incomplete stored pair and preserves it until a deliberate replacement", async () => {
    window.localStorage.setItem(
      "jh:profile-import",
      JSON.stringify({
        version: 1,
        state: {
          filename: "orphan.pdf",
          pdfBase64: "",
          importProfile: true,
          importStyle: true,
        },
      }),
    );
    expect(
      await useProfileImportStore.getState().retryStorage(coordinator),
    ).toBe(false);
    expect(window.localStorage.getItem("jh:profile-import")).toContain(
      "orphan.pdf",
    );
    expect(useProfileImportStore.getState().storageFailure).toBe("read");
    const unreadLegacy = window.localStorage.getItem("jh:profile-import");
    expect(
      await useProfileImportStore
        .getState()
        .setUpload("new.pdf", "new", coordinator),
    ).toBe(true);
    expect(window.localStorage.getItem("jh:profile-import")).toBe(unreadLegacy);
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state.filename,
    ).toBe("new.pdf");
  });
});

describe("shared browser storage ownership", () => {
  async function independentTabs() {
    vi.resetModules();
    const tabA = (await import("./profile-import-store.js"))
      .useProfileImportStore;
    vi.resetModules();
    const tabB = (await import("./profile-import-store.js"))
      .useProfileImportStore;
    await tabA.getState().hydrate(coordinator);
    await tabB.getState().hydrate(coordinator);
    return { tabA, tabB };
  }

  it("preserves another tab's accepted upload when an earlier import completes", async () => {
    const { tabA, tabB } = await independentTabs();
    expect(
      await tabA.getState().setUpload("first.pdf", "first", coordinator),
    ).toBe(true);
    expect(await tabB.getState().retryStorage(coordinator)).toBe(true);
    const revision = tabA.getState().selectionRevision;
    expect(await tabA.getState().beginImport(revision, coordinator)).toBe(true);
    expect(
      await tabB.getState().setUpload("second.pdf", "second", coordinator),
    ).toBe(true);
    const newest =
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null;
    tabA.getState().finishImport(revision, { ok: true });
    expect(await tabA.getState().reset(coordinator)).toBe(false);
    expect(tabA.getState().storageFailure).toBe("conflict");
    expect(
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null,
    ).toBe(newest);
    expect(hasCompletedImport(tabA.getState())).toBe(true);
    expect(await tabA.getState().retryStorage(coordinator)).toBe(true);
    expect(tabA.getState().filename).toBe("second.pdf");
  });

  it("serializes competing writes and refuses a stale writer or remover", async () => {
    const { tabA, tabB } = await independentTabs();
    const results = await Promise.all([
      tabA.getState().setUpload("first.pdf", "first", coordinator),
      tabB.getState().setUpload("second.pdf", "second", coordinator),
    ]);
    expect(results).toEqual([true, false]);
    expect(tabB.getState().storageFailure).toBe("conflict");
    expect(await tabB.getState().retryStorage(coordinator)).toBe(true);
    expect(
      await tabB.getState().setUpload("second.pdf", "second", coordinator),
    ).toBe(true);
    const latest =
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null;
    expect(
      await tabA.getState().setUpload("third.pdf", "third", coordinator),
    ).toBe(false);
    expect(await tabA.getState().reset(coordinator)).toBe(false);
    expect(
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null,
    ).toBe(latest);
    expect(JSON.parse(latest!).state.filename).toBe("second.pdf");
  });

  it("retains legacy bytes through replacement and removal and fails closed without transactional storage", async () => {
    const legacy = JSON.stringify({
      version: 1,
      state: {
        filename: "legacy.pdf",
        pdfBase64: "legacy",
        importProfile: true,
        importStyle: true,
      },
    });
    window.localStorage.setItem("jh:profile-import", legacy);
    const { tabA } = await independentTabs();
    const unavailable = {
      transact: async () => {
        throw new Error("unavailable");
      },
    };
    expect(await tabA.getState().setUpload("new.pdf", "new", unavailable)).toBe(
      false,
    );
    expect(tabA.getState().storageFailure).toBe("write");
    expect(
      InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ?? null,
    ).toBeNull();
    expect(window.localStorage.getItem("jh:profile-import")).toBe(legacy);
    expect(await tabA.getState().setUpload("new.pdf", "new", coordinator)).toBe(
      true,
    );
    expect(await tabA.getState().reset(coordinator)).toBe(true);
    expect(window.localStorage.getItem("jh:profile-import")).toBe(legacy);
    expect(await tabA.getState().retryStorage(coordinator)).toBe(true);
    expect(tabA.getState().filename).toBe("");
    expect(tabA.getState().legacyData?.filename).toBe("legacy.pdf");
  });

  it("does not let an option write queued before recovery change the recovered selection", async () => {
    const { tabA, tabB } = await independentTabs();
    expect(
      await tabA.getState().setUpload("same.pdf", "same", coordinator),
    ).toBe(true);
    expect(await tabB.getState().retryStorage(coordinator)).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = {
      transact: async <T>(
        name: string,
        operation: (current: string | null) => { result: T; write?: string },
        signal?: AbortSignal,
      ): Promise<T> => {
        await gate;
        return coordinator.transact(name, operation, signal);
      },
    };
    const queued = tabA.getState().setOptions(false, true, delayed);
    expect(await tabB.getState().setOptions(true, false, coordinator)).toBe(
      true,
    );
    const recovery = tabA.getState().retryStorage(coordinator);
    release();
    expect(await queued).toBe(false);
    expect(await recovery).toBe(true);
    expect(tabA.getState()).toMatchObject({
      importProfile: true,
      importStyle: false,
    });
    expect(
      JSON.parse(
        (InMemoryStoragePort.transactionValues.get("jh:profile-import-v2") ??
          null)!,
      ).state,
    ).toMatchObject({ importProfile: true, importStyle: false });
  });

  it("reconciles a just-committed write without cancelling a newer selection", async () => {
    let release!: () => void;
    let committed!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committedSignal = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const delayed = {
      transact: async <T>(
        key: string,
        operation: (current: string | null) => { result: T; write?: string },
        signal?: AbortSignal,
      ) => {
        const result = await coordinator.transact(key, operation, signal);
        committed();
        await held;
        return result;
      },
    };
    const store = useProfileImportStore;
    store.getState().beginSelection();
    const first = store.getState().setUpload("first.pdf", "first", delayed);
    await committedSignal;
    store.getState().beginSelection();
    const second = store
      .getState()
      .setUpload("second.pdf", "second", coordinator);
    release();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(store.getState()).toMatchObject({
      filename: "second.pdf",
      pdfBase64: "second",
      selectionPending: false,
    });
    expect(
      JSON.parse(
        InMemoryStoragePort.transactionValues.get("jh:profile-import-v2")!,
      ).state.filename,
    ).toBe("second.pdf");
  });
});
