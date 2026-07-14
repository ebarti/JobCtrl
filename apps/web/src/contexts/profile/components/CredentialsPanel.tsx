import type {
  CredentialKey,
  CredentialsResponse,
  ProviderId,
  ProviderStatusItem,
} from "@jobctrl/contracts";
import { useState, type ReactNode } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import {
  InspectorLedger,
  InspectorLedgerItem,
} from "../../../shared/ui/inspector-ledger.js";
import {
  StatusLabel,
  type StatusLabelTone,
} from "../../../shared/ui/status-label.js";
import {
  ClaudeProviderForm,
  GoogleProviderForm,
} from "../forms/provider-setup-forms.js";
import { CredentialForm } from "../forms/credential-form.js";
import { useCredentialsQuery } from "../hooks/useCredentialsQuery.js";
import { useProviderStatusQuery } from "../hooks/useProviderStatusQuery.js";
import { useUpdateCredentialsBatchMutation } from "../hooks/useUpdateCredentialsBatchMutation.js";
import { useVerifyCodexProviderMutation } from "../hooks/useVerifyCodexProviderMutation.js";
import {
  CODEX_LOGIN_COMMANDS,
  removeLegacyOpenAiKeyBatch,
} from "../lib/provider-credential-plans.js";

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

  if (isDemo) {
    return <DemoProviderSetup />;
  }

  return (
    <>
      <DisclosureSection
        className="provider-setup-disclosure"
        collapsedSummary={providerSetupSummary(store, statuses)}
        defaultOpen
        description="Provider authentication, ownership, and runtime readiness"
        title="LLM providers"
      >
        <ProviderSetupNotice
          credentialsError={credentialsQuery.error?.message}
          providerStatusError={providerStatusQuery.error?.message}
          store={store}
        />
        {!store ? (
          <div className="empty" role="status">Checking provider setup.</div>
        ) : (
          <div className="provider-disclosure-list">
            <ProviderDisclosure
              description="Reuses an already authenticated normal Codex CLI first, then verifies it in JobCtrl's isolated Codex home. JobCtrl does not accept a raw OpenAI key."
              provider="codex"
              status={codexStatus}
              title="Codex"
              ownership={codexStatus?.mode === "cli_auth" ? "isolated Codex CLI" : "not configured"}
            >
              <CodexProviderSetup
                isolatedAuthDetected={codexStatus?.mode === "cli_auth"}
                legacyOpenAiKeyConfigured={
                  store.available && configured(["OPENAI_API_KEY"])
                }
              />
            </ProviderDisclosure>
            {store.available || store.unavailableReason === "unsupported_platform" ? (
              <>
                <ProviderDisclosure
                  description="Choose one direct or third-party Claude Agent SDK authentication route."
                  provider="claude"
                  status={mergeConfiguredStatus("claude", claudeStatus, claudeConfigured)}
                  title="Claude"
                  ownership={providerOwnership(credentials, CLAUDE_KEYS, claudeStatus)}
                >
                  <ClaudeProviderForm
                    configured={claudeConfigured}
                    currentMode={claudeCurrentMode}
                    environmentManagedKeys={environmentManagedKeys}
                    secretStorageAvailable={store.available}
                  />
                </ProviderDisclosure>
                <ProviderDisclosure
                  description="Use a Gemini API key or Google Vertex AI with Application Default Credentials."
                  provider="google"
                  status={mergeConfiguredStatus("google", googleStatus, googleConfigured)}
                  title="Google"
                  ownership={providerOwnership(credentials, GOOGLE_KEYS, googleStatus)}
                >
                  <GoogleProviderForm
                    configured={googleConfigured}
                    currentMode={googleCurrentMode}
                    environmentManagedKeys={environmentManagedKeys}
                    secretStorageAvailable={store.available}
                  />
                </ProviderDisclosure>
              </>
            ) : (
              <ReadOnlyProviderGuidance
                includeCodex={false}
                reason={store.unavailableReason}
              />
            )}
          </div>
        )}
        {store && capSolver ? (
          <DisclosureSection
            className="provider-disclosure provider-disclosure--capsolver"
            collapsedSummary={(
              <span className="provider-disclosure__summary">
                <StatusLabel tone={credentialStatusTone(capSolver)}>
                  {credentialStatusLabel(capSolver)}
                </StatusLabel>
                <span>Optional · restart required</span>
              </span>
            )}
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
      </DisclosureSection>
      <CredentialPrivacyNotice store={store} />
    </>
  );
}

function ProviderSetupNotice({
  credentialsError,
  providerStatusError,
  store,
}: {
  credentialsError?: string | undefined;
  providerStatusError?: string | undefined;
  store?: CredentialsResponse["store"] | undefined;
}) {
  if (credentialsError) {
    return <div className="banner credential-store-notice credential-store-notice--failure provider-setup-notice" role="alert">{credentialsError}</div>;
  }
  if (!store) {
    return null;
  }
  if (store.unavailableReason === "unsupported_platform") {
    return (
      <div className="banner credential-store-notice credential-store-notice--guidance provider-setup-notice">
        Non-secret provider settings remain editable in config.json. API-key entry is unavailable until this platform has a supported secure-storage adapter; externally authenticated cloud routes remain available.
      </div>
    );
  }
  if (store.unavailableReason === "inspection_failed") {
    return (
      <div className="banner credential-store-notice credential-store-notice--failure provider-setup-notice" role="alert">
        JobCtrl could not safely inspect Keychain. Unlock Keychain Access, then reload before changing Claude or Google setup. Codex verification remains available.
      </div>
    );
  }
  return (
    <div className="banner credential-store-notice credential-store-notice--guidance provider-setup-notice">
      <span>
        Provider modes and non-secret connection fields are saved in config.json. API keys stay in macOS Keychain. Restart JobCtrl after a change so provider processes reload both sources.
      </span>
      {providerStatusError ? (
        <span className="provider-status-warning" role="status">
          Live provider status is unavailable; saved-key indicators are still shown.
        </span>
      ) : null}
    </div>
  );
}

function ProviderDisclosure({
  provider,
  title,
  description,
  status,
  children,
  ownership,
}: {
  provider: ProviderId;
  title: string;
  description: string;
  status?: ProviderStatusItem | undefined;
  children: ReactNode;
  ownership: string;
}) {
  const statusLabel = status?.ready
    ? "Ready"
    : provider === "codex" && status?.mode === "cli_auth"
      ? "Authenticated · runtime unavailable"
      : status?.configured
        ? "Configured · restart or verify"
        : "Not configured";
  return (
    <DisclosureSection
      className="provider-disclosure"
      collapsedSummary={(
        <span className="provider-disclosure__summary">
          <StatusLabel tone={providerStatusTone(status)}>{statusLabel}</StatusLabel>
          <span>Ownership: {ownership}</span>
        </span>
      )}
      defaultOpen={false}
      data-provider={provider}
      description={description}
      title={title}
    >
      <InspectorLedger className="provider-status-ledger">
        <InspectorLedgerItem
          label="Status"
          value={<StatusLabel tone={providerStatusTone(status)}>{statusLabel}</StatusLabel>}
        />
        <InspectorLedgerItem label="Effective ownership" value={ownership} />
        {status?.mode ? (
          <InspectorLedgerItem label="Detected mode" value={status.mode} />
        ) : null}
        {status?.message ? (
          <InspectorLedgerItem label="Provider report" value={status.message} />
        ) : null}
      </InspectorLedger>
      {children}
    </DisclosureSection>
  );
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
    <div className="provider-setup-form codex-provider-setup">
      <ol className="codex-auth-methods">
        <li className="codex-auth-method">
          <h4>Use an existing Codex CLI login first</h4>
          <p>
            Click the action below to validate an already authenticated normal
            Codex CLI login and import it once into JobCtrl's stable, isolated
            home. It does not change your normal Codex home.
          </p>
        </li>
        <li className="codex-auth-method">
          <h4>Fallback: ChatGPT subscription or device login</h4>
          <p>
            If there is no existing login to reuse, authenticate the Codex CLI
            into JobCtrl's stable, isolated Codex home.
          </p>
          <code>{CODEX_LOGIN_COMMANDS.subscription}</code>
        </li>
        <li className="codex-auth-method">
          <h4>Fallback: OpenAI API key enrollment</h4>
          <p>
            If there is no existing login to reuse, pipe your existing shell key
            directly into Codex. JobCtrl never receives or stores the raw key.
          </p>
          <code>{CODEX_LOGIN_COMMANDS.apiKey}</code>
        </li>
      </ol>
      <p className="provider-setup-boundary-copy">
        Authentication is stored outside JobCtrl's prompt-readable <code>codex_home/workspace</code> boundary.
      </p>
      {legacyOpenAiKeyConfigured ? (
        <div className="provider-setup-warning">
          <p>
            A legacy <code>OPENAI_API_KEY</code> exists in JobCtrl Keychain. The Codex runtime does not use it directly; enroll it with the command above, then remove this unused copy.
          </p>
          <Button
            disabled={removeLegacyKey.isPending}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void removeLegacy()}
          >
            {removeLegacyKey.isPending ? "Removing…" : "Remove legacy key"}
          </Button>
        </div>
      ) : null}
      <div className="provider-setup-form__footer">
        <Button
          disabled={verify.isPending}
          size="sm"
          type="button"
          onClick={() => verify.mutate()}
        >
          {verify.isPending
            ? "Verifying…"
            : isolatedAuthDetected
              ? "Verify isolated login"
              : "Reuse existing login or verify"}
        </Button>
        <div
          aria-live="polite"
          className={verification?.ok === false || verify.error ? "provider-setup-form__message provider-setup-form__message--warning" : "provider-setup-form__message"}
          role="status"
        >
          {verificationMessage}
        </div>
        {legacyMessage ? <div aria-live="polite" className="provider-setup-form__message" role="status">{legacyMessage}</div> : null}
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
        <DisclosureSection
          className="provider-disclosure provider-disclosure--readonly"
          collapsedSummary={(
            <span className="provider-disclosure__summary">
              <StatusLabel tone="muted">Read only</StatusLabel>
              <span>Ownership: external provider environment</span>
            </span>
          )}
          defaultOpen={false}
          description={copy}
          key={title}
          title={title}
        >
          <InspectorLedger className="provider-status-ledger">
            <InspectorLedgerItem label="Status" value="Guided editing unavailable" />
            <InspectorLedgerItem label="Effective ownership" value="External provider environment" />
          </InspectorLedger>
        </DisclosureSection>
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
      className="provider-setup-disclosure"
      collapsedSummary="Public demo · read only"
      defaultOpen
      description="Provider authentication, ownership, and runtime readiness"
      title="LLM providers"
    >
      <div className="banner credential-store-notice credential-store-notice--guidance provider-setup-notice">
        The public demo never accepts, checks, or stores provider secrets. Configure providers only in a local JobCtrl installation.
      </div>
      <div className="provider-disclosure-list">
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
      className="credential-privacy-disclosure"
      collapsedSummary={boundaryBadge}
      defaultOpen={false}
      description="Storage boundaries and data-handling guarantees"
      title="Your provider data stays private"
    >
      <p className="credential-privacy-disclosure__copy">
        {boundaryCopy} Codex authentication stays in JobCtrl's isolated filesystem home. Credentials are never returned by the API, stored in SQLite, placed in URLs, or written to logs, traces, and generated artifacts. Cloud credential files remain managed by their vendor CLIs.
      </p>
      <InspectorLedger className="credential-privacy-ledger">
        <InspectorLedgerItem
          label="Data boundary"
          value="Local only"
        />
        <InspectorLedgerItem
          label="Claude and Google storage"
          source={boundaryCopy}
          value={boundaryBadge}
        />
        <InspectorLedgerItem
          label="Codex authentication"
          source="Outside the prompt-readable codex_home/workspace boundary"
          value="Isolated filesystem home"
        />
        <InspectorLedgerItem
          label="API and persistence"
          source="Credentials are never returned by the API or stored in SQLite"
          value="Secret values excluded"
        />
        <InspectorLedgerItem
          label="URLs, logs, traces, and artifacts"
          value="Never in logs, traces, URLs, or generated artifacts"
        />
        <InspectorLedgerItem
          label="Provider reload"
          value="Worker restart required"
        />
      </InspectorLedger>
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

function credentialStatusTone(
  credential: CredentialsResponse["credentials"][number],
): StatusLabelTone {
  if (credential.effectiveSource === "inspection_unknown") return "warn";
  if (credential.effectiveSource === "environment" || credential.configured) return "ok";
  return "muted";
}

function providerStatusTone(
  status: ProviderStatusItem | undefined,
): StatusLabelTone {
  if (status?.ready) return "ok";
  if (status?.configured) return "warn";
  return "muted";
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
