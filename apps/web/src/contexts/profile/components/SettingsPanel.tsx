import type { DashboardSettings } from "@jobhunter/contracts";
import { useCallback, useEffect, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";

export function SettingsPanel() {
  const ports = usePorts();
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [originalSettings, setOriginalSettings] = useState<DashboardSettings | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setStatus("");
    try {
      const settingsResponse = await ports.api.settings();
      setSettings(settingsResponse.settings);
      setOriginalSettings(settingsResponse.settings);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to load settings.",
      );
    }
  }, [ports.api]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof DashboardSettings>(key: K, value: DashboardSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };

  const dirty = Boolean(
    settings && originalSettings && JSON.stringify(settings) !== JSON.stringify(originalSettings),
  );

  const save = async () => {
    if (!settings) {
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await ports.api.updateSettings(settings);
      setSettings(response.settings);
      setOriginalSettings(response.settings);
      setStatus("settings saved");
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to save settings.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card full">
      <CardHeader title="Config" meta="scoring and targeting" />
      {error ? <div className="banner inline">{error}</div> : null}
      {status ? <div className="status-line">{status}</div> : null}
      {settings ? (
        <form
          className="config-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span>Minimum fit score</span>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              value={settings.minFitScore}
              onChange={(event) => update("minFitScore", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>Apply concurrency</span>
            <input
              type="number"
              min={1}
              max={16}
              step={1}
              value={settings.applyConcurrency}
              onChange={(event) => update("applyConcurrency", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>Target role</span>
            <input
              value={settings.targetRole}
              onChange={(event) => update("targetRole", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Location filter</span>
            <input
              value={settings.locationFilter}
              onChange={(event) => update("locationFilter", event.target.value)}
            />
          </label>
          <label className="field wide">
            <span>Score criteria</span>
            <textarea
              placeholder="Criteria the scoring step should use when ranking jobs."
              value={settings.scoreCriteria}
              onChange={(event) => update("scoreCriteria", event.target.value)}
            />
          </label>
          <label className="field wide">
            <span>Targeting criteria</span>
            <textarea
              placeholder="Role, company, location, seniority, and exclusion criteria for the search pipeline."
              value={settings.targetCriteria}
              onChange={(event) => update("targetCriteria", event.target.value)}
            />
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={settings.autoApply}
              onChange={(event) => update("autoApply", event.target.checked)}
            />
            <span>Auto apply</span>
          </label>
          <div className="form-actions">
            <button className="tab on" type="submit" disabled={!dirty || busy}>
              {busy ? "saving" : "save"}
            </button>
            <button
              className="tab"
              type="button"
              disabled={!dirty || busy || !originalSettings}
              onClick={() => originalSettings && setSettings(originalSettings)}
            >
              reset
            </button>
            <button className="tab" type="button" disabled={busy} onClick={() => void load()}>
              reload
            </button>
          </div>
        </form>
      ) : (
        <Empty title="Loading config." />
      )}
    </section>
  );
}
