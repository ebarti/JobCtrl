import { type CredentialKey, CredentialKeys } from "@jobctrl/contracts";

import { Badge } from "../../../shared/ui/badge.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { CredentialForm } from "../forms/credential-form.js";
import { useCredentialsQuery } from "../hooks/useCredentialsQuery.js";

export function credentialLabel(key: CredentialKey): string {
  if (key === "OPENAI_API_KEY") {
    return "OpenAI API key";
  }
  if (key === "GEMINI_API_KEY") {
    return "Gemini API key";
  }
  return "LLM endpoint";
}

export function CredentialsPanel() {
  const credentialsQuery = useCredentialsQuery();
  const credentials = credentialsQuery.data?.credentials ?? [];
  const store = credentialsQuery.data?.store;
  const storeAvailable = store?.available === true;
  const storeUnsupported = store?.unavailableReason === "unsupported_platform";
  const inspectionFailed = store?.unavailableReason === "inspection_failed";
  const errorMessage = credentialsQuery.error?.message ?? "";
  const unavailableDescriptionId = "credential-store-unavailable";
  const inspectionDescriptionId = "credential-store-inspection-failed";
  const cardMeta = storeUnsupported
    ? "Environment only"
    : inspectionFailed
      ? "Keychain unavailable"
      : store
        ? "macOS Keychain"
        : "Checking Keychain";

  return (
    <>
      <section className="card full">
        <CardHeader title="Credentials" meta={cardMeta} />
        {errorMessage ? (
          <div
            className="banner credential-store-notice credential-store-notice--failure"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}
        {storeUnsupported ? (
          <div
            className="banner credential-store-notice credential-store-notice--guidance"
            id={unavailableDescriptionId}
          >
            Keychain credential editing is available only on macOS. Configure
            these values in <code>~/.jobctrl/.env</code> or your shell
            environment on this platform.
          </div>
        ) : null}
        {inspectionFailed ? (
          <div
            aria-label="Keychain inspection unavailable"
            className="banner credential-store-notice credential-store-notice--failure credential-store-recovery"
            id={inspectionDescriptionId}
            role="alert"
          >
            <span>
              JobCtrl could not safely inspect macOS Keychain. No value was
              treated as absent. Unlock Keychain Access, then retry. Save and
              remove stay disabled until the check succeeds.
            </span>
            <button
              className="tab on"
              disabled={credentialsQuery.isFetching}
              onClick={() => void credentialsQuery.refetch()}
              type="button"
            >
              {credentialsQuery.isFetching
                ? "checking Keychain"
                : "retry Keychain check"}
            </button>
          </div>
        ) : null}
        {storeAvailable ? (
          <div className="banner credential-store-notice credential-store-notice--guidance">
            Keychain changes are loaded by Python processes at startup. Restart
            the JobCtrl worker after saving or removing a value. These checks do
            not inspect your shell or ~/.jobctrl/.env, which can still provide
            the runtime value.
          </div>
        ) : null}
        {store ? (
          <div className="credential-list">
            {CredentialKeys.map((key) => {
              const credential = credentials.find((item) => item.key === key);
              const configured = credential?.configured ?? null;
              const label = credential?.label ?? credentialLabel(key);
              return (
                <CredentialForm
                  key={key}
                  credentialKey={key}
                  label={label}
                  configured={configured}
                  available={storeAvailable}
                  {...(storeUnsupported
                    ? {
                        unavailableDescriptionId,
                        unavailableReason: "unsupported_platform" as const,
                      }
                    : inspectionFailed || configured === null
                      ? {
                          unavailableDescriptionId: inspectionDescriptionId,
                          ...(configured === null
                            ? {
                                unavailableReason: "inspection_failed" as const,
                              }
                            : {}),
                        }
                      : {})}
                />
              );
            })}
          </div>
        ) : (
          <div className="empty" role="status">
            Checking Keychain availability.
          </div>
        )}
      </section>
      <section className="privacy-box" aria-label="Credential privacy">
        <h2>
          {storeUnsupported
            ? "Use environment configuration"
            : inspectionFailed
              ? "Keychain needs attention"
              : "Your data stays private"}
        </h2>
        {storeUnsupported ? (
          <>
            <p className="privacy-box-copy">
              JobCtrl does not ship a native credential-store adapter for this
              platform yet. Configure provider values in{" "}
              <code>~/.jobctrl/.env</code> or the worker's shell environment,
              then restart the worker to load them.
            </p>
            <div className="privacy-box-tags">
              <Badge>Environment only</Badge>
              <Badge>Restart required</Badge>
              <Badge>Native store planned</Badge>
            </div>
          </>
        ) : inspectionFailed ? (
          <>
            <p className="privacy-box-copy">
              JobCtrl cannot currently prove which values are in Keychain, so
              credential edits are paused. Unlock Keychain Access and retry the
              check. Existing environment configuration remains independent and
              may still provide runtime credentials.
            </p>
            <div className="privacy-box-tags">
              <Badge>Unable to check</Badge>
              <Badge>Edits paused</Badge>
              <Badge>Environment independent</Badge>
            </div>
          </>
        ) : (
          <>
            <p className="privacy-box-copy">
              Keys you save here are stored in the macOS Keychain. When stored
              there they stay on this machine and are never written to the
              database, logs, traces, or generated artifacts. Explicit
              environment values take precedence, and the Python worker reads
              Keychain fallbacks only when it starts.
            </p>
            <div className="privacy-box-tags">
              <Badge>Local only</Badge>
              <Badge>macOS Keychain</Badge>
              <Badge>Never in logs</Badge>
              <Badge>Open source</Badge>
            </div>
          </>
        )}
      </section>
    </>
  );
}
