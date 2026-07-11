import { useDemoWorkspace } from "./DemoWorkspaceProvider.js";

export function DemoWorkspaceNotice() {
  const context = useDemoWorkspace();
  if (context.mode === "local") {
    return null;
  }

  const { runtime } = context;
  const urgent =
    runtime.status === "upgrade_required" || runtime.warning !== null;
  return (
    <section
      className="demo-workspace-notice"
      role={urgent ? "alert" : "status"}
      aria-label="Public demo data boundary"
    >
      <strong>Public demo · synthetic browser-local data</strong>
      {runtime.storageMode === "indexeddb" ? (
        <span>
          This workspace is shared with other tabs and people using this browser
          profile. Do not enter personal data or secrets.
        </span>
      ) : (
        <span>
          This fallback workspace stays only in this tab and is not shared or
          retained after it closes. Do not enter personal data or secrets.
        </span>
      )}
      {runtime.status === "upgrade_required" ? (
        <span>{runtime.upgrade.message}</span>
      ) : runtime.warning ? (
        <span>{runtime.warning.message}</span>
      ) : null}
    </section>
  );
}
