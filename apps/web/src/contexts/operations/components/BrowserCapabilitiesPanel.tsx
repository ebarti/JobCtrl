import type { BrowserCapabilityId, BrowserCapabilityItem } from "@jobctrl/contracts";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { AdaptiveFieldGrid } from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import { ChoiceControl } from "../../../shared/ui/choice-control.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  StatusLabel,
  type StatusLabelTone,
} from "../../../shared/ui/status-label.js";
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

const STATUS_TONES: Record<BrowserCapabilityItem["status"], StatusLabelTone> = {
  ready: "ok",
  failed: "danger",
  unavailable: "danger",
  missing: "warn",
  disabled: "muted",
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
      <div className="browser-capability-controls">
        <AdaptiveFieldGrid columns={2} minColumnWidth={280} density="compact">
          <Field data-disabled={demo || capability.enabled || undefined}>
            <FieldLabel htmlFor={`browser-executable-${capabilityId}`}>
              Chrome or Chromium executable path
            </FieldLabel>
            <Input
              id={`browser-executable-${capabilityId}`}
              name={`browser-executable-${capabilityId}`}
              type="text"
              autoComplete="off"
              disabled={demo || capability.enabled}
              value={executablePaths[capabilityId] ?? ""}
              onChange={(event) =>
                setExecutablePaths((current) => ({
                  ...current,
                  [capabilityId]: event.target.value,
                }))
              }
            />
            <FieldDescription>
              Saved as non-secret browser configuration in config.json. The status API does not
              echo local paths.
            </FieldDescription>
          </Field>
        </AdaptiveFieldGrid>
        <div className="form-actions browser-capability-actions">
          <Button
            type="button"
            disabled={demo || capability.enabled || enable.isPending}
            onClick={() => void enableCapability(capabilityId)}
          >
            Enable selected browser
          </Button>
          <Button
            variant="outline"
            type="button"
            disabled={demo || !capability.enabled || disable.isPending}
            onClick={() =>
              void disable
                .mutateAsync(capabilityId)
                .then(() => setMessage(`${LABELS[capabilityId]} disabled immediately.`))
                .catch(() => setMessage("Capability disable failed."))
            }
          >
            Disable now
          </Button>
        </div>
        {capabilityId === "authenticated-linkedin-browser" && capability.enabled ? (
          <fieldset className="provider-choice-fieldset browser-profile-copy">
            <legend>Separate authenticated profile copy</legend>
            <Field>
              <FieldLabel htmlFor="linkedin-profile-source">
                Existing browser profile directory
              </FieldLabel>
              <Input
                id="linkedin-profile-source"
                name="linkedin-profile-source"
                type="password"
                autoComplete="off"
                value={sourceProfilePath}
                onChange={(event) => setSourceProfilePath(event.target.value)}
              />
              <FieldDescription>
                Request-only. Cleared after submission and never returned or logged.
              </FieldDescription>
            </Field>
            <ChoiceControl
              id="linkedin-profile-consent"
              name="linkedin-profile-consent"
              label="I explicitly consent to copy this profile into JobCtrl-owned storage."
              checked={profileConsent}
              onCheckedChange={(checked) => setProfileConsent(checked === true)}
            />
            <Button
              type="button"
              disabled={copyProfile.isPending || !profileConsent || !sourceProfilePath.trim()}
              onClick={() => void copyLinkedInProfile()}
            >
              Copy selected profile
            </Button>
          </fieldset>
        ) : null}
      </div>
    );
  }

  return (
    <DisclosureSection
      className="browser-capabilities-settings"
      title="Browser capabilities"
      description={
        demo
          ? "Demo · read only"
          : "Explicit adoption · revocable managed browser capabilities"
      }
      collapsedSummary={demo ? "Demo · read only" : "Core and optional browser access"}
    >
      <div className="banner credential-store-notice credential-store-notice--guidance">
        JobCtrl never auto-detects or adopts Chrome. Optional access is fail-closed and can be revoked immediately. Optional managed downloads are unavailable until a signed supply chain exists.
      </div>
      {query.error ? <div className="banner inline" role="alert">Browser capability status is unavailable.</div> : null}
      <div className="browser-capability-list" aria-busy={query.isPending}>
        {(query.data?.capabilities ?? []).map((capability) => (
          <DisclosureSection
            className="browser-capability-section"
            key={capability.id}
            title={LABELS[capability.id]}
            description={capability.detail}
            collapsedSummary={(
              <StatusLabel tone={browserCapabilityTone(capability.status)}>
                Status: {capability.status}
              </StatusLabel>
            )}
            defaultOpen={false}
          >
            <StatusLabel
              className="browser-capability-status"
              tone={browserCapabilityTone(capability.status)}
            >
              Current status: {capability.status}
            </StatusLabel>
            {renderCapabilityControls(capability)}
          </DisclosureSection>
        ))}
      </div>
      {message ? <div className="status-line" role="status">{message}</div> : null}
    </DisclosureSection>
  );
}

function browserCapabilityTone(
  status: BrowserCapabilityItem["status"],
): StatusLabelTone {
  return STATUS_TONES[status];
}
