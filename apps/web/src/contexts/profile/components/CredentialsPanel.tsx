import {
  type CredentialKey,
  CredentialKeys,
  type CredentialsResponse,
} from "@jobhunter/contracts";
import { useCallback, useEffect, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
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
  const ports = usePorts();
  const [credentials, setCredentials] = useState<CredentialsResponse["credentials"]>([]);
  const [drafts, setDrafts] = useState<Record<CredentialKey, string>>(EMPTY_DRAFTS);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<CredentialKey | "">("");

  const load = useCallback(async () => {
    setError("");
    setStatus("");
    try {
      const credentialsResponse = await ports.api.credentials();
      setCredentials(credentialsResponse.credentials);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to load credentials.",
      );
    }
  }, [ports.api]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCredential = async (key: CredentialKey) => {
    const value = drafts[key].trim();
    if (!value) {
      return;
    }
    setBusy(key);
    setError("");
    setStatus("");
    try {
      const response = await ports.api.updateCredential({ key, value });
      setCredentials(response.credentials);
      setDrafts((current) => ({ ...current, [key]: "" }));
      setStatus(`${credentialLabel(key)} saved in Keychain`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : `Unable to save ${credentialLabel(key)}.`,
      );
    } finally {
      setBusy("");
    }
  };

  const removeCredential = async (key: CredentialKey) => {
    setBusy(key);
    setError("");
    setStatus("");
    try {
      const response = await ports.api.deleteCredential(key);
      setCredentials(response.credentials);
      setDrafts((current) => ({ ...current, [key]: "" }));
      setStatus(`${credentialLabel(key)} removed from Keychain`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : `Unable to remove ${credentialLabel(key)}.`,
      );
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="card full">
      <CardHeader title="Credentials" meta="macOS Keychain" />
      {error ? <div className="banner inline">{error}</div> : null}
      {status ? <div className="status-line">{status}</div> : null}
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
                  disabled={!drafts[key].trim() || busy === key}
                  onClick={() => void saveCredential(key)}
                >
                  save
                </button>
                <button
                  className="tab"
                  type="button"
                  disabled={!configured || busy === key}
                  onClick={() => void removeCredential(key)}
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
