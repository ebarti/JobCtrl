import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useHealthQuery } from "../../operations/hooks/useHealthQuery.js";
import { SettingsForm } from "../forms/settings-form.js";
import { useExtensionCapabilityTokenQuery } from "../hooks/useExtensionCapabilityTokenQuery.js";
import { useRotateExtensionCapabilityTokenMutation } from "../hooks/useRotateExtensionCapabilityTokenMutation.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";

export function SettingsPanel() {
  const settingsQuery = useSettingsQuery();
  const healthQuery = useHealthQuery();
  const errorMessage = settingsQuery.error?.message ?? "";
  const settings = settingsQuery.data?.settings ?? null;

  return (
    <section className="card full">
      <CardHeader title="Cost and capacity" meta="general" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {settings ? (
        <>
          <SettingsForm
            initial={settings}
            effectiveSettings={settingsQuery.data!.effectiveSettings}
            activeWorkerActivitySlots={healthQuery.data?.worker.heartbeat?.maxConcurrentActivities}
            workerStatus={healthQuery.data?.worker.status}
          />
          <ExtensionPairingSummary />
        </>
      ) : (
        <Empty title="Loading config." />
      )}
    </section>
  );
}

function ExtensionPairingSummary() {
  const { clipboard } = usePorts();
  const tokenQuery = useExtensionCapabilityTokenQuery();
  const rotateToken = useRotateExtensionCapabilityTokenMutation();
  const [message, setMessage] = useState("");
  const [copyWarning, setCopyWarning] = useState("");
  const token = tokenQuery.data?.token ?? "";

  async function copyToken() {
    if (!token) {
      return;
    }
    setCopyWarning("");
    try {
      await clipboard.write(token);
      setMessage("token copied");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "copy failed");
    }
  }

  async function rotate() {
    setCopyWarning("");
    let response: Awaited<ReturnType<typeof rotateToken.mutateAsync>>;
    try {
      response = await rotateToken.mutateAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "rotation failed");
      return;
    }

    setMessage("token rotated");
    try {
      await clipboard.write(response.token);
    } catch {
      setCopyWarning(
        "Token rotated, but automatic copy was unavailable. Use copy token to try again.",
      );
    }
  }

  return (
    <div className="runtime-summary extension-pairing" aria-label="Browser extension pairing">
      <div>
        <h3>Browser extension pairing</h3>
        <p>Local capability token for extension API requests.</p>
      </div>
      <div className="extension-pairing-controls">
        {tokenQuery.error ? <div className="banner inline">{tokenQuery.error.message}</div> : null}
        <label className="field extension-token-field">
          <span>Capability token</span>
          <input
            readOnly
            type="password"
            value={token}
            aria-label="Extension capability token"
            placeholder={tokenQuery.isPending ? "loading" : "unavailable"}
          />
        </label>
        <dl>
          <div>
            <dt>Capabilities</dt>
            <dd>capture, autofill read</dd>
          </div>
        </dl>
        <div className="form-actions extension-pairing-actions">
          <button className="tab on" type="button" disabled={!token} onClick={() => void copyToken()}>
            copy token
          </button>
          <button className="tab" type="button" disabled={rotateToken.isPending} onClick={() => void rotate()}>
            {rotateToken.isPending ? "rotating" : "rotate token"}
          </button>
        </div>
        {message ? (
          <div className="status-line" role="status">
            {message}
          </div>
        ) : null}
        {copyWarning ? (
          <div className="banner inline" role="alert">
            {copyWarning}
          </div>
        ) : null}
      </div>
    </div>
  );
}
