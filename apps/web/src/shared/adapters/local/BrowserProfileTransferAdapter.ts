import type { ProfileTransferPort, ProfileTransferRecords } from "../../ports/ProfileTransferPort.js";

const DATABASE = "jobctrl-profile-import";
const STORE = "records";
const SELECTED_KEY = "jh:profile-import-v2";
const REVIEWS_KEY = "jh:profile-import-review-v1";
const LEGACY_KEY = "jh:profile-import";
const TIMEOUT_MS = 5000;

export class BrowserProfileTransferAdapter implements ProfileTransferPort {
  async inspect(): Promise<ProfileTransferRecords> {
    const errors: string[] = [];
    let legacyRaw: string | null = null;
    try {
      legacyRaw = window.localStorage.getItem(LEGACY_KEY);
    } catch {
      errors.push("The legacy browser record could not be read.");
    }
    let selectedRaw: string | null = null;
    let reviewsRaw: string | null = null;
    try {
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
        throw new Error("Browser database existence cannot be inspected safely.");
      }
      const databases = await bounded(indexedDB.databases());
      if (databases.some((database) => database.name === DATABASE)) {
        const records = await readExistingRecords();
        selectedRaw = records.selectedRaw;
        reviewsRaw = records.reviewsRaw;
        errors.push(...records.errors);
      }
    } catch {
      errors.push("The browser Profile database could not be inspected without changing it.");
    }
    return { selectedRaw, legacyRaw, reviewsRaw, errors };
  }

  async digestPdf(base64: string): Promise<{ sha256: string; byteLength: number; isPdf: boolean }> {
    // The existing uploader writes ordinary padded base64, not a data URL.
    if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new Error("The saved PDF encoding is invalid.");
    }
    let binary: string;
    try { binary = atob(base64); } catch { throw new Error("The saved PDF encoding is invalid."); }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    // A PDF header can occur within the first 1024 bytes of a valid document.
    const header = binary.slice(0, 1024);
    if (!globalThis.crypto?.subtle) throw new Error("A secure browser is required to verify the PDF.");
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return { sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""), byteLength: bytes.byteLength, isPdf: header.includes("%PDF-") };
  }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Browser storage inspection timed out.")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readExistingRecords(): Promise<{ selectedRaw: string | null; reviewsRaw: string | null; errors: string[] }> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(new Error("Browser database open timed out."));
    }, TIMEOUT_MS);
    const request = indexedDB.open(DATABASE);
    request.onupgradeneeded = () => {
      // If the database disappeared after enumeration, abort creation.
      request.transaction?.abort();
    };
    request.onblocked = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error("Browser database open was blocked."));
    };
    request.onerror = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error("Browser database could not be opened."));
    };
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true;
      clearTimeout(timer);
      resolve(request.result);
    };
  });
  try {
    if (!database.objectStoreNames.contains(STORE)) throw new Error("Profile records are unavailable.");
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const store = transaction.objectStore(STORE);
      const selected = store.get(SELECTED_KEY);
      const reviews = store.get(REVIEWS_KEY);
      let selectedRaw: string | null = null;
      let reviewsRaw: string | null = null;
      const errors: string[] = [];
      selected.onsuccess = () => {
        const value: unknown = selected.result;
        if (typeof value === "string") selectedRaw = value;
        else if (value !== undefined) errors.push("The selected Profile browser record has an unsupported format.");
      };
      reviews.onsuccess = () => {
        const value: unknown = reviews.result;
        if (typeof value === "string") reviewsRaw = value;
        else if (value !== undefined) errors.push("The Profile review browser record has an unsupported format.");
      };
      selected.onerror = (event) => { event.preventDefault(); errors.push("The selected Profile browser record could not be read."); };
      reviews.onerror = (event) => { event.preventDefault(); errors.push("The Profile review browser record could not be read."); };
      const timer = setTimeout(() => { try { transaction.abort(); } catch { /* Already completed. */ } }, TIMEOUT_MS);
      transaction.oncomplete = () => {
        clearTimeout(timer);
        resolve({ selectedRaw, reviewsRaw, errors });
      };
      transaction.onabort = () => { clearTimeout(timer); reject(new Error("Profile browser records could not be read.")); };
      transaction.onerror = () => undefined;
    });
  } finally {
    database.close();
  }
}
