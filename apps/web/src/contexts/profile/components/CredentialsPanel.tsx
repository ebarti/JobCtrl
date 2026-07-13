import type {
  CredentialKey,
  CredentialsResponse,
  ProviderId,
  ProviderStatusItem,
} from "@jobctrl/contracts";
import { useState, type ReactNode } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Badge } from "../../../shared/ui/badge.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
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
      return source === "environment" || source === "keychain";
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
      <section className="card full provider-setup-shell">
        <CardHeader
          title="LLM providers"
          meta={store?.available ? "macOS Keychain" : "setup"}
        />
        <ProviderSetupNotice
          credentialsError={credentialsQuery.error?.message}
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
              ownership={codexStatus?.mode === "cli_auth" ? "isolated Codex CLI" : "not configured"}
            >
              <CodexProviderSetup
                isolatedAuthDetected={codexStatus?.mode === "cli_auth"}
                legacyOpenAiKeyConfigured={
                  store.available && configured(["OPENAI_API_KEY"])
                }
              />
            </ProviderCard>
            {store.available ? (
              <>
                <ProviderCard
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
                  />
                </ProviderCard>
                <ProviderCard
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
      </section>
      {store && capSolver ? (
        <section className="card full provider-setup-shell">
          <CardHeader title="Apply CAPTCHA solver" meta="optional · restart required" />
          <p className="provider-copy">A CapSolver key only enables JobCtrl's owned solver tool during a user-started Apply. Unsupported or unconfigured CAPTCHA always fails closed.</p>
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
        </section>
      ) : null}
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
    return <div className="banner credential-store-notice credential-store-notice--failure" role="alert">{credentialsError}</div>;
  }
  if (!store) {
    return null;
  }
  if (store.unavailableReason === "unsupported_platform") {
    return (
      <div className="banner credential-store-notice credential-store-notice--guidance">
        Guided secret storage is available only with macOS Keychain. Configure the same variables in the worker environment on this platform.
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
  return (
    <div className="banner credential-store-notice credential-store-notice--guidance">
      <span>
        Claude and Google settings saved here stay in macOS Keychain. Restart JobCtrl after a change so its API provider process and worker reload Keychain values.
      </span>
      {providerStatusError ? (
        <span className="provider-status-warning" role="status">
          Live provider status is unavailable; saved-key indicators are still shown.
        </span>
      ) : null}
    </div>
  );
}

function ProviderCard({
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
    <article className="provider-card" data-provider={provider}>
      <header className="provider-card-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span className={`tag ${status?.ready ? "ok" : "muted"}`}>{statusLabel}</span>
      </header>
      {status?.mode ? <p className="provider-current-mode">Detected mode: {status.mode}</p> : null}
      <p className="provider-current-mode">Effective ownership: {ownership}</p>
      {status?.message ? <p className="provider-status-message">{status.message}</p> : null}
      {children}
    </article>
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
    <div className="provider-form codex-provider-setup">
      <div className="codex-auth-options">
        <section>
          <h4>Use an existing Codex CLI login first</h4>
          <p>
            Click the action below to validate an already authenticated normal
            Codex CLI login and import it once into JobCtrl's stable, isolated
            home. It does not change your normal Codex home.
          </p>
        </section>
        <section>
          <h4>Fallback: ChatGPT subscription or device login</h4>
          <p>
            If there is no existing login to reuse, authenticate the Codex CLI
            into JobCtrl's stable, isolated Codex home.
          </p>
          <code>{CODEX_LOGIN_COMMANDS.subscription}</code>
        </section>
        <section>
          <h4>Fallback: OpenAI API key enrollment</h4>
          <p>
            If there is no existing login to reuse, pipe your existing shell key
            directly into Codex. JobCtrl never receives or stores the raw key.
          </p>
          <code>{CODEX_LOGIN_COMMANDS.apiKey}</code>
        </section>
      </div>
      <p className="provider-copy">
        Authentication is stored outside JobCtrl's prompt-readable <code>codex_home/workspace</code> boundary.
      </p>
      {legacyOpenAiKeyConfigured ? (
        <div className="provider-legacy-warning">
          <p>
            A legacy <code>OPENAI_API_KEY</code> exists in JobCtrl Keychain. The Codex runtime does not use it directly; enroll it with the command above, then remove this unused copy.
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
          <h3>{title}</h3>
          <p>{copy}</p>
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
    <section className="card full provider-setup-shell">
      <CardHeader title="LLM providers" meta="public demo · read only" />
      <div className="banner credential-store-notice credential-store-notice--guidance">
        The public demo never accepts, checks, or stores provider secrets. Configure providers only in a local JobCtrl installation.
      </div>
      <div className="provider-card-list">
        <ReadOnlyProviderGuidance reason={null} />
      </div>
    </section>
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
    <section aria-label="Credential privacy" className="privacy-box">
      <h2>Your provider data stays private</h2>
      <p className="privacy-box-copy">
        {boundaryCopy} Codex authentication stays in JobCtrl's isolated filesystem home. Credentials are never returned by the API, stored in SQLite, placed in URLs, or written to logs, traces, and generated artifacts. Cloud credential files remain managed by their vendor CLIs.
      </p>
      <div className="privacy-box-tags">
        <Badge>Local only</Badge>
        <Badge>{boundaryBadge}</Badge>
        <Badge>Never in logs</Badge>
        <Badge>Worker restart required</Badge>
      </div>
    </section>
  );
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
    ["environment", "keychain"].includes(credentials.find((entry) => entry.key === key)?.effectiveSource ?? "")
      ? [mode]
      : [],
  );
  return configuredModes.length === 1 ? configuredModes[0] : fallback;
}
