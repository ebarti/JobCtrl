import type { ExtensionCapabilityTokenResponse } from "@jobctrl/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
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
  const rotateToken = useMutation<ExtensionCapabilityTokenResponse, Error, void>({
    mutationKey: browserCapabilityKeys.extensionPairing(tenantId),
    mutationFn: () => api.rotateExtensionCapabilityToken(),
    onSuccess: (response) => queryClient.setQueryData(browserCapabilityKeys.extensionPairing(tenantId), response),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: browserCapabilityKeys.extensionPairing(tenantId) }); },
  });
  const [message, setMessage] = useState("");
  const [copyWarning, setCopyWarning] = useState("");
  const [confirmRotation, setConfirmRotation] = useState(false);
  const token = tokenQuery.data?.token ?? "";

  async function copyToken() {
    if (!token) return;
    setCopyWarning("");
    try { await clipboard.write(token); setMessage("token copied"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "copy failed"); }
  }

  async function rotate() {
    if (!confirmRotation) {
      setConfirmRotation(true);
      setMessage("Confirm rotation below; existing extension pairing will disconnect.");
      return;
    }
    setConfirmRotation(false);
    setCopyWarning("");
    try {
      const response = await rotateToken.mutateAsync();
      setMessage("token rotated");
      try { await clipboard.write(response.token); }
      catch { setCopyWarning("Token rotated, but automatic copy was unavailable. Use copy token to try again."); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "rotation failed");
    }
  }

  return (
    <section className="card full">
      <CardHeader title="Browser extension" meta="pairing" />
      <div className="runtime-summary extension-pairing" aria-label="Browser extension pairing">
        <div><h3>Browser extension pairing</h3><p>Local capability token for extension API requests.</p></div>
        <div className="extension-pairing-controls">
          {tokenQuery.error ? <div className="banner inline">Pairing token is unavailable.</div> : null}
          <label className="field extension-token-field"><span>Capability token</span><input readOnly type="password" value={token} aria-label="Extension capability token" placeholder={tokenQuery.isPending ? "loading" : "unavailable"} /></label>
          <dl><div><dt>Capabilities</dt><dd>capture, autofill read</dd></div></dl>
          <div className="form-actions extension-pairing-actions">
            <button className="tab on" type="button" disabled={!token} onClick={() => void copyToken()}>copy token</button>
            <button className="tab" type="button" disabled={rotateToken.isPending} onClick={() => void rotate()}>{rotateToken.isPending ? "rotating" : confirmRotation ? "confirm rotate and disconnect" : "rotate token"}</button>
          </div>
          {message ? <div className="status-line" role="status">{message}</div> : null}
          {copyWarning ? <div className="banner inline" role="alert">{copyWarning}</div> : null}
        </div>
      </div>
    </section>
  );
}
