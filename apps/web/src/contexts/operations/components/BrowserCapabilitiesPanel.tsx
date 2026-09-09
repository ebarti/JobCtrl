import type {
  BrowserCapabilityId,
  BrowserCapabilityItem,
  DetectedBrowserId,
} from "@jobctrl/contracts";
import { Fragment, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../shared/ui/collapsible.js";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { Separator } from "../../../shared/ui/separator.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import {
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
  const [executablePaths, setExecutablePaths] = useState<
    Record<string, string>
  >({});
  const [selectedBrowserIds, setSelectedBrowserIds] = useState<
    Record<string, DetectedBrowserId>
  >({});
  const [manualPathErrors, setManualPathErrors] = useState<
    Record<string, string>
  >({});
  const [message, setMessage] = useState("");

  async function enableDetectedCapability(
    capabilityId: Exclude<BrowserCapabilityId, "core-browser">,
    detectedBrowserId: DetectedBrowserId,
    label: string,
  ) {
    setMessage("");
    try {
      await enable.mutateAsync({ capabilityId, detectedBrowserId });
      setMessage(`${LABELS[capabilityId]} enabled with ${label}.`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The selected browser could not be enabled.",
      );
    }
  }

  async function enableManualCapability(
    capabilityId: Exclude<BrowserCapabilityId, "core-browser">,
  ) {
    const executablePath = executablePaths[capabilityId]?.trim() ?? "";
    if (!executablePath) {
      setManualPathErrors((current) => ({
        ...current,
        [capabilityId]: "Enter the Chrome or Chromium executable path.",
      }));
      return;
    }
    setMessage("");
    setManualPathErrors((current) => ({ ...current, [capabilityId]: "" }));
    try {
      await enable.mutateAsync({ capabilityId, executablePath });
      setExecutablePaths((current) => ({ ...current, [capabilityId]: "" }));
      setMessage(
        `${LABELS[capabilityId]} enabled with the manually selected browser.`,
      );
    } catch (error) {
      setManualPathErrors((current) => ({
        ...current,
        [capabilityId]:
          error instanceof Error
            ? error.message
            : "The selected browser could not be enabled.",
      }));
    }
  }

  function renderCapabilityControls(capability: BrowserCapabilityItem) {
    if (capability.id === "core-browser") {
      return (
        <p className="text-sm text-muted-foreground">
          This capability is read-only.
        </p>
      );
    }

    const capabilityId = capability.id;
    const detectedBrowsers = query.data?.detectedBrowsers ?? [];
    const selectedBrowser =
      detectedBrowsers.find(
        (browser) => browser.id === selectedBrowserIds[capabilityId],
      ) ??
      detectedBrowsers[0] ??
      null;
    const selectItems = detectedBrowsers.map((browser) => ({
      label: browser.label,
      value: browser.id,
    }));
    const manualError = manualPathErrors[capabilityId] ?? "";

    return (
      <div className="flex flex-col gap-4">
        {!capability.enabled && detectedBrowsers.length > 0 ? (
          <div className="flex max-w-3xl flex-col gap-2">
            <FieldGroup
              className="gap-3 sm:grid sm:grid-cols-[minmax(16rem,32rem)_auto] sm:items-end"
              data-browser-detected-actions={capabilityId}
            >
              <Field>
                <FieldLabel htmlFor={`detected-browser-${capabilityId}`}>
                  Detected browser
                </FieldLabel>
                <Select
                  items={selectItems}
                  value={selectedBrowser?.id ?? null}
                  disabled={demo || capability.enabled}
                  onValueChange={(value) => {
                    if (value === "google-chrome" || value === "chromium") {
                      setSelectedBrowserIds((current) => ({
                        ...current,
                        [capabilityId]: value,
                      }));
                    }
                  }}
                >
                  <SelectTrigger
                    id={`detected-browser-${capabilityId}`}
                    aria-label={`Detected browser for ${LABELS[capabilityId]}`}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {selectItems.map((browser) => (
                        <SelectItem key={browser.value} value={browser.value}>
                          {browser.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Button
                className="w-fit max-w-xs shrink-0 justify-self-start whitespace-normal"
                type="button"
                disabled={
                  demo ||
                  capability.enabled ||
                  enable.isPending ||
                  !selectedBrowser
                }
                onClick={() => {
                  if (selectedBrowser) {
                    void enableDetectedCapability(
                      capabilityId,
                      selectedBrowser.id,
                      selectedBrowser.label,
                    );
                  }
                }}
              >
                Enable {selectedBrowser?.label ?? "browser"}
              </Button>
            </FieldGroup>
            <FieldDescription>
              Detected locally. Nothing is enabled or launched until you
              confirm.
            </FieldDescription>
          </div>
        ) : !capability.enabled ? (
          <p className="text-sm text-muted-foreground">
            No supported Chrome or Chromium installation was detected. You can
            provide one manually below.
          </p>
        ) : null}

        {capability.enabled ? (
          <div className="flex">
            <Button
              variant="outline"
              type="button"
              disabled={demo || !capability.enabled || disable.isPending}
              onClick={() =>
                void disable
                  .mutateAsync(capabilityId)
                  .then(() =>
                    setMessage(`${LABELS[capabilityId]} disabled immediately.`),
                  )
                  .catch((error: unknown) =>
                    setMessage(
                      error instanceof Error
                        ? error.message
                        : "Capability disable failed.",
                    ),
                  )
              }
            >
              Disable
            </Button>
          </div>
        ) : null}

        {!capability.enabled ? (
          <Collapsible defaultOpen={detectedBrowsers.length === 0}>
            <CollapsibleTrigger
              render={<Button variant="ghost" size="sm" type="button" />}
            >
              Advanced browser path
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="flex max-w-3xl flex-col gap-2">
                <FieldGroup className="gap-3 sm:grid sm:grid-cols-[minmax(16rem,32rem)_auto] sm:items-end">
                  <Field data-invalid={Boolean(manualError)}>
                    <FieldLabel htmlFor={`browser-executable-${capabilityId}`}>
                      Chrome or Chromium executable path
                    </FieldLabel>
                    <Input
                      id={`browser-executable-${capabilityId}`}
                      name={`browser-executable-${capabilityId}`}
                      type="text"
                      autoComplete="off"
                      aria-invalid={Boolean(manualError)}
                      disabled={demo || capability.enabled}
                      placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                      value={executablePaths[capabilityId] ?? ""}
                      onChange={(event) => {
                        setExecutablePaths((current) => ({
                          ...current,
                          [capabilityId]: event.target.value,
                        }));
                        setManualPathErrors((current) => ({
                          ...current,
                          [capabilityId]: "",
                        }));
                      }}
                    />
                    {manualError ? (
                      <FieldError>{manualError}</FieldError>
                    ) : null}
                  </Field>
                  <Button
                    className="w-fit max-w-xs justify-self-start whitespace-normal"
                    variant="outline"
                    type="button"
                    disabled={demo || capability.enabled || enable.isPending}
                    onClick={() => void enableManualCapability(capabilityId)}
                  >
                    Enable manual browser
                  </Button>
                </FieldGroup>
                <FieldDescription>
                  Use a manual executable path only when your browser is
                  installed in a non-standard location.
                </FieldDescription>
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

      </div>
    );
  }

  const capabilities = (query.data?.capabilities ?? []).filter(
    // LinkedIn/Discovery authentication belongs to the selected extension in
    // the user's live Chrome profile. Keep the legacy backend capability
    // readable for compatibility, but never offer profile copying in Settings.
    (capability) => capability.id !== "authenticated-linkedin-browser",
  );

  return (
    <Card
      aria-labelledby="browser-capabilities-title"
      data-browser-capabilities
    >
      <CardHeader>
        <CardTitle>
          <h2 id="browser-capabilities-title">Browser capabilities</h2>
        </CardTitle>
        <CardDescription>
          Review the managed browser and optional Apply browser. Discovery and
          LinkedIn enrichment use the paired extension in your live Chrome
          profile, configured separately below.
        </CardDescription>
        <CardAction>
          <StatusBadge icon={false} tone="muted">
            {demo ? "Preview only" : "Confirmation required"}
          </StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {query.error ? (
          <Alert variant="destructive">
            <AlertTitle>Browser capability status is unavailable</AlertTitle>
            <AlertDescription>
              Try again before enabling or changing browser access.
            </AlertDescription>
          </Alert>
        ) : null}
        <div aria-busy={query.isPending}>
          {query.isPending ? (
            <p className="status-line" role="status">
              Checking browser access…
            </p>
          ) : null}
          {capabilities.map((capability, index) => (
            <Fragment key={capability.id}>
              {index > 0 ? <Separator /> : null}
              <article
                className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0"
                data-browser-access={browserAccessKind(capability.id)}
                data-browser-capability={capability.id}
              >
                <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p
                      className="browser-capability-kind"
                      data-typography="label"
                    >
                      {browserAccessLabel(capability.id)}
                    </p>
                    <CardTitle>
                      <h3>{LABELS[capability.id]}</h3>
                    </CardTitle>
                    <CardDescription>
                      <p>{capability.detail}</p>
                    </CardDescription>
                  </div>
                  <StatusBadge
                    icon={false}
                    tone={browserStatusTone(capability.status)}
                  >
                    {browserStatusLabel(capability.id, capability.status)}
                  </StatusBadge>
                </header>
                {renderCapabilityControls(capability)}
              </article>
            </Fragment>
          ))}
        </div>
      </CardContent>
      {message ? (
        <CardFooter className="border-t">
          <p className="text-sm text-muted-foreground" role="status">
            {message}
          </p>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function browserAccessKind(
  capabilityId: BrowserCapabilityId,
): "consent" | "managed" | "optional" {
  if (capabilityId === "core-browser") return "managed";
  if (capabilityId === "authenticated-linkedin-browser") return "consent";
  return "optional";
}

function browserAccessLabel(capabilityId: BrowserCapabilityId): string {
  if (capabilityId === "core-browser") return "Managed by JobCtrl";
  if (capabilityId === "authenticated-linkedin-browser") {
    return "Optional access · separate consent for profile copy";
  }
  return "Optional browser access";
}

function browserStatusLabel(
  capabilityId: BrowserCapabilityId,
  status: BrowserCapabilityItem["status"],
): string {
  if (status === "ready") return "Ready";
  if (status === "disabled") return "Off";
  if (status === "missing") {
    return capabilityId === "authenticated-linkedin-browser"
      ? "Profile copy missing"
      : "Browser missing";
  }
  if (status === "failed") return "Failed";
  return "Unavailable";
}

function browserStatusTone(
  status: BrowserCapabilityItem["status"],
): "danger" | "muted" | "ok" | "warn" {
  if (status === "ready") return "ok";
  if (status === "failed") return "danger";
  if (status === "missing" || status === "unavailable") return "warn";
  return "muted";
}
