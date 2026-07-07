import { useState } from "react";

import type { ApiHealthResponse } from "../../../shared/ports/ApiClientPort.js";
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
      <CardHeader title="Config" meta="execution" />
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {settings ? (
        <>
          <SettingsForm initial={settings} />
          <ExtensionPairingSummary />
          <TemporalRuntimeSummary health={healthQuery.data} isLoading={healthQuery.isPending} />
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
  const token = tokenQuery.data?.token ?? "";
  const tokenPath = tokenQuery.data?.tokenPath ?? "";

  async function copyToken() {
    if (!token) {
      return;
    }
    try {
      await clipboard.write(token);
      setMessage("token copied");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "copy failed");
    }
  }

  async function rotate() {
    try {
      const response = await rotateToken.mutateAsync();
      setMessage("token rotated");
      await clipboard.write(response.token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "rotation failed");
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
            <dt>Token file</dt>
            <dd>{tokenPath || (tokenQuery.isPending ? "loading" : "unknown")}</dd>
          </div>
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
      </div>
    </div>
  );
}

function TemporalRuntimeSummary({
  health,
  isLoading,
}: {
  health: ApiHealthResponse | undefined;
  isLoading: boolean;
}) {
  const heartbeat = health?.worker.heartbeat ?? null;
  const unknown = isLoading ? "checking" : "unknown";

  return (
    <div className="runtime-summary" aria-label="Temporal runtime">
      <div>
        <h3>Temporal runtime</h3>
        <p>Read from the active worker heartbeat.</p>
      </div>
      <dl>
        <RuntimeMetric
          label="Activity slots"
          value={formatRuntimeNumber(heartbeat?.maxConcurrentActivities, unknown)}
        />
        <RuntimeMetric
          label="Executor threads"
          value={formatRuntimeNumber(heartbeat?.activityExecutorMaxWorkers, unknown)}
        />
        <RuntimeMetric label="Task queue" value={heartbeat?.taskQueue ?? unknown} />
        <RuntimeMetric label="Worker health" value={health?.worker.status ?? unknown} />
        <RuntimeMetric label="Startup env" value="JOBCTL_MAX_CONCURRENT_ACTIVITIES" />
      </dl>
    </div>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatRuntimeNumber(value: number | null | undefined, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value);
}
