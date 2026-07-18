import {
  ProviderIds,
  type ProviderId,
  type ProviderModelCatalogItem,
  type SettingsUpdateRequest,
} from "@jobctrl/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
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
      className="model-selection-shell model-selection-settings"
      collapsedSummary={collapsedSummary}
      description="Preferred provider models for newly started work"
      title="Model selection"
    >
      <div className="model-selection-intro">
        <p>
          Configure at least one provider before choosing its preferred model. One provider is enough;
          a second is recommended for resilience, not required.
        </p>
        <p>
          Saved choices in <code>config.json</code> apply to newly started work. An explicit
          per-workflow model takes precedence when that workflow supports one.
        </p>
      </div>

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
          <Button
            onClick={() => void catalogQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry catalog
          </Button>
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
    </DisclosureSection>
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
  const modelHintId = `preferred-model-${provider}-hint`;
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
  const providerDefaultValue = `__${provider}-provider-default__`;
  const modelItems = [
    { label: "Provider default", value: providerDefaultValue },
    ...(savedModelUnavailable && savedModel ? [{ label: `${savedModel} (no longer available)`, value: savedModel }] : []),
    ...models.map((model) => ({ label: `${modelOptionLabel(model.displayName, model.id)}${model.isDefault ? " · provider default" : ""}`, value: model.id })),
  ];
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
    : "Checking saved choice";

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
      <DisclosureSection
        actions={(
          <span className={`tag ${catalogReady && !isDemo ? "ok" : "muted"}`}>
            {statusLabel}
          </span>
        )}
        className="provider-disclosure provider-preference-disclosure"
        collapsedSummary={`Saved: ${savedChoiceLabel}`}
        defaultOpen={false}
        description={providerCopy.description}
        headingLevel={3}
        title={providerCopy.title}
      >

      <p className="provider-model-source">
        Live availability from the authenticated provider runtime.
      </p>
      {catalog?.message ? <p className="provider-status-message">{catalog.message}</p> : null}

      {!catalogPending && !catalog?.ready && !isDemo ? (
        <div className="provider-model-empty">
          <p>Finish and verify this provider before selecting a model.</p>
          <Link className="tab" to="/settings/credentials">
            Configure {providerCopy.title}
          </Link>
        </div>
      ) : (
        <div className="provider-model-form">
          <Field className="field">
            <FieldLabel htmlFor={`preferred-model-${provider}`}>Preferred model</FieldLabel>
            <Select
              name={`preferred-model-${provider}`}
              items={modelItems}
              value={draftModel || providerDefaultValue}
              disabled={!canEdit}
              onValueChange={(nextValue) => {
                if (nextValue === null) return;
                setDraftState({ base: currentSavedModel, value: nextValue === providerDefaultValue ? "" : nextValue });
                setStatusMessage("");
                updateSettings.reset();
              }}
            >
              <SelectTrigger id={`preferred-model-${provider}`} aria-label="Preferred model" aria-describedby={modelHintId} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{modelItems.map((item) => <SelectItem key={item.value} value={item.value} disabled={savedModelUnavailable && item.value === savedModel}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <FieldDescription className="field-hint" id={modelHintId}>
              {savedModel
                ? `Saved: ${savedModel}`
                : "No saved preference; the provider chooses its default."}
            </FieldDescription>
          </Field>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => void savePreference()}
          >
            {updateSettings.isPending ? "Saving" : "Save model"}
          </Button>
        </div>
      )}

      {savedModel && !isDemo ? (
        <Button
          className="provider-model-clear"
          type="button"
          disabled={!settingsReady || updateSettings.isPending}
          onClick={() => void clearPreference()}
          size="sm"
          variant="outline"
        >
          Clear saved model
        </Button>
      ) : null}

      {statusMessage ? (
        <p className="provider-model-save-status" role={updateSettings.isError ? "alert" : "status"}>
          {statusMessage}
        </p>
      ) : null}
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
