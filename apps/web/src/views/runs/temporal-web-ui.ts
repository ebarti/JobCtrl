/**
 * Temporal Web UI deep-link helper (PR 5 of the Temporal stack).
 *
 * The local Temporal dev server (`temporal server start-dev`) ships its
 * Web UI on `127.0.0.1:8233`. The default namespace is `default`. The
 * workflow id is the row's `workflowId` (which equals `runId` for apply
 * runs — the Python `ApplyWorkflow` uses `info.workflow_id` as the
 * timeline key).
 */
const TEMPORAL_WEB_UI_BASE = "http://127.0.0.1:8233";
const TEMPORAL_NAMESPACE = "default";

export function temporalWebUiWorkflowUrl(workflowId: string): string {
  return `${TEMPORAL_WEB_UI_BASE}/namespaces/${TEMPORAL_NAMESPACE}/workflows/${encodeURIComponent(
    workflowId,
  )}`;
}
