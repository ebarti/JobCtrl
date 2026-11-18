import type { Page } from "@playwright/test";

/** Read the actual owned demo aggregate, without replacing any product port. */
export async function demoAuthority(page: Page) {
  return page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (info) => info.name === "jobctrl-demo",
      )
    )
      throw new Error("The real demo aggregate has not been created.");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("jobctrl-demo");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const row = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const request = database
            .transaction("workspace", "readonly")
            .objectStore("workspace")
            .get("current");
          request.onsuccess = () =>
            resolve(request.result as Record<string, unknown>);
          request.onerror = () => reject(request.error);
        },
      );
      const snapshot = row["snapshot"] as {
        workspaceId: string;
        resetEpoch: number;
        revision: number;
        state: {
          readModel: {
            profile: {
              config: {
                profileVersion: number;
                profile: { experience: { target_role?: string } };
              };
            };
          };
        };
      };
      return {
        workspaceId: snapshot.workspaceId,
        resetEpoch: snapshot.resetEpoch,
        revision: snapshot.revision,
        profileVersion: snapshot.state.readModel.profile.config.profileVersion,
        targetRole:
          snapshot.state.readModel.profile.config.profile.experience
            .target_role ?? "",
      };
    } finally {
      database.close();
    }
  });
}
