import { useDemoWorkspace } from "./DemoWorkspaceProvider.js";

export function DemoWorkspaceNotice() {
  const context = useDemoWorkspace();
  if (context.mode === "local") {
    return null;
  }

  const { runtime } = context;
  const urgent =
    runtime.status === "upgrade_required" || runtime.warning !== null;
  const storageBoundary =
    runtime.storageMode === "indexeddb"
      ? "This workspace stays in this browser profile; it is not shared across browser profiles or through a common demo environment. Other tabs and anyone using this profile can see the same data. Do not enter personal data or secrets."
      : "This fallback workspace stays only in this tab and is not shared or retained after it closes. Do not enter personal data or secrets.";
  return (
    <section
      className="demo-workspace-notice"
      role={urgent ? "alert" : "status"}
      aria-label="Public demo data boundary"
    >
      <strong className="demo-workspace-notice__desktop-title">
        Public demo · synthetic browser-local data
      </strong>
      <span className="demo-workspace-notice__desktop-copy">
        {storageBoundary}
      </span>
      <details className="demo-workspace-disclosure">
        <summary>
          <strong>Public demo</strong>
          <span>Synthetic data · no personal data or secrets</span>
        </summary>
        <span>{storageBoundary}</span>
      </details>
      {runtime.status === "upgrade_required" ? (
        <span className="demo-workspace-notice__warning">
          {runtime.upgrade.message}
        </span>
      ) : runtime.warning ? (
        <span className="demo-workspace-notice__warning">
          {runtime.warning.message}
        </span>
      ) : null}
    </section>
  );
}
