import type {
  ExtensionCapabilityTokenResponse,
} from "@jobctrl/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { browserCapabilityKeys } from "../browserCapabilityKeys.js";
import { parseExtensionToken, parseExtensionTokenWrite } from "../browserApi.js";
import { isUnconfirmedWrite } from "../../../shared/lib/unconfirmed-write.js";

export function ExtensionPairingPanel() {
  const tenantId = useTenantId();
  const { http, clipboard } = usePorts();
  const queryClient = useQueryClient();
  const tokenQuery = useQuery({
    queryKey: browserCapabilityKeys.extensionPairing(tenantId),
    queryFn: async () => parseExtensionToken(await http.json<unknown>("GET", "/v1/extension/pairing-token")),
    meta: { suppressGlobalErrorToast: true },
  });
  const rotateToken = useMutation<
    ExtensionCapabilityTokenResponse,
    Error,
    void
  >({
    mutationKey: browserCapabilityKeys.extensionPairing(tenantId),
    mutationFn: async () => {
      const path = "/v1/extension/pairing-token/rotate";
      return parseExtensionTokenWrite(await http.json<unknown>("POST", path, { body: {} }), path);
    },
    onSuccess: (response) =>
      queryClient.setQueryData(
        browserCapabilityKeys.extensionPairing(tenantId),
        response,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: browserCapabilityKeys.extensionPairing(tenantId),
      });
    },
  });
  const [message, setMessage] = useState("");
  const [copyWarning, setCopyWarning] = useState("");
  const [confirmRotation, setConfirmRotation] = useState(false);
  const uncertainRotation = isUnconfirmedWrite(rotateToken.error);
  const token = tokenQuery.data?.token ?? "";
  const badge = uncertainRotation ? { label: "Check pairing", tone: "warn" as const }
    : tokenQuery.error ? { label: "Unavailable", tone: "danger" as const }
    : token ? { label: "Token available", tone: "info" as const } : { label: "Loading", tone: "info" as const };

  async function copyToken() {
    if (!token || uncertainRotation) return;
    setCopyWarning("");
    try {
      await clipboard.write(token);
      setMessage("Token copied");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Copy failed");
    }
  }

  async function rotate() {
    if (!confirmRotation) {
      setConfirmRotation(true);
      setMessage(
        "Confirm rotation below; existing extension pairing will disconnect.",
      );
      return;
    }
    setConfirmRotation(false);
    setCopyWarning("");
    try {
      const response = await rotateToken.mutateAsync();
      setMessage("Token rotated");
      try {
        await clipboard.write(response.token);
      } catch {
        setCopyWarning(
          "Token rotated, but automatic copy was unavailable. Use copy token to try again.",
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "rotation failed");
    }
  }

  return (
    <DisclosureSection
      actions={
        <StatusBadge
          icon={false}
          tone={badge.tone}
        >
          {badge.label}
        </StatusBadge>
      }
      className="extension-pairing-settings"
      collapsedSummary="Chrome extension pairing"
      defaultOpen={false}
      description="Connect the extension to your local workspace"
      title="Browser extension"
    >
      <div
        className="runtime-summary extension-pairing"
        aria-label="Browser extension pairing"
      >
        <div>
          <h3>Pair with Chrome</h3>
          <p>Paste the capability token into the JobCtrl extension to save the current posting and review autofill suggestions.</p>
        </div>
        <div
          className="extension-pairing-controls"
          aria-busy={tokenQuery.isPending}
        >
          {tokenQuery.error ? (
            <div className="banner inline" role="alert">
              Pairing token is unavailable.
            </div>
          ) : null}
          {uncertainRotation ? <div className="banner inline" role="alert">
            Rotation could not be confirmed. Check the current token before copying or rotating it again.
            <Button type="button" variant="outline" onClick={() => { void tokenQuery.refetch().then((result) => { if (result.isSuccess) rotateToken.reset(); }); }}>Check current token</Button>
          </div> : null}
          <Field className="field extension-token-field">
            <FieldLabel htmlFor="extension-capability-token">
              Capability token
            </FieldLabel>
            <Input
              id="extension-capability-token"
              readOnly
              aria-readonly="true"
              type="password"
              value={uncertainRotation ? "" : token}
              aria-label="Extension capability token"
              placeholder={tokenQuery.isPending ? "Loading…" : "Unavailable"}
            />
          </Field>
          <dl>
            <div>
              <dt>Capabilities</dt>
              <dd data-typography="body">
                Save posting, review autofill
              </dd>
            </div>
            <div>
              <dt>Profile handling</dt>
              <dd data-typography="body">Current Chrome profile; never copied</dd>
            </div>
          </dl>
          <div className="form-actions extension-pairing-actions">
            <Button
              type="button"
              size="sm"
              disabled={!token || tokenQuery.isPending || uncertainRotation}
              onClick={() => void copyToken()}
            >
              Copy token
            </Button>
            <Button
              type="button"
              size="sm"
              variant={confirmRotation ? "destructive" : "outline"}
              disabled={rotateToken.isPending || uncertainRotation}
              aria-busy={rotateToken.isPending || undefined}
              onClick={() => void rotate()}
            >
              {rotateToken.isPending
                ? "Rotating…"
                : confirmRotation
                  ? "Confirm rotation and disconnect"
                  : "Rotate token"}
            </Button>
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
    </DisclosureSection>
  );
}
