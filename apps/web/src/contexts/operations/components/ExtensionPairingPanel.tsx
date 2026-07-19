import type { ExtensionCapabilityTokenResponse } from "@jobctrl/contracts";
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

export function ExtensionPairingPanel() {
  const tenantId = useTenantId();
  const { api, clipboard } = usePorts();
  const queryClient = useQueryClient();
  const tokenQuery = useQuery({
    queryKey: browserCapabilityKeys.extensionPairing(tenantId),
    queryFn: () => api.extensionCapabilityToken(),
    meta: { suppressGlobalErrorToast: true },
  });
  const rotateToken = useMutation<
    ExtensionCapabilityTokenResponse,
    Error,
    void
  >({
    mutationKey: browserCapabilityKeys.extensionPairing(tenantId),
    mutationFn: () => api.rotateExtensionCapabilityToken(),
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
  const token = tokenQuery.data?.token ?? "";

  async function copyToken() {
    if (!token) return;
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
          tone={token ? "ok" : tokenQuery.error ? "danger" : "info"}
        >
          {token ? "Ready" : tokenQuery.error ? "Unavailable" : "Loading"}
        </StatusBadge>
      }
      className="extension-pairing-settings"
      collapsedSummary="Local capability token"
      defaultOpen={false}
      description="Pair local extension requests without exposing the token"
      title="Browser extension"
    >
      <div
        className="runtime-summary extension-pairing"
        aria-label="Browser extension pairing"
      >
        <div>
          <h3>Pairing token</h3>
          <p>Local capability token for extension API requests.</p>
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
          <Field className="field extension-token-field">
            <FieldLabel htmlFor="extension-capability-token">
              Capability token
            </FieldLabel>
            <Input
              id="extension-capability-token"
              readOnly
              aria-readonly="true"
              type="password"
              value={token}
              aria-label="Extension capability token"
              placeholder={tokenQuery.isPending ? "Loading…" : "Unavailable"}
            />
          </Field>
          <dl>
            <div>
              <dt>Capabilities</dt>
              <dd data-typography="body">capture, autofill read</dd>
            </div>
          </dl>
          <div className="form-actions extension-pairing-actions">
            <Button
              type="button"
              size="sm"
              disabled={!token || tokenQuery.isPending}
              onClick={() => void copyToken()}
            >
              Copy token
            </Button>
            <Button
              type="button"
              size="sm"
              variant={confirmRotation ? "destructive" : "outline"}
              disabled={rotateToken.isPending}
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
