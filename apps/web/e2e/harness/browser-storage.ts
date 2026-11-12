import type { Page } from "@playwright/test";

/** Inspect actual browser persistence in the owned synthetic origin. */
export async function browserStorage(page: Page) {
  return page.evaluate(async () => {
    const persistent: unknown[] = [
      { local: { ...localStorage }, session: { ...sessionStorage } },
    ];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(info.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const names = Array.from(database.objectStoreNames);
      if (names.length)
        await Promise.all(
          names.map(
            (name) =>
              new Promise<void>((resolve, reject) => {
                const request = database
                  .transaction(name, "readonly")
                  .objectStore(name)
                  .getAll();
                request.onsuccess = () => {
                  persistent.push({
                    database: info.name,
                    store: name,
                    values: request.result,
                  });
                  resolve();
                };
                request.onerror = () => reject(request.error);
              }),
          ),
        );
      database.close();
    }
    return JSON.stringify(persistent);
  });
}
