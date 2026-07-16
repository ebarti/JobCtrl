import {
  CompensationSourcePolicyUpdateRequestSchema,
  type CompensationSourcePolicyUpdateRequest,
  type UserCompensationSourceControl,
} from "@jobctrl/contracts";
import { useState } from "react";

import type { CompensationSourcePolicySummary } from "../../operations/types.js";
import { useCompensationSourcePolicyQuery } from "../../operations/hooks/useCompensationSourcePolicyQuery.js";
import { useUpdateCompensationSourcePolicyMutation } from "../hooks/useUpdateCompensationSourcePolicyMutation.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { Switch } from "../../../shared/ui/switch.js";

const NOT_CONFIGURED = "not_configured";

export function CompensationSourcePolicyPanel() {
  const query = useCompensationSourcePolicyQuery();
  const updatePolicy = useUpdateCompensationSourcePolicyMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const sources = query.data?.sources ?? [];

  const saveControl = (request: unknown) => {
    const parsed = CompensationSourcePolicyUpdateRequestSchema.safeParse(request);
    if (!parsed.success) {
      setStatusMessage(
        parsed.error.issues[0]?.message ??
          "The compensation source settings are invalid.",
      );
      return;
    }
    setStatusMessage("");
    updatePolicy.mutate(parsed.data, {
      onSuccess: () => {
        setStatusMessage("Compensation source settings saved.");
      },
      onError: (error) => {
        setStatusMessage(error.message);
      },
    });
  };

  return (
    <section className="card full compensation-source-policy-panel">
      <CardHeader title="Compensation sources" meta="editable source policy" />
      {query.error ? <div className="banner inline">{query.error.message}</div> : null}
      {statusMessage ? (
        <div className="status-line" aria-live="polite">
          {statusMessage}
        </div>
      ) : null}
      {query.isLoading ? <Empty title="Loading compensation sources." /> : null}
      {!query.isLoading && !query.error ? (
        <div className="source-registry-table-wrap">
          <table className="source-registry-table" aria-label="Compensation source policy">
            <caption>{sources.length} configured source policies</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Enablement</th>
                <th scope="col">Policy</th>
                <th scope="col">Status</th>
                <th scope="col">Freshness</th>
                <th scope="col">Attribution</th>
                <th scope="col">Coverage</th>
                <th scope="col">Supported fields</th>
                <th scope="col">Access notes</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <CompensationSourcePolicyRow
                  key={source.sourceId}
                  busy={updatePolicy.isPending}
                  onUpdate={saveControl}
                  source={source}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function CompensationSourcePolicyRow({
  busy,
  onUpdate,
  source,
}: {
  busy: boolean;
  onUpdate: (request: CompensationSourcePolicyUpdateRequest) => void;
  source: CompensationSourcePolicySummary;
}) {
  return (
    <tr>
      <th scope="row">
        <strong>{source.displayName}</strong>
        <div className="meta">{source.sourceId}</div>
        <div className="source-table-actions">
          {source.sourceUrl ? (
            <a href={source.sourceUrl} aria-label={`${source.displayName} source`}>
              source
            </a>
          ) : (
            <span className="meta">local posting</span>
          )}
          {source.termsUrl ? (
            <a href={source.termsUrl} aria-label={`${source.displayName} terms`}>
              terms
            </a>
          ) : null}
        </div>
      </th>
      <td>
        <CompensationSourceControls
          busy={busy}
          onUpdate={onUpdate}
          source={source}
        />
      </td>
      <td>
        <div>{formatLabel(source.sourceType)}</div>
        <span className="tag muted">{formatLabel(source.accessMode)}</span>
      </td>
      <td>
        <div className="flex flex-col items-start gap-1">
          <span className={availabilityClass(source.availability)}>
            {formatLabel(source.availability)}
          </span>
          <span className={licenseClass(source.licenseStatus)}>
            {formatLabel(source.licenseStatus)}
          </span>
          <div className="meta">{source.configured ? "configured" : "not configured"}</div>
        </div>
      </td>
      <td>{source.freshnessPolicy}</td>
      <td>{source.attributionRequirement}</td>
      <td>
        <div>{formatLabel(source.coverage.geography)}</div>
        <div className="meta">{source.coverage.regions.join(", ") || "none configured"}</div>
        <div className="meta">{source.coverage.notes}</div>
      </td>
      <td>{renderSupportedFields(source)}</td>
      <td>
        {source.disabledReason ? <div className="banner inline">{source.disabledReason}</div> : null}
        {source.notes.map((note) => (
          <div key={note} className="meta">
            {note}
          </div>
        ))}
      </td>
    </tr>
  );
}

function CompensationSourceControls({
  busy,
  onUpdate,
  source,
}: {
  busy: boolean;
  onUpdate: (request: CompensationSourcePolicyUpdateRequest) => void;
  source: CompensationSourcePolicySummary;
}) {
  if (source.control.kind === "fixed") {
    return <span className="tag muted">always enabled</span>;
  }

  const control = source.control;
  const accessModeId = `${source.sourceId}-access-mode`;
  const accessModeLabelId = `${accessModeId}-label`;
  const coverageId = `${source.sourceId}-europe-coverage`;
  const coverageLabelId = `${coverageId}-label`;
  const enabledId = `${source.sourceId}-enabled`;
  const enabledLabelId = `${enabledId}-label`;
  const enabledHelpId = `${enabledId}-help`;
  const prerequisitesMet =
    control.accessMode !== null &&
    (!control.europeCoverageRequired || control.europeCoverageConfirmed);
  const accessModeItems = [
    { label: "Not configured", value: NOT_CONFIGURED },
    ...control.allowedAccessModes.map((mode) => ({
      label: formatLabel(mode),
      value: mode,
    })),
  ];

  const update = (
    patch: Partial<
      Pick<
        UserCompensationSourceControl,
        "accessMode" | "enabled" | "europeCoverageConfirmed"
      >
    >,
  ) => {
    const next = { ...control, ...patch };
    if (source.sourceId === "levels_fyi") {
      onUpdate({
        sourceId: "levels_fyi",
        enabled: next.enabled,
        accessMode:
          next.accessMode === "public_markdown" ||
          next.accessMode === "licensed_api" ||
          next.accessMode === "licensed_data_feed" ||
          next.accessMode === "enterprise_mcp"
            ? next.accessMode
            : null,
        europeCoverageConfirmed: next.europeCoverageConfirmed,
      });
      return;
    }
    if (source.sourceId === "glassdoor") {
      onUpdate({
        sourceId: "glassdoor",
        enabled: next.enabled,
        accessMode:
          next.accessMode === "partner_api" ||
          next.accessMode === "written_permission"
            ? next.accessMode
            : null,
      });
    }
  };

  return (
    <FieldSet>
      <FieldLegend className="sr-only">
        {source.displayName} source settings
      </FieldLegend>
      <FieldGroup className="min-w-64 gap-3">
        <Field data-disabled={busy}>
          <FieldLabel id={accessModeLabelId} htmlFor={accessModeId}>
            {source.displayName} access mode
          </FieldLabel>
          <Select
            items={accessModeItems}
            disabled={busy}
            value={control.accessMode ?? NOT_CONFIGURED}
            onValueChange={(value) => {
              if (value === null) return;
              update({
                accessMode:
                  value === NOT_CONFIGURED
                    ? null
                    : (value as UserCompensationSourceControl["accessMode"]),
              });
            }}
          >
            <SelectTrigger
              id={accessModeId}
              aria-labelledby={accessModeLabelId}
            >
              <SelectValue placeholder="Choose access basis" />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {accessModeItems.map((item) => (
                  <SelectItem
                    key={item.value}
                    disabled={
                      item.value === NOT_CONFIGURED && control.enabled
                    }
                    value={item.value}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {control.europeCoverageRequired ? (
          <Field orientation="horizontal" data-disabled={busy}>
            <FieldContent>
              <FieldLabel id={coverageLabelId} htmlFor={coverageId}>
                Confirm {source.displayName} Europe coverage
              </FieldLabel>
              <FieldDescription>
                Confirm that the configured agreement covers European data.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={coverageId}
              aria-labelledby={coverageLabelId}
              checked={control.europeCoverageConfirmed}
              disabled={busy}
              onCheckedChange={(checked) =>
                update({ europeCoverageConfirmed: checked })
              }
            />
          </Field>
        ) : null}
        <Field
          orientation="horizontal"
          data-disabled={
            busy || (!control.enabled && !prerequisitesMet)
          }
        >
          <FieldContent>
            <FieldLabel id={enabledLabelId} htmlFor={enabledId}>
              Enable {source.displayName}
            </FieldLabel>
            <FieldDescription id={enabledHelpId}>
              {prerequisitesMet
                ? source.sourceId === "levels_fyi" &&
                  control.accessMode === "public_markdown"
                  ? "Read attributed public salary pages on future compensation refreshes."
                  : "Use configured rows on future compensation refreshes."
                : "Choose an access basis and confirm required coverage first."}
            </FieldDescription>
          </FieldContent>
          <Switch
            id={enabledId}
            aria-labelledby={enabledLabelId}
            aria-describedby={enabledHelpId}
            checked={control.enabled}
            disabled={busy || (!control.enabled && !prerequisitesMet)}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

function renderSupportedFields(source: CompensationSourcePolicySummary) {
  if (source.supportedFields.length === 0) {
    return <span className="tag muted">none until permitted</span>;
  }
  return (
    <div className="job-audit-tag-group" aria-label={`${source.displayName} supported fields`}>
      {source.supportedFields.map((field) => (
        <span key={field} className="tag info">
          {formatLabel(field)}
        </span>
      ))}
    </div>
  );
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function availabilityClass(availability: CompensationSourcePolicySummary["availability"]): string {
  return availability === "available" ? "tag ok" : "tag warn";
}

function licenseClass(status: CompensationSourcePolicySummary["licenseStatus"]): string {
  if (status === "permitted" || status === "not_required") {
    return "tag ok";
  }
  return "tag warn";
}
