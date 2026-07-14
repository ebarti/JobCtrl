import {
  ProviderIds,
  type ProviderId,
  type ProviderModelCatalogItem,
  type SettingsUpdateRequest,
} from "@jobctrl/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { AdaptiveFieldGrid } from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { SelectField } from "../../../shared/ui/select-field.js";
import { useProviderModelsQuery } from "../hooks/useProviderModelsQuery.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";

const PROVIDER_DEFAULT_OPTION = "__jobctrl_provider_default__";

const PROVIDER_COPY: Readonly<Record<ProviderId, { title: string; description: string }>> = {
  codex: {
    title: "Codex",
    description: "Choose from the models exposed by your authenticated Codex App Server.",
  },
  claude: {
    title: "Claude",
    description: "Choose from the models exposed by your authenticated Claude Agent SDK runtime.",
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
  const providers = new Map(
    (catalogQuery.data?.providers ?? []).map((provider) => [provider.provider, provider]),
  );
  const readyProviderCount = ProviderIds.filter((providerId) => {
    const provider = providers.get(providerId);
    return provider?.ready && provider.models.length > 0;
  }).length;
  const savedPreferenceCount = ProviderIds.filter(
    (providerId) => settings?.preferredModels[providerId],
  ).length;
  const collapsedSummary = isDemo
    ? `Preview only · ${savedChoiceCount(savedPreferenceCount)}`
    : catalogQuery.error
      ? `Catalog unavailable · ${savedChoiceCount(savedPreferenceCount)}`
      : catalogQuery.isPending
        ? `Checking provider catalog · ${savedChoiceCount(savedPreferenceCount)}`
        : `${readyProviderCount} of ${ProviderIds.length} providers ready · ${savedChoiceCount(savedPreferenceCount)}`;

  return (
    <DisclosureSection
      className="model-selection-settings"
      title="Model selection"
      description="Preferred provider models for newly started work"
      collapsedSummary={collapsedSummary}
    >
      <div className="model-selection-settings__content grid gap-4">
        <div className="model-selection-guidance grid max-w-[76ch] gap-1.5 text-[12px] leading-5 text-muted-foreground">
          <p className="m-0">
            Configure at least one provider before choosing its preferred model. One provider is
            enough; a second is recommended for resilience, not required.
          </p>
          <p className="m-0">
            Saved choices in <code className="font-mono text-foreground">config.json</code> apply
            to newly started work. An explicit per-workflow model takes precedence when that
            workflow supports one.
          </p>
        </div>

        {isDemo ? (
          <p className="model-selection-demo-status m-0 text-[12px] leading-5 text-muted-foreground" role="status">
            This browser-local demo shows a synthetic model catalog for preview only. Provider
            connections and model changes are unavailable here.
          </p>
        ) : null}

        {settingsQuery.error ? (
          <p className="model-selection-error m-0 text-[12px] leading-5 text-destructive" role="alert">
            Current model preferences are unavailable. Reload this page before making a change.
          </p>
        ) : null}
        {catalogQuery.error ? (
          <div className="model-catalog-error flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-[12px] leading-5 text-destructive" role="alert">
              Available models could not be loaded. Provider credentials were not changed.
            </p>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void catalogQuery.refetch()}
            >
              Retry catalog
            </Button>
          </div>
        ) : null}

        <div
          className="model-provider-preferences grid gap-3"
          aria-busy={settingsQuery.isPending || catalogQuery.isPending}
        >
          {ProviderIds.map((providerId) => (
            <ProviderModelPreference
              key={providerId}
              catalog={providers.get(providerId)}
              catalogPending={catalogQuery.isPending}
              isDemo={isDemo}
              provider={providerId}
              savedModel={settings?.preferredModels[providerId]}
              settingsPending={settingsQuery.isPending}
              settingsReady={Boolean(settings)}
            />
          ))}
        </div>
      </div>
    </DisclosureSection>
  );
}

function ProviderModelPreference({
  provider,
  catalog,
  savedModel,
  settingsReady,
  settingsPending,
  catalogPending,
  isDemo,
}: {
  provider: ProviderId;
  catalog: ProviderModelCatalogItem | undefined;
  savedModel: string | undefined;
  settingsReady: boolean;
  settingsPending: boolean;
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
  const savedChoiceLabel = settingsReady
    ? savedModel || "Provider default"
    : settingsPending
      ? "Checking saved choice"
      : "Saved choice unavailable";
  const modelOptions = [
    { value: PROVIDER_DEFAULT_OPTION, label: "Provider default" },
    ...(savedModelUnavailable && savedModel
      ? [{ value: savedModel, label: `${savedModel} (no longer available)`, disabled: true }]
      : []),
    ...models.map((model) => ({
      value: model.id,
      label: `${modelOptionLabel(model.displayName, model.id)}${model.isDefault ? " · provider default" : ""}`,
    })),
  ];

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
    <article className="provider-model-preference" data-provider={provider}>
      <DisclosureSection
        className="provider-preference-disclosure"
        title={providerCopy.title}
        description={providerCopy.description}
        collapsedSummary={`Status: ${statusLabel} · Saved: ${savedChoiceLabel}`}
      >
        <div className="provider-preference-content grid gap-4">
          <div className="provider-preference-status grid gap-1 text-[12px] leading-5 text-muted-foreground">
            <p className="m-0">Status: {statusLabel}</p>
            <p className="m-0">Saved choice: {savedChoiceLabel}</p>
            <p className="m-0">Live availability from the authenticated provider runtime.</p>
            {catalog?.message ? <p className="m-0">{catalog.message}</p> : null}
          </div>

          {!catalogPending && !catalog?.ready && !isDemo ? (
            <div className="provider-preference-empty grid justify-items-start gap-3">
              <p className="m-0 text-[12px] leading-5 text-muted-foreground">
                Finish and verify this provider before selecting a model.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link to="/settings/credentials">Configure {providerCopy.title}</Link>
              </Button>
            </div>
          ) : (
            <AdaptiveFieldGrid columns="auto" minColumnWidth={280} density="compact">
              <SelectField
                id={`preferred-model-${provider}`}
                name={`preferred-model-${provider}`}
                className="provider-preference-field"
                label="Preferred model"
                description={
                  savedModelUnavailable
                    ? `Saved: ${savedModel}. This model is no longer available in the provider catalog.`
                    : savedModel
                      ? `Saved: ${savedModel}`
                      : "No saved preference; the provider chooses its default."
                }
                disabled={!canEdit}
                options={modelOptions}
                value={draftModel || PROVIDER_DEFAULT_OPTION}
                onValueChange={(value) => {
                  setDraftState({
                    base: currentSavedModel,
                    value: value === PROVIDER_DEFAULT_OPTION ? "" : value,
                  });
                  setStatusMessage("");
                  updateSettings.reset();
                }}
              />
              <div className="provider-preference-save-action flex items-end">
                <Button
                  size="sm"
                  type="button"
                  disabled={!canSave}
                  onClick={() => void savePreference()}
                >
                  {updateSettings.isPending ? "Saving…" : "Save model"}
                </Button>
              </div>
            </AdaptiveFieldGrid>
          )}

          {savedModel && !isDemo ? (
            <div className="provider-preference-clear-action">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                disabled={!settingsReady || updateSettings.isPending}
                onClick={() => void clearPreference()}
              >
                Clear saved model
              </Button>
            </div>
          ) : null}

          {statusMessage ? (
            <p
              className="provider-preference-save-status m-0 text-[12px] leading-5 text-muted-foreground"
              role={updateSettings.isError ? "alert" : "status"}
            >
              {statusMessage}
            </p>
          ) : null}
        </div>
      </DisclosureSection>
    </article>
  );
}

function savedChoiceCount(count: number): string {
  return `${count} saved ${count === 1 ? "choice" : "choices"}`;
}

function modelOptionLabel(displayName: string, modelId: string): string {
  const normalized = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "");
  return normalized(displayName) === normalized(modelId)
    ? displayName
    : `${displayName} · ${modelId}`;
}
