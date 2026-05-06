import { type CredentialKey, CredentialKeys } from "@jobhunter/contracts";
import { useState } from "react";

import { useCredentialsQuery } from "../hooks/useCredentialsQuery.js";
import { useDeleteCredentialMutation } from "../hooks/useDeleteCredentialMutation.js";
import { useUpdateCredentialMutation } from "../hooks/useUpdateCredentialMutation.js";
import { CardHeader } from "../../../shared/ui/card-header.js";

export function credentialLabel(key: CredentialKey): string {
  if (key === "OPENAI_API_KEY") {
    return "OpenAI API key";
  }
  if (key === "GEMINI_API_KEY") {
    return "Gemini API key";
  }
  return "LLM endpoint";
}

const EMPTY_DRAFTS: Record<CredentialKey, string> = {
  OPENAI_API_KEY: "",
  GEMINI_API_KEY: "",
  LLM_URL: "",
};

export function CredentialsPanel() {
  const credentialsQuery = useCredentialsQuery();
  const updateCredential = useUpdateCredentialMutation();
  const deleteCredential = useDeleteCredentialMutation();

  const [drafts, setDrafts] = useState<Record<CredentialKey, string>>(EMPTY_DRAFTS);
  const [statusMessage, setStatusMessage] = useState("");
  const [busyKey, setBusyKey] = useState<CredentialKey | "">("");

  const credentials = credentialsQuery.data?.credentials ?? [];
  const errorMessage =
    credentialsQuery.error?.message ??
    updateCredential.error?.message ??
    deleteCredential.error?.message ??
    "";

  const saveCredential = (key: CredentialKey) => {
    const value = drafts[key].trim();
    if (!value) {
      return;
    }
    setBusyKey(key);
    setStatusMessage("");
    updateCredential.mutate(
      { key, value },
      {
        onSuccess: () => {
          setDrafts((current) => ({ ...current, [key]: "" }));
          setStatusMessage(`${credentialLabel(key)} saved in Keychain`);
        },
        onSettled: () => setBusyKey(""),
      },
    );
  };

  const removeCredential = (key: CredentialKey) => {
    setBusyKey(key);
    setStatusMessage("");
    deleteCredential.mutate(key, {
      onSuccess: () => {
        setDrafts((current) => ({ ...current, [key]: "" }));
        setStatusMessage(`${credentialLabel(key)} removed from Keychain`);
      },
      onSettled: () => setBusyKey(""),
    });
  };

  return (
    <section className="card full">
      <CardHeader title="Credentials" meta="macOS Keychain" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <div className="credential-list">
        {CredentialKeys.map((key) => {
          const credential = credentials.find((item) => item.key === key);
          const configured = Boolean(credential?.configured);
          return (
            <div className="credential-row" key={key}>
              <span className={`tag ${configured ? "ok" : "muted"}`}>
                {configured ? "configured" : "missing"}
              </span>
              <span className="title-stack">
                <b>{credential?.label ?? credentialLabel(key)}</b>
                <span>{key}</span>
              </span>
              <input
                aria-label={credential?.label ?? credentialLabel(key)}
                placeholder={configured ? "Stored in Keychain" : "Paste value to store in Keychain"}
                type="password"
                value={drafts[key]}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [key]: event.target.value }))
                }
              />
              <span className="row-actions">
                <button
                  className="tab on"
                  type="button"
                  disabled={!drafts[key].trim() || busyKey === key}
                  onClick={() => saveCredential(key)}
                >
                  save
                </button>
                <button
                  className="tab"
                  type="button"
                  disabled={!configured || busyKey === key}
                  onClick={() => removeCredential(key)}
                >
                  remove
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
