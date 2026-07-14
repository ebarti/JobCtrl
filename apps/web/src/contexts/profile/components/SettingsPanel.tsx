import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
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
    <DisclosureSection
      className="general-cost-capacity-settings"
      title="Cost and capacity"
      description="Daily spend, application concurrency, and worker capacity"
      collapsedSummary="Execution limits and worker restart state"
    >
      {errorMessage ? <div className="banner inline" role="alert">{errorMessage}</div> : null}
      {settings ? (
        <SettingsForm
          initial={settings}
          effectiveSettings={settingsQuery.data!.effectiveSettings}
          {...(healthQuery.data?.worker.heartbeat?.maxConcurrentActivities !== undefined
            ? {
                activeWorkerActivitySlots:
                  healthQuery.data.worker.heartbeat.maxConcurrentActivities,
              }
            : {})}
          {...(healthQuery.data?.worker.status !== undefined
            ? { workerStatus: healthQuery.data.worker.status }
            : {})}
        />
      ) : (
        <Empty title="Loading config." />
      )}
    </DisclosureSection>
  );
}
