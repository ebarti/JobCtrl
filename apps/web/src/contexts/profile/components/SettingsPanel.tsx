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
      <CardHeader title="Cost and capacity" meta="general" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {settings ? (
        <SettingsForm
          initial={settings}
          effectiveSettings={settingsQuery.data!.effectiveSettings}
          activeWorkerActivitySlots={healthQuery.data?.worker.heartbeat?.maxConcurrentActivities}
          workerStatus={healthQuery.data?.worker.status}
        />
      ) : (
        <Empty title="Loading config." />
      )}
    </section>
  );
}
