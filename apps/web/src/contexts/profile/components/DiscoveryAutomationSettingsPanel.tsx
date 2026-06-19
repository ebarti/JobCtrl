import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { DiscoveryAutomationSettingsForm } from "../forms/settings-form.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";

export function DiscoveryAutomationSettingsPanel() {
  const settingsQuery = useSettingsQuery();
  const errorMessage = settingsQuery.error?.message ?? "";
  const settings = settingsQuery.data?.settings ?? null;

  return (
    <section className="card full discovery-automation-settings">
      <CardHeader title="Automation settings" meta="scoring and apply" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {settings ? (
        <DiscoveryAutomationSettingsForm initial={settings} />
      ) : (
        <Empty title="Loading automation settings." />
      )}
    </section>
  );
}
