import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { SettingsForm } from "../forms/settings-form.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";

export function SettingsPanel() {
  const settingsQuery = useSettingsQuery();
  const errorMessage = settingsQuery.error?.message ?? "";
  const settings = settingsQuery.data?.settings ?? null;

  return (
    <section className="card full">
      <CardHeader title="Config" meta="execution" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {settings ? <SettingsForm initial={settings} /> : <Empty title="Loading config." />}
    </section>
  );
}
