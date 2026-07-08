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
  const errorMessage = credentialsQuery.error?.message ?? "";

  return (
    <>
      <section className="card full">
        <CardHeader title="Credentials" meta="macOS Keychain" />
        {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
        <div className="credential-list">
          {CredentialKeys.map((key) => {
            const credential = credentials.find((item) => item.key === key);
            const configured = Boolean(credential?.configured);
            const label = credential?.label ?? credentialLabel(key);
            return (
              <CredentialForm
                key={key}
                credentialKey={key}
                label={label}
                configured={configured}
              />
            );
          })}
        </div>
      </section>
      <section className="privacy-box" aria-label="Credential privacy">
        <h2>Your data stays private</h2>
        <p className="privacy-box-copy">
          Keys you save here are stored in the macOS Keychain. When stored there they stay on
          this machine and are never written to the database, logs, traces, or generated
          artifacts.
        </p>
        <div className="privacy-box-tags">
          <Badge>Local only</Badge>
          <Badge>macOS Keychain</Badge>
          <Badge>Never in logs</Badge>
          <Badge>Open source</Badge>
        </div>
      </section>
    </>
  );
}
