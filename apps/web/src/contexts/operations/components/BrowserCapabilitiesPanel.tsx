import type { BrowserCapabilityId, BrowserCapabilityItem } from "@jobctrl/contracts";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import {
  useCopyLinkedInBrowserProfileMutation,
  useDisableBrowserCapabilityMutation,
  useEnableBrowserCapabilityMutation,
} from "../hooks/useBrowserCapabilityMutations.js";
import { useBrowserCapabilitiesQuery } from "../hooks/useBrowserCapabilitiesQuery.js";

const LABELS: Record<BrowserCapabilityId, string> = {
  "core-browser": "Core managed browser",
  "auto-apply-browser": "Auto-apply browser",
  "authenticated-linkedin-browser": "Authenticated LinkedIn browser",
};

export function BrowserCapabilitiesPanel() {
  const { featureFlags } = usePorts();
  const demo = featureFlags.get("demoMode", false);
  const query = useBrowserCapabilitiesQuery();
  const enable = useEnableBrowserCapabilityMutation();
  const disable = useDisableBrowserCapabilityMutation();
  const copyProfile = useCopyLinkedInBrowserProfileMutation();
  const [executablePaths, setExecutablePaths] = useState<Record<string, string>>({});
  const [sourceProfilePath, setSourceProfilePath] = useState("");
  const [profileConsent, setProfileConsent] = useState(false);
  const [message, setMessage] = useState("");

  async function enableCapability(capabilityId: Exclude<BrowserCapabilityId, "core-browser">) {
    const executablePath = executablePaths[capabilityId]?.trim() ?? "";
    if (!executablePath) return setMessage("Choose an explicit Chrome or Chromium executable path.");
    setExecutablePaths((current) => ({ ...current, [capabilityId]: "" }));
    try {
      await enable.mutateAsync({ capabilityId, executablePath });
      setMessage(`${LABELS[capabilityId]} enabled from the explicitly selected executable.`);
    } catch {
      setMessage("The selected executable could not be enabled. No browser was adopted.");
    }
  }

  async function copyLinkedInProfile() {
    const selectedPath = sourceProfilePath.trim();
    setSourceProfilePath("");
    setProfileConsent(false);
    if (!selectedPath || !profileConsent) return setMessage("Select a profile directory and grant the separate copy consent.");
    try {
      await copyProfile.mutateAsync({ sourceProfilePath: selectedPath, consent: true, consentMethod: "explicit-ui-v1" });
      setMessage("The selected profile was copied into JobCtrl-owned storage.");
    } catch {
      setMessage("The selected profile could not be copied. Its source path was cleared.");
    }
  }

  function renderCapabilityControls(capability: BrowserCapabilityItem) {
    if (capability.id === "core-browser") {
      return <p className="provider-copy">Managed by JobCtrl and read-only.</p>;
    }

    const capabilityId = capability.id;
    return (
      <div className="provider-form">
        <label className="field" htmlFor={`browser-executable-${capabilityId}`}>
          <span>Chrome or Chromium executable path</span>
          <input id={`browser-executable-${capabilityId}`} name={`browser-executable-${capabilityId}`} type="password" autoComplete="off" disabled={demo || capability.enabled} value={executablePaths[capabilityId] ?? ""} onChange={(event) => setExecutablePaths((current) => ({ ...current, [capabilityId]: event.target.value }))} />
          <small>Write-only: never returned, stored in browser state, or shown after submission.</small>
        </label>
        <div className="form-actions">
          <button className="tab on" type="button" disabled={demo || capability.enabled || enable.isPending} onClick={() => void enableCapability(capabilityId)}>enable selected browser</button>
          <button className="tab" type="button" disabled={demo || !capability.enabled || disable.isPending} onClick={() => void disable.mutateAsync(capabilityId).then(() => setMessage(`${LABELS[capabilityId]} disabled immediately.`)).catch(() => setMessage("Capability disable failed."))}>disable now</button>
        </div>
        {capabilityId === "authenticated-linkedin-browser" && capability.enabled ? (
          <fieldset className="provider-choice-fieldset">
            <legend>Separate authenticated profile copy</legend>
            <label className="field" htmlFor="linkedin-profile-source">
              <span>Existing browser profile directory</span>
              <input id="linkedin-profile-source" name="linkedin-profile-source" type="password" autoComplete="off" value={sourceProfilePath} onChange={(event) => setSourceProfilePath(event.target.value)} />
              <small>Request-only. Cleared after submission and never returned or logged.</small>
            </label>
            <label className="provider-choice-option" htmlFor="linkedin-profile-consent">
              <input id="linkedin-profile-consent" name="linkedin-profile-consent" type="checkbox" checked={profileConsent} onChange={(event) => setProfileConsent(event.target.checked)} />
              <span>I explicitly consent to copy this profile into JobCtrl-owned storage.</span>
            </label>
            <button className="tab on" type="button" disabled={copyProfile.isPending || !profileConsent || !sourceProfilePath.trim()} onClick={() => void copyLinkedInProfile()}>copy selected profile</button>
          </fieldset>
        ) : null}
      </div>
    );
  }

  return (
    <section className="card full provider-setup-shell">
      <CardHeader title="Browser capabilities" meta={demo ? "demo · read only" : "explicit adoption"} />
      <div className="banner credential-store-notice credential-store-notice--guidance">
        JobCtrl never auto-detects or adopts Chrome. Optional access is fail-closed and can be revoked immediately. Optional managed downloads are unavailable until a signed supply chain exists.
      </div>
      {query.error ? <div className="banner inline" role="alert">Browser capability status is unavailable.</div> : null}
      <div className="provider-card-list" aria-busy={query.isPending}>
        {(query.data?.capabilities ?? []).map((capability) => (
          <article className="provider-card" key={capability.id}>
            <header className="provider-card-header">
              <div><h3>{LABELS[capability.id]}</h3><p>{capability.detail}</p></div>
              <span className={`tag ${capability.status === "ready" ? "ok" : "muted"}`}>{capability.status}</span>
            </header>
            {renderCapabilityControls(capability)}
          </article>
        ))}
      </div>
      {message ? <div className="status-line" role="status">{message}</div> : null}
    </section>
  );
}
