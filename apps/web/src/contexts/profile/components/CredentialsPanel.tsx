import type {
  CredentialBatchUpdateRequest,
  CredentialKey,
  CredentialsResponse,
  ProviderId,
  ProviderStatusItem,
} from "@jobctrl/contracts";
import { useMutationState } from "@tanstack/react-query";
import { IconInfoCircle } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Badge } from "../../../shared/ui/badge.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import {
  ClaudeProviderForm,
  GoogleProviderForm,
  providerModeLabel,
} from "../forms/provider-setup-forms.js";
import { CredentialForm } from "../forms/credential-form.js";
import { useCredentialsQuery } from "../hooks/useCredentialsQuery.js";
import { useProviderStatusQuery } from "../hooks/useProviderStatusQuery.js";
import { useUpdateCredentialsBatchMutation } from "../hooks/useUpdateCredentialsBatchMutation.js";
import { useVerifyCodexProviderMutation } from "../hooks/useVerifyCodexProviderMutation.js";
import { removeLegacyOpenAiKeyBatch } from "../lib/provider-credential-plans.js";
import { profileKeys } from "../queryKeys.js";

export function credentialLabel(key: CredentialKey): string {
  return key
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function CredentialsPanel() {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const credentialsQuery = useCredentialsQuery();
  const providerStatusQuery = useProviderStatusQuery();
  const credentials = credentialsQuery.data?.credentials ?? [];
  const store = credentialsQuery.data?.store;
  const statuses = providerStatusQuery.data?.providers ?? [];
  const configured = (keys: readonly CredentialKey[]) =>
    keys.some((key) => {
      const source = credentials.find((entry) => entry.key === key)?.effectiveSource;
      return source === "environment" || source === "keychain" || source === "config";
    });
  const claudeConfigured = configured(CLAUDE_KEYS);
  const googleConfigured = configured(GOOGLE_KEYS);
  const codexStatus = findStatus(statuses, "codex");
  const claudeStatus = findStatus(statuses, "claude");
  const googleStatus = findStatus(statuses, "google");
  const environmentManagedKeys = credentials.filter((entry) => entry.effectiveSource === "environment").map((entry) => entry.key);
  const capSolver = credentials.find((entry) => entry.key === "CAPSOLVER_API_KEY");
  const claudeCurrentMode = inferConfiguredMode(
    credentials,
    CLAUDE_MODE_KEYS,
    claudeStatus?.mode,
  );
  const googleCurrentMode = inferConfiguredMode(
    credentials,
    GOOGLE_MODE_KEYS,
    googleStatus?.mode,
  );
  const {
    hasUnsavedChanges,
    markProviderConfigurationChanged,
  } = useProviderConfigurationChanges();

  if (isDemo) {
    return <DemoProviderSetup />;
  }

  return (
    <>
      <DisclosureSection
        className="provider-setup-shell provider-setup-disclosure"
        collapsedSummary={providerSetupSummary(store, statuses)}
        defaultOpen
        description="Provider authentication, ownership, and runtime readiness"
        title="LLM providers"
      >
        <ProviderSetupNotice
          credentialsError={credentialsQuery.error?.message}
          hasUnsavedChanges={hasUnsavedChanges}
          providerStatusError={providerStatusQuery.error?.message}
          store={store}
        />
        {!store ? (
          <div className="empty" role="status">Checking provider setup.</div>
        ) : (
          <div className="provider-card-list">
            <ProviderCard
              description="Reuses an already authenticated normal Codex CLI first, then verifies it in JobCtrl's isolated Codex home. JobCtrl does not accept a raw OpenAI key."
              provider="codex"
              status={codexStatus}
              title="Codex"
            >
              <CodexProviderSetup
                isolatedAuthDetected={codexStatus?.mode === "cli_auth"}
                legacyOpenAiKeyConfigured={
                  store.available && configured(["OPENAI_API_KEY"])
                }
              />
            </ProviderCard>
            {store.available || store.unavailableReason === "unsupported_platform" ? (
              <>
                <ProviderCard
                  description="Choose one direct or third-party Claude Agent SDK authentication route."
                  provider="claude"
                  status={mergeConfiguredStatus("claude", claudeStatus, claudeConfigured)}
                  title="Claude"
                  ownership={providerOwnership(credentials, CLAUDE_KEYS, claudeStatus)}
                  onConfigurationChange={() => markProviderConfigurationChanged("claude")}
                >
                  <ClaudeProviderForm
                    configured={claudeConfigured}
                    currentMode={claudeCurrentMode}
                    environmentManagedKeys={environmentManagedKeys}
                    secretStorageAvailable={store.available}
                  />
                </ProviderCard>
                <ProviderCard
                  description="Use a Gemini API key or Google Vertex AI with Application Default Credentials."
                  provider="google"
                  status={mergeConfiguredStatus("google", googleStatus, googleConfigured)}
                  title="Google"
                  ownership={providerOwnership(credentials, GOOGLE_KEYS, googleStatus)}
                  onConfigurationChange={() => markProviderConfigurationChanged("google")}
                >
                  <GoogleProviderForm
                    configured={googleConfigured}
                    currentMode={googleCurrentMode}
                    environmentManagedKeys={environmentManagedKeys}
                    secretStorageAvailable={store.available}
                  />
                </ProviderCard>
              </>
            ) : (
              <ReadOnlyProviderGuidance
                includeCodex={false}
                reason={store.unavailableReason}
              />
            )}
          </div>
        )}
      </DisclosureSection>
      {store && capSolver ? (
        <DisclosureSection
          className="provider-setup-shell provider-disclosure provider-disclosure--capsolver"
          collapsedSummary={`${credentialStatusLabel(capSolver)} · optional · restart required`}
          defaultOpen={false}
          description="A CapSolver key only enables JobCtrl's owned solver tool during a user-started Apply. Unsupported or unconfigured CAPTCHA always fails closed."
          title="Apply CAPTCHA solver"
        >
          <CredentialForm
            credentialKey="CAPSOLVER_API_KEY"
            label="CapSolver API key"
            configured={capSolver.configured}
            effectiveSource={capSolver.effectiveSource}
            editable={capSolver.editable}
            available={store.available}
            {...(store.unavailableReason !== null
              ? { unavailableReason: store.unavailableReason }
              : {})}
          />
        </DisclosureSection>
      ) : null}
      <CredentialPrivacyNotice store={store} />
    </>
  );
}

type EditableProviderId = "claude" | "google";

function useProviderConfigurationChanges() {
  const tenantId = useTenantId();
  const successfulUpdates = useMutationState({
    filters: {
      mutationKey: [...profileKeys.credentials(tenantId), "batch"],
      status: "success",
    },
    select: (mutation) => mutation,
  });
  const handledUpdates = useRef(new WeakSet<object>());
  const [changedProviders, setChangedProviders] = useState<ReadonlySet<EditableProviderId>>(
    () => new Set(),
  );

  useEffect(() => {
    const savedProviders = new Set<EditableProviderId>();
    for (const mutation of successfulUpdates) {
      if (handledUpdates.current.has(mutation)) continue;
      handledUpdates.current.add(mutation);
      const request = mutation.state.variables as CredentialBatchUpdateRequest | undefined;
      if (!request) continue;
      const updatedKeys = new Set(request.operations.map((operation) => operation.key));
      if (CLAUDE_MODE_KEYS.some(([key]) => updatedKeys.has(key))) {
        savedProviders.add("claude");
      }
      if (GOOGLE_MODE_KEYS.some(([key]) => updatedKeys.has(key))) {
        savedProviders.add("google");
      }
    }
    if (savedProviders.size === 0) return;
    setChangedProviders((current) => {
      if (![...savedProviders].some((provider) => current.has(provider))) return current;
      const next = new Set(current);
      for (const provider of savedProviders) next.delete(provider);
      return next;
    });
  }, [successfulUpdates]);

  function markProviderConfigurationChanged(provider: EditableProviderId) {
    setChangedProviders((current) => {
      if (current.has(provider)) return current;
      return new Set(current).add(provider);
    });
  }

  return {
    hasUnsavedChanges: changedProviders.size > 0,
    markProviderConfigurationChanged,
  };
}

function ProviderSetupNotice({
  credentialsError,
  hasUnsavedChanges,
  providerStatusError,
  store,
}: {
  credentialsError?: string | undefined;
  hasUnsavedChanges: boolean;
  providerStatusError?: string | undefined;
  store?: CredentialsResponse["store"] | undefined;
}) {
  if (credentialsError) {
    return <div className="banner credential-store-notice credential-store-notice--failure" role="alert">{credentialsError}</div>;
  }
  if (!store) {
    return null;
  }
  if (store.unavailableReason === "unsupported_platform") {
    return (
      <div className="banner credential-store-notice credential-store-notice--guidance">
        Non-secret provider settings remain editable in config.json. API-key entry is unavailable until this platform has a supported secure-storage adapter; externally authenticated cloud routes remain available.
      </div>
    );
  }
  if (store.unavailableReason === "inspection_failed") {
    return (
      <div className="banner credential-store-notice credential-store-notice--failure" role="alert">
        JobCtrl could not safely inspect Keychain. Unlock Keychain Access, then reload before changing Claude or Google setup. Codex verification remains available.
      </div>
    );
  }
  if (!hasUnsavedChanges) {
    return providerStatusError ? (
      <div className="banner credential-store-notice credential-store-notice--failure" role="status">
        Live provider status is unavailable; saved-key indicators are still shown.
      </div>
    ) : null;
  }
  return (
    <Alert
      aria-label="Provider settings storage"
      className="mx-5 mt-3 mb-1 w-auto"
      role="note"
    >
      <IconInfoCircle aria-hidden="true" />
      <AlertTitle>Provider settings storage</AlertTitle>
      <AlertDescription>
        <p>
          Provider modes and non-secret connection fields are saved in config.json. API keys
          stay in macOS Keychain. Restart JobCtrl after a change so provider processes reload
          both sources.
        </p>
        {providerStatusError ? (
          <p className="provider-status-warning" role="status">
            Live provider status is unavailable; saved-key indicators are still shown.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function ProviderCard({
  provider,
  title,
  description,
  status,
  children,
  ownership,
  onConfigurationChange,
}: {
  provider: ProviderId;
  title: string;
  description: string;
  status?: ProviderStatusItem | undefined;
  children: ReactNode;
  ownership?: string | undefined;
  onConfigurationChange?: (() => void) | undefined;
}) {
  const statusLabel = status?.ready
    ? "Ready"
    : provider === "codex" && status?.mode === "cli_auth"
      ? "Authenticated · runtime unavailable"
      : status?.configured
        ? "Configured · restart or verify"
        : "Not configured";
  const statusMessage = visibleProviderStatusMessage(provider, status);
  const visibleOwnership = ownership === "not configured" ? undefined : ownership;
  const detectedMode =
    provider === "claude" || provider === "google"
      ? providerModeLabel(provider, status?.mode)
      : null;
  const summary = [
    detectedMode ? `Detected mode: ${detectedMode}` : null,
    visibleOwnership ? `Effective ownership: ${visibleOwnership}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <article
      className="provider-card"
      data-provider={provider}
      onChangeCapture={onConfigurationChange}
    >
      <DisclosureSection
        actions={<span className={`tag ${status?.ready ? "ok" : "muted"}`}>{statusLabel}</span>}
        className="provider-disclosure"
        collapsedSummary={summary || "Provider configuration"}
        defaultOpen={false}
        description={description}
        headingLevel={3}
        title={title}
      >
      {detectedMode ? (
        <p className="provider-current-mode">Detected mode: {detectedMode}</p>
      ) : null}
      {visibleOwnership ? <p className="provider-current-mode">Effective ownership: {visibleOwnership}</p> : null}
      {statusMessage ? <p className="provider-status-message">{statusMessage}</p> : null}
      {children}
      </DisclosureSection>
    </article>
  );
}

const PROVIDER_READY_MESSAGES = {
  claude: "Claude provider is ready",
  codex: "Codex CLI authentication is ready",
  google: "Google provider is ready",
} as const satisfies Record<ProviderId, string>;

function visibleProviderStatusMessage(
  provider: ProviderId,
  status: ProviderStatusItem | undefined,
): string | undefined {
  const message = status?.message;
  if (!message || !status.ready) return message;
  return message.trim().replace(/\.$/, "") === PROVIDER_READY_MESSAGES[provider]
    ? undefined
    : message;
}

function CodexProviderSetup({
  isolatedAuthDetected,
  legacyOpenAiKeyConfigured,
}: {
  isolatedAuthDetected: boolean;
  legacyOpenAiKeyConfigured: boolean;
}) {
  const verify = useVerifyCodexProviderMutation();
  const removeLegacyKey = useUpdateCredentialsBatchMutation();
  const [legacyMessage, setLegacyMessage] = useState("");
  const verification = verify.data?.verification;
  const verificationMessage = verify.error
    ? "Codex verification could not be completed. Check that the worker is running and retry."
    : verification?.message ?? "";

  async function removeLegacy() {
    setLegacyMessage("");
    try {
      await removeLegacyKey.mutateAsync(removeLegacyOpenAiKeyBatch());
      setLegacyMessage("Legacy OPENAI_API_KEY removed from JobCtrl Keychain.");
    } catch {
      setLegacyMessage("Could not remove the legacy Keychain value. Unlock Keychain Access and retry.");
    }
  }

  return (
    <div className="provider-form codex-provider-setup">
      <p className="provider-copy">
        For authentication and setup, see the{" "}
        <a href="https://jobctrl.dev/user/configuration#codex">JobCtrl Codex guide</a>.
      </p>
      {legacyOpenAiKeyConfigured ? (
        <div className="provider-legacy-warning">
          <p>
            A legacy <code>OPENAI_API_KEY</code> exists in JobCtrl Keychain. The Codex runtime does not use it directly; complete Codex enrollment first, then remove this unused copy.
          </p>
          <button
            className="tab"
            disabled={removeLegacyKey.isPending}
            type="button"
            onClick={() => void removeLegacy()}
          >
            {removeLegacyKey.isPending ? "Removing…" : "Remove legacy key"}
          </button>
        </div>
      ) : null}
      <div className="provider-form-footer">
        <button
          className="tab on"
          disabled={verify.isPending}
          type="button"
          onClick={() => verify.mutate()}
        >
          {verify.isPending
            ? "Verifying…"
            : isolatedAuthDetected
              ? "Verify isolated login"
              : "Reuse existing login or verify"}
        </button>
        <div
          aria-live="polite"
          className={verification?.ok === false || verify.error ? "provider-form-message warning" : "provider-form-message"}
          role="status"
        >
          {verificationMessage}
        </div>
        {legacyMessage ? <div aria-live="polite" className="provider-form-message" role="status">{legacyMessage}</div> : null}
      </div>
    </div>
  );
}

function ReadOnlyProviderGuidance({
  includeCodex = true,
  reason,
}: {
  includeCodex?: boolean;
  reason: "inspection_failed" | "unsupported_platform" | null;
}) {
  const providers = [
    ["Codex", "Authenticate the isolated Codex CLI home from a terminal, then verify it with jobctrl doctor or the Codex CLI status command."],
    ["Claude", "Set one supported Claude SDK authentication route in the worker environment."],
    ["Google", "Set GEMINI_API_KEY or configure Vertex AI Application Default Credentials in the worker environment."],
  ].filter(([title]) => includeCodex || title !== "Codex");
  return (
    <>
      {providers.map(([title, copy]) => (
        <article className="provider-card provider-card--readonly" key={title}>
          <DisclosureSection
            actions={<span className="tag muted">Read only</span>}
            className="provider-disclosure provider-disclosure--readonly"
            collapsedSummary="Ownership: external provider environment"
            defaultOpen={false}
            description={copy}
            headingLevel={3}
            title={title}
          >
            <p>Guided editing is unavailable; configure this provider in its external environment.</p>
          </DisclosureSection>
        </article>
      ))}
      {reason === "inspection_failed" ? (
        <p className="provider-readonly-summary" role="alert">Keychain inspection must succeed before guided Claude and Google editing is restored.</p>
      ) : null}
    </>
  );
}

function DemoProviderSetup() {
  return (
    <DisclosureSection
      className="provider-setup-shell provider-setup-disclosure"
      collapsedSummary="Public demo · read only"
      defaultOpen
      description="Provider authentication, ownership, and runtime readiness"
      title="LLM providers"
    >
      <div className="banner credential-store-notice credential-store-notice--guidance">
        The public demo never accepts, checks, or stores provider secrets. Configure providers only in a local JobCtrl installation.
      </div>
      <div className="provider-card-list">
        <ReadOnlyProviderGuidance reason={null} />
      </div>
    </DisclosureSection>
  );
}

function CredentialPrivacyNotice({
  store,
}: {
  store?: CredentialsResponse["store"] | undefined;
}) {
  const boundaryCopy = store?.available
    ? "Claude and Google values saved here stay on this Mac in Keychain."
    : store?.unavailableReason === "unsupported_platform"
      ? "Claude and Google credentials are configured through the worker environment on this platform."
      : store?.unavailableReason === "inspection_failed"
        ? "Claude and Google Keychain state is unavailable until inspection succeeds."
        : "Provider credential storage status is loading.";
  const boundaryBadge = store?.available
    ? "macOS Keychain"
    : store?.unavailableReason === "unsupported_platform"
      ? "Process environment"
      : store?.unavailableReason === "inspection_failed"
        ? "Keychain status unavailable"
        : "Storage status loading";
  return (
    <DisclosureSection
      aria-label="Credential privacy"
      className="privacy-box credential-privacy-disclosure"
      collapsedSummary={boundaryBadge}
      defaultOpen={false}
      description="Storage boundaries and data-handling guarantees"
      title="Your provider data stays private"
    >
      <p className="privacy-box-copy">
        {boundaryCopy} Codex authentication stays in JobCtrl's isolated filesystem home. Credentials are never returned by the API, stored in SQLite, placed in URLs, or written to logs, traces, and generated artifacts. Cloud credential files remain managed by their vendor CLIs.
      </p>
      <div className="privacy-box-tags">
        <Badge>Local only</Badge>
        <Badge>{boundaryBadge}</Badge>
        <Badge>Never in logs</Badge>
        <Badge>Worker restart required</Badge>
      </div>
    </DisclosureSection>
  );
}

function providerSetupSummary(
  store: CredentialsResponse["store"] | undefined,
  statuses: readonly ProviderStatusItem[],
): string {
  if (!store) return "Checking provider setup";
  const readyCount = statuses.filter((status) => status.ready).length;
  const storage = store.available
    ? "macOS Keychain"
    : store.unavailableReason === "unsupported_platform"
      ? "Environment-managed secrets"
      : "Storage inspection unavailable";
  return `${readyCount} of 3 providers ready · ${storage}`;
}

function credentialStatusLabel(
  credential: CredentialsResponse["credentials"][number],
): string {
  if (credential.effectiveSource === "environment") return "Environment-managed";
  if (credential.effectiveSource === "inspection_unknown") return "Status unavailable";
  return credential.configured ? "Configured" : "Not configured";
}

function findStatus(
  statuses: readonly ProviderStatusItem[],
  provider: ProviderId,
): ProviderStatusItem | undefined {
  return statuses.find((item) => item.provider === provider);
}

function mergeConfiguredStatus(
  provider: ProviderId,
  status: ProviderStatusItem | undefined,
  keychainConfigured: boolean,
): ProviderStatusItem {
  if (!status) {
    return { provider, configured: keychainConfigured, ready: false, mode: null };
  }
  return {
    ...status,
    configured: status.configured || keychainConfigured,
    ready: status.ready,
  };
}

const CLAUDE_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_FOUNDRY",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const satisfies readonly CredentialKey[];

const GOOGLE_KEYS = ["GEMINI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"] as const satisfies readonly CredentialKey[];

function providerOwnership(
  credentials: CredentialsResponse["credentials"],
  keys: readonly CredentialKey[],
  status: ProviderStatusItem | undefined,
): string {
  const ownedKeys = new Set<CredentialKey>(keys);
  const entries = credentials.filter((entry) => ownedKeys.has(entry.key));
  if (entries.some((entry) => entry.effectiveSource === "environment")) return "launch environment";
  if (
    entries.some((entry) => entry.effectiveSource === "config") &&
    entries.some((entry) => entry.effectiveSource === "keychain")
  ) return "config.json + macOS Keychain";
  if (entries.some((entry) => entry.effectiveSource === "config")) return "config.json";
  if (entries.some((entry) => entry.effectiveSource === "keychain")) return "macOS Keychain";
  if (status?.mode && status.mode !== "api_key") return "external cloud credential chain";
  if (entries.some((entry) => entry.effectiveSource === "inspection_unknown")) return "inspection unavailable";
  return "not configured";
}

const CLAUDE_MODE_KEYS = [
  ["ANTHROPIC_API_KEY", "anthropic_api_key"],
  ["CLAUDE_CODE_USE_VERTEX", "vertex"],
  ["CLAUDE_CODE_USE_BEDROCK", "bedrock"],
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "anthropic_aws"],
  ["CLAUDE_CODE_USE_FOUNDRY", "foundry"],
] as const satisfies readonly (readonly [CredentialKey, string])[];

const GOOGLE_MODE_KEYS = [
  ["GEMINI_API_KEY", "gemini_api_key"],
  ["GOOGLE_GENAI_USE_VERTEXAI", "vertex"],
] as const satisfies readonly (readonly [CredentialKey, string])[];

function inferConfiguredMode(
  credentials: CredentialsResponse["credentials"],
  modeKeys: readonly (readonly [CredentialKey, string])[],
  fallback: string | null | undefined,
): string | null | undefined {
  const configuredModes = modeKeys.flatMap(([key, mode]) =>
    ["environment", "keychain", "config"].includes(credentials.find((entry) => entry.key === key)?.effectiveSource ?? "")
      ? [mode]
      : [],
  );
  return configuredModes.length === 1 ? configuredModes[0] : fallback;
}
