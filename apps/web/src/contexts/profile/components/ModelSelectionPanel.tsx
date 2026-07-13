import {
  ProviderIds,
  type ProviderId,
  type ProviderModelCatalogItem,
  type SettingsUpdateRequest,
} from "@jobctrl/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { useProviderModelsQuery } from "../hooks/useProviderModelsQuery.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";

const PROVIDER_COPY: Readonly<Record<ProviderId, { title: string; description: string }>> = {
  codex: {
    title: "Codex",
    description: "Choose from the models exposed by your authenticated Codex App Server.",
  },
  claude: {
    title: "Claude",
    description: "Choose a provider-safe alias that works across supported Claude authentication routes.",
  },
  google: {
    title: "Google",
    description: "Choose from the models exposed by your authenticated Gemini or Vertex connection.",
  },
};

export function ModelSelectionPanel() {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const settingsQuery = useSettingsQuery();
  const catalogQuery = useProviderModelsQuery();
  const settings = settingsQuery.data?.settings;
  const modelOverride = settingsQuery.data?.effectiveSettings.llmModelOverride;
  const providers = new Map(
    (catalogQuery.data?.providers ?? []).map((provider) => [provider.provider, provider]),
  );

  return (
    <section className="card full model-selection-shell">
      <CardHeader title="Model selection" meta="new work" />
      <div className="model-selection-intro">
        <p>
          Configure at least one provider before choosing its preferred model. One provider is enough;
          a second is recommended for resilience, not required.
        </p>
        <p>
          Saved choices apply to newly started work. An explicit workflow model, then
          <code> LLM_MODEL</code>, takes precedence over these preferences.
        </p>
      </div>

      {modelOverride?.source === "environment" ? (
        <div className="banner credential-store-notice credential-store-notice--guidance" role="status">
          <code>LLM_MODEL={modelOverride.value}</code> is managed by the launch environment. Saved provider selections remain fallback preferences until this override is removed.
        </div>
      ) : null}

      {isDemo ? (
        <div className="banner credential-store-notice credential-store-notice--guidance" role="status">
          This browser-local demo shows a synthetic model catalog for preview only. Provider
          connections and model changes are unavailable here.
        </div>
      ) : null}

      {settingsQuery.error ? (
        <div className="banner inline" role="alert">
          Current model preferences are unavailable. Reload this page before making a change.
        </div>
      ) : null}
      {catalogQuery.error ? (
        <div className="banner inline model-catalog-error" role="alert">
          <span>Available models could not be loaded. Provider credentials were not changed.</span>
          <button className="tab" type="button" onClick={() => void catalogQuery.refetch()}>
            retry catalog
          </button>
        </div>
      ) : null}

      <div
        className="provider-card-list model-selection-list"
        aria-busy={settingsQuery.isPending || catalogQuery.isPending}
      >
        {ProviderIds.map((providerId) => (
          <ProviderModelCard
            key={providerId}
            catalog={providers.get(providerId)}
            catalogPending={catalogQuery.isPending}
            isDemo={isDemo}
            provider={providerId}
            savedModel={settings?.preferredModels[providerId]}
            settingsReady={Boolean(settings)}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderModelCard({
  provider,
  catalog,
  savedModel,
  settingsReady,
  catalogPending,
  isDemo,
}: {
  provider: ProviderId;
  catalog: ProviderModelCatalogItem | undefined;
  savedModel: string | undefined;
  settingsReady: boolean;
  catalogPending: boolean;
  isDemo: boolean;
}) {
  const updateSettings = useUpdateSettingsMutation();
  const currentSavedModel = savedModel ?? "";
  const [draftState, setDraftState] = useState(() => ({
    base: currentSavedModel,
    value: currentSavedModel,
  }));
  const [statusMessage, setStatusMessage] = useState("");
  const providerCopy = PROVIDER_COPY[provider];
  const models = catalog?.models ?? [];
  const knownModelIds = new Set(models.map((model) => model.id));
  const draftModel =
    draftState.base === currentSavedModel
      ? draftState.value
      : draftState.value === draftState.base
        ? currentSavedModel
        : draftState.value;
  const savedModelUnavailable = Boolean(savedModel && !knownModelIds.has(savedModel));
  const draftIsValid = draftModel === "" || knownModelIds.has(draftModel);
  const catalogReady = Boolean(catalog?.ready && models.length > 0);
  const canEdit = settingsReady && catalogReady && !catalogPending && !isDemo;
  const unchanged = draftModel === currentSavedModel;
  const canSave = canEdit && draftIsValid && !unchanged && !updateSettings.isPending;
  const statusLabel = isDemo
    ? "Preview only"
    : catalogPending
      ? "Checking"
      : catalog?.ready
        ? models.length > 0
          ? "Ready"
          : "Catalog unavailable"
        : catalog?.configured
          ? "Needs attention"
          : "Configure first";

  async function persistPreference(nextModel: string | null) {
    setStatusMessage("");
    updateSettings.reset();
    const preferredModels: NonNullable<SettingsUpdateRequest["preferredModels"]> = {
      [provider]: nextModel,
    };
    try {
      await updateSettings.mutateAsync({ preferredModels });
      const savedValue = nextModel ?? "";
      setDraftState({ base: savedValue, value: savedValue });
      setStatusMessage(
        nextModel
          ? `${providerCopy.title} preference saved for newly started work.`
          : `${providerCopy.title} will use its provider default for newly started work.`,
      );
    } catch {
      setStatusMessage("Could not save this model. Refresh the catalog and try again.");
    }
  }

  async function savePreference() {
    if (!canSave) return;
    await persistPreference(draftModel || null);
  }

  async function clearPreference() {
    if (!settingsReady || !savedModel || isDemo || updateSettings.isPending) return;
    await persistPreference(null);
  }

  return (
    <article className="provider-card model-selection-card" data-provider={provider}>
      <header className="provider-card-header">
        <div>
          <h3>{providerCopy.title}</h3>
          <p>{providerCopy.description}</p>
        </div>
        <span className={`tag ${catalogReady && !isDemo ? "ok" : "muted"}`}>{statusLabel}</span>
      </header>

      <p className="provider-model-source">
        {catalog?.source === "provider_aliases"
          ? "Provider-safe aliases; your Claude route resolves the concrete model."
          : "Live availability from the authenticated provider connection."}
      </p>
      {catalog?.message ? <p className="provider-status-message">{catalog.message}</p> : null}

      {!catalogPending && !catalog?.ready && !isDemo ? (
        <div className="provider-model-empty">
          <p>Finish and verify this provider before selecting a model.</p>
          <Link className="tab" to="/settings/credentials">
            configure {providerCopy.title}
          </Link>
        </div>
      ) : (
        <div className="provider-model-form">
          <label className="field" htmlFor={`preferred-model-${provider}`}>
            <span>Preferred model</span>
            <select
              id={`preferred-model-${provider}`}
              value={draftModel}
              disabled={!canEdit}
              onChange={(event) => {
                setDraftState({ base: currentSavedModel, value: event.target.value });
                setStatusMessage("");
                updateSettings.reset();
              }}
            >
              <option value="">Provider default</option>
              {savedModelUnavailable ? (
                <option value={savedModel} disabled>{savedModel} (no longer available)</option>
              ) : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}{model.isDefault ? " · provider default" : ""}
                </option>
              ))}
            </select>
            <small className="field-hint">
              {savedModel
                ? `Saved: ${savedModel}`
                : "No saved preference; the provider chooses its default."}
            </small>
          </label>
          <button
            className="tab on"
            type="button"
            disabled={!canSave}
            onClick={() => void savePreference()}
          >
            {updateSettings.isPending ? "saving" : "save model"}
          </button>
        </div>
      )}

      {savedModel && !isDemo ? (
        <button
          className="tab provider-model-clear"
          type="button"
          disabled={!settingsReady || updateSettings.isPending}
          onClick={() => void clearPreference()}
        >
          clear saved model
        </button>
      ) : null}

      {statusMessage ? (
        <p className="provider-model-save-status" role={updateSettings.isError ? "alert" : "status"}>
          {statusMessage}
        </p>
      ) : null}
    </article>
  );
}
