import type { ApiHealthResponse } from "../../../shared/ports/ApiClientPort.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useHealthQuery } from "../../operations/hooks/useHealthQuery.js";
import { SettingsForm } from "../forms/settings-form.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";

export function SettingsPanel() {
  const settingsQuery = useSettingsQuery();
  const healthQuery = useHealthQuery();
  const errorMessage = settingsQuery.error?.message ?? "";
  const settings = settingsQuery.data?.settings ?? null;

  return (
    <section className="card full">
      <CardHeader title="Config" meta="execution" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {settings ? (
        <>
          <SettingsForm initial={settings} />
          <TemporalRuntimeSummary health={healthQuery.data} isLoading={healthQuery.isPending} />
        </>
      ) : (
        <Empty title="Loading config." />
      )}
    </section>
  );
}

function TemporalRuntimeSummary({
  health,
  isLoading,
}: {
  health: ApiHealthResponse | undefined;
  isLoading: boolean;
}) {
  const heartbeat = health?.worker.heartbeat ?? null;
  const unknown = isLoading ? "checking" : "unknown";

  return (
    <div className="runtime-summary" aria-label="Temporal runtime">
      <div>
        <h3>Temporal runtime</h3>
        <p>Read from the active worker heartbeat.</p>
      </div>
      <dl>
        <RuntimeMetric
          label="Activity slots"
          value={formatRuntimeNumber(heartbeat?.maxConcurrentActivities, unknown)}
        />
        <RuntimeMetric
          label="Executor threads"
          value={formatRuntimeNumber(heartbeat?.activityExecutorMaxWorkers, unknown)}
        />
        <RuntimeMetric label="Task queue" value={heartbeat?.taskQueue ?? unknown} />
        <RuntimeMetric label="Worker health" value={health?.worker.status ?? unknown} />
        <RuntimeMetric label="Startup env" value="JOBHUNTER_MAX_CONCURRENT_ACTIVITIES" />
      </dl>
    </div>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatRuntimeNumber(value: number | null | undefined, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value);
}
