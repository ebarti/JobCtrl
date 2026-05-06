import { useEffect, useState } from "react";

import type { DashboardSettings } from "../../operations/types.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";

export function SettingsPanel() {
  const settingsQuery = useSettingsQuery();
  const updateSettings = useUpdateSettingsMutation();

  const [draft, setDraft] = useState<DashboardSettings | null>(null);
  const [original, setOriginal] = useState<DashboardSettings | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    if (settingsQuery.data && !draft) {
      setDraft(settingsQuery.data.settings);
      setOriginal(settingsQuery.data.settings);
    }
  }, [settingsQuery.data, draft]);

  const errorMessage =
    settingsQuery.error?.message ?? updateSettings.error?.message ?? "";

  const update = <K extends keyof DashboardSettings>(key: K, value: DashboardSettings[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const dirty = Boolean(
    draft && original && JSON.stringify(draft) !== JSON.stringify(original),
  );
  const busy = updateSettings.isPending;

  const save = () => {
    if (!draft) {
      return;
    }
    setStatusMessage("");
    updateSettings.mutate(draft, {
      onSuccess: (response) => {
        setDraft(response.settings);
        setOriginal(response.settings);
        setStatusMessage("settings saved");
      },
    });
  };

  const reload = async () => {
    setStatusMessage("");
    const result = await settingsQuery.refetch();
    if (result.data) {
      setDraft(result.data.settings);
      setOriginal(result.data.settings);
    }
  };

  return (
    <section className="card full">
      <CardHeader title="Config" meta="scoring and targeting" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      {draft ? (
        <form
          className="config-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span>Minimum fit score</span>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              value={draft.minFitScore}
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
              value={draft.applyConcurrency}
              onChange={(event) => update("applyConcurrency", Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>Target role</span>
            <input
              value={draft.targetRole}
              onChange={(event) => update("targetRole", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Location filter</span>
            <input
              value={draft.locationFilter}
              onChange={(event) => update("locationFilter", event.target.value)}
            />
          </label>
          <label className="field wide">
            <span>Score criteria</span>
            <textarea
              placeholder="Criteria the scoring step should use when ranking jobs."
              value={draft.scoreCriteria}
              onChange={(event) => update("scoreCriteria", event.target.value)}
            />
          </label>
          <label className="field wide">
            <span>Targeting criteria</span>
            <textarea
              placeholder="Role, company, location, seniority, and exclusion criteria for the search pipeline."
              value={draft.targetCriteria}
              onChange={(event) => update("targetCriteria", event.target.value)}
            />
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={draft.autoApply}
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
              disabled={!dirty || busy || !original}
              onClick={() => original && setDraft(original)}
            >
              reset
            </button>
            <button className="tab" type="button" disabled={busy} onClick={() => void reload()}>
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
