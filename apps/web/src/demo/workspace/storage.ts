import {
  DEMO_BLOBS_STORE,
  DEMO_WORKSPACE_DATABASE,
  DEMO_WORKSPACE_DATABASE_VERSION,
  DEMO_WORKSPACE_STORE,
  type DemoWorkspaceSnapshot,
  type DemoWorkspaceStorageMode,
} from "./contracts.js";

const SNAPSHOT_KEY = "current";

export class DemoWorkspaceStorageError extends Error {
  constructor(
    readonly kind: "unavailable" | "quota" | "upgrade_required",
    cause?: unknown,
    readonly foundDatabaseVersion?: number,
  ) {
    super(
      kind === "quota"
        ? "Demo workspace storage quota exceeded."
        : kind === "upgrade_required"
          ? "Demo workspace database requires a newer application version."
          : "Demo workspace storage unavailable.",
      {
        cause,
      },
    );
    this.name = "DemoWorkspaceStorageError";
  }
}

export interface DemoWorkspaceTransaction {
  putSnapshot(snapshot: DemoWorkspaceSnapshot): void;
  putBlob(blobId: string, value: Blob): void;
  deleteBlob(blobId: string): void;
  clearBlobs(): void;
}

export interface DemoWorkspaceStore {
  readonly storageMode: DemoWorkspaceStorageMode;
  readSnapshot(): Promise<DemoWorkspaceSnapshot | null>;
  readBlob(blobId: string): Promise<Blob | null>;
  readAllBlobs(): Promise<ReadonlyMap<string, Blob>>;
  transact<TResult>(
    operation: (
      current: DemoWorkspaceSnapshot | null,
      transaction: DemoWorkspaceTransaction,
    ) => TResult,
  ): Promise<TResult>;
  close?(): void;
}

interface WorkspaceRow {
  readonly key: typeof SNAPSHOT_KEY;
  readonly snapshot: DemoWorkspaceSnapshot;
}

function classifyStorageError(error: unknown): DemoWorkspaceStorageError {
  if (error instanceof DemoWorkspaceStorageError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new DemoWorkspaceStorageError("quota", error);
  }
  return new DemoWorkspaceStorageError("unavailable", error);
}

/** IndexedDB is the only durable authority for a demo workspace. */
export class IndexedDbDemoWorkspaceStore implements DemoWorkspaceStore {
  readonly storageMode = "indexeddb" as const;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly indexedDb: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  async readSnapshot(): Promise<DemoWorkspaceSnapshot | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        DEMO_WORKSPACE_STORE,
        "readonly",
      );
      const request = transaction
        .objectStore(DEMO_WORKSPACE_STORE)
        .get(SNAPSHOT_KEY);
      request.onsuccess = () =>
        resolve((request.result as WorkspaceRow | undefined)?.snapshot ?? null);
      request.onerror = () => reject(classifyStorageError(request.error));
      transaction.onabort = () =>
        reject(classifyStorageError(transaction.error));
    });
  }

  async readBlob(blobId: string): Promise<Blob | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(DEMO_BLOBS_STORE, "readonly");
      const request = transaction.objectStore(DEMO_BLOBS_STORE).get(blobId);
      request.onsuccess = () =>
        resolve((request.result as Blob | undefined) ?? null);
      request.onerror = () => reject(classifyStorageError(request.error));
      transaction.onabort = () =>
        reject(classifyStorageError(transaction.error));
    });
  }

  async readAllBlobs(): Promise<ReadonlyMap<string, Blob>> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const values = new Map<string, Blob>();
      const transaction = database.transaction(DEMO_BLOBS_STORE, "readonly");
      const request = transaction
        .objectStore(DEMO_BLOBS_STORE)
        .openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        values.set(String(cursor.key), cursor.value as Blob);
        cursor.continue();
      };
      request.onerror = () => reject(classifyStorageError(request.error));
      transaction.oncomplete = () => resolve(values);
      transaction.onabort = () =>
        reject(classifyStorageError(transaction.error));
    });
  }

  async transact<TResult>(
    operation: (
      current: DemoWorkspaceSnapshot | null,
      transaction: DemoWorkspaceTransaction,
    ) => TResult,
  ): Promise<TResult> {
    const database = await this.open();
    return new Promise<TResult>((resolve, reject) => {
      const transaction = database.transaction(
        [DEMO_WORKSPACE_STORE, DEMO_BLOBS_STORE],
        "readwrite",
      );
      const workspaces = transaction.objectStore(DEMO_WORKSPACE_STORE);
      const blobs = transaction.objectStore(DEMO_BLOBS_STORE);
      const request = workspaces.get(SNAPSHOT_KEY);
      let result: TResult;
      let operationError: unknown;

      request.onsuccess = () => {
        try {
          result = operation(
            (request.result as WorkspaceRow | undefined)?.snapshot ?? null,
            {
              putSnapshot: (snapshot) =>
                workspaces.put({
                  key: SNAPSHOT_KEY,
                  snapshot,
                } satisfies WorkspaceRow),
              putBlob: (blobId, value) => blobs.put(value, blobId),
              deleteBlob: (blobId) => blobs.delete(blobId),
              clearBlobs: () => blobs.clear(),
            },
          );
        } catch (error) {
          operationError = error;
          transaction.abort();
        }
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(result!);
      transaction.onabort = () =>
        reject(operationError ?? classifyStorageError(transaction.error));
      transaction.onerror = () => undefined;
    });
  }

  private open(): Promise<IDBDatabase> {
    if (!this.indexedDb) {
      return Promise.reject(new DemoWorkspaceStorageError("unavailable"));
    }
    if (this.databasePromise) {
      return this.databasePromise;
    }
    const indexedDb = this.indexedDb;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        // Opening without a requested version can create a missing v1 database,
        // but can never downgrade or upgrade an existing database. A future
        // version is inspected read-only and rejected below.
        request = indexedDb.open(DEMO_WORKSPACE_DATABASE);
      } catch (error) {
        reject(classifyStorageError(error));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DEMO_WORKSPACE_STORE)) {
          database.createObjectStore(DEMO_WORKSPACE_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(DEMO_BLOBS_STORE)) {
          database.createObjectStore(DEMO_BLOBS_STORE);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (database.version > DEMO_WORKSPACE_DATABASE_VERSION) {
          const foundDatabaseVersion = database.version;
          database.close();
          reject(
            new DemoWorkspaceStorageError(
              "upgrade_required",
              undefined,
              foundDatabaseVersion,
            ),
          );
          return;
        }
        if (
          !database.objectStoreNames.contains(DEMO_WORKSPACE_STORE) ||
          !database.objectStoreNames.contains(DEMO_BLOBS_STORE)
        ) {
          database.close();
          reject(new DemoWorkspaceStorageError("unavailable"));
          return;
        }
        resolve(database);
      };
      request.onerror = () => reject(classifyStorageError(request.error));
      request.onblocked = () =>
        reject(new DemoWorkspaceStorageError("unavailable"));
    });
    return this.databasePromise;
  }

  close(): void {
    void this.databasePromise
      ?.then((database) => database.close())
      .catch(() => undefined);
    this.databasePromise = null;
  }
}

/** Tab-local fallback and deterministic test store. It never crosses a channel. */
export class InMemoryDemoWorkspaceStore implements DemoWorkspaceStore {
  readonly storageMode = "memory" as const;
  private readonly blobs = new Map<string, Blob>();
  private snapshot: DemoWorkspaceSnapshot | null;
  private queue = Promise.resolve();

  constructor(snapshot: DemoWorkspaceSnapshot | null = null) {
    this.snapshot = snapshot ? clone(snapshot) : null;
  }

  async readSnapshot(): Promise<DemoWorkspaceSnapshot | null> {
    return this.snapshot ? clone(this.snapshot) : null;
  }

  async readBlob(blobId: string): Promise<Blob | null> {
    return this.blobs.get(blobId) ?? null;
  }

  async readAllBlobs(): Promise<ReadonlyMap<string, Blob>> {
    return new Map(this.blobs);
  }

  transact<TResult>(
    operation: (
      current: DemoWorkspaceSnapshot | null,
      transaction: DemoWorkspaceTransaction,
    ) => TResult,
  ): Promise<TResult> {
    const run = this.queue.then(() => {
      let nextSnapshot = this.snapshot ? clone(this.snapshot) : null;
      const nextBlobs = new Map(this.blobs);
      const result = operation(nextSnapshot, {
        putSnapshot: (snapshot) => {
          nextSnapshot = clone(snapshot);
        },
        putBlob: (blobId, value) => nextBlobs.set(blobId, value),
        deleteBlob: (blobId) => nextBlobs.delete(blobId),
        clearBlobs: () => nextBlobs.clear(),
      });
      this.snapshot = nextSnapshot;
      this.blobs.clear();
      for (const [blobId, value] of nextBlobs) {
        this.blobs.set(blobId, value);
      }
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function clone<TValue>(value: TValue): TValue {
  return structuredClone(value);
}
