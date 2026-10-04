import type {
  EmployerAnalysisRequirement,
  InterviewPrep,
  InterviewPrepItem,
  InterviewPrepItemKind,
} from "@jobctrl/contracts";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { JSX, ReactNode } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ContextHelp } from "../../../shared/ui/context-help.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import {
  AuditTechnicalDetails,
  type ResolveAuditEvidenceReference,
} from "./AuditTechnicalDetails.js";
import { GenerateInterviewPrepButton } from "./GenerateInterviewPrepButton.js";

export interface InterviewPrepPanelProps {
  jobId: string;
  prep: InterviewPrep | null;
  requirements?: readonly EmployerAnalysisRequirement[];
  resolveEvidenceReference?: ResolveAuditEvidenceReference;
  reflectionContent?: ReactNode;
}

const KIND_LABELS: Record<InterviewPrepItemKind, string> = {
  theme: "Theme",
  star_draft: "STAR draft",
  gap_drill: "Gap drill",
  company_note: "Company note",
  question_outline: "Question outline",
};
const EMPTY_REQUIREMENTS: readonly EmployerAnalysisRequirement[] = [];

function kindTone(kind: InterviewPrepItemKind): "info" | "muted" | "warn" {
  if (kind === "gap_drill") return "warn";
  if (kind === "company_note") return "muted";
  return "info";
}

function EvidenceReference({
  evidenceId,
  jobId,
  resolveEvidenceReference,
}: {
  readonly evidenceId: string;
  readonly jobId: string;
  readonly resolveEvidenceReference:
    | ResolveAuditEvidenceReference
    | undefined;
}): JSX.Element {
  const reference = resolveEvidenceReference
    ? resolveEvidenceReference(evidenceId)
    : null;
  if (reference === undefined) {
    return <li className="muted">Loading evidence details.</li>;
  }
  if (!reference) {
    return <li className="muted">Evidence reference unavailable.</li>;
  }
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <Link
        className="font-medium"
        search={{ q: "", entry: reference.entryId, job: jobId }}
        to="/evidence-map"
      >
        {reference.title}
      </Link>
      {reference.excerpt ? (
        <span className="muted leading-relaxed">{reference.excerpt}</span>
      ) : null}
    </li>
  );
}

function PrepItemCard({
  item,
  jobId,
  requirementsById,
  resolveEvidenceReference,
}: {
  readonly item: InterviewPrepItem;
  readonly jobId: string;
  readonly requirementsById: ReadonlyMap<
    string,
    EmployerAnalysisRequirement
  >;
  readonly resolveEvidenceReference:
    | ResolveAuditEvidenceReference
    | undefined;
}): JSX.Element {
  return (
    <article className="interview-prep-item">
      <div className="interview-prep-item-head">
        <span className={`tag ${kindTone(item.kind)}`}>
          {KIND_LABELS[item.kind]}
        </span>
        <h4 aria-label={item.title}>{item.title} <ContextHelp label="Interview prep item" description="Generated practice material, not a verified personal claim or a response to send unchanged. Its kind identifies a theme, STAR draft, gap drill, or company note; inspect the linked evidence and requirements below." /></h4>
      </div>
      <p>{item.generatedText}</p>
      {item.evidenceIds.length || item.requirementIds.length ? (
        <dl className="interview-prep-provenance">
          {item.evidenceIds.length ? (
            <>
              <dt>Grounded in <ContextHelp label="Interview prep evidence" description="Candidate Evidence Map references recorded for this item. Open a reference to verify the underlying fact; an unavailable reference is not replaced with a generated claim." /></dt>
              <dd>
                <ul className="compact-list">
                  {item.evidenceIds.map((evidenceId) => (
                    <EvidenceReference
                      evidenceId={evidenceId}
                      jobId={jobId}
                      key={evidenceId}
                      resolveEvidenceReference={resolveEvidenceReference}
                    />
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {item.requirementIds.length ? (
            <>
              <dt>
                {item.kind === "gap_drill"
                  ? "Gap requirements"
                  : "Requirements"}
                <ContextHelp label="Interview prep requirements" description="Role-analysis requirement references linked to this practice item. A missing reference stays unavailable instead of inferring requirement text." />
              </dt>
              <dd>
                <ul className="compact-list">
                  {item.requirementIds.map((requirementId) => (
                    <li
                      className={
                        requirementsById.has(requirementId)
                          ? undefined
                          : "muted"
                      }
                      key={requirementId}
                    >
                      {requirementsById.get(requirementId)?.text ??
                        "Requirement reference unavailable."}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {item.evidenceIds.length || item.requirementIds.length ? (
        <AuditTechnicalDetails>
          <dl className="interview-prep-provenance">
            {item.evidenceIds.length ? (
              <>
                <dt>Evidence IDs</dt>
                <dd>
                  <ul className="compact-list">
                    {item.evidenceIds.map((evidenceId) => (
                      <li key={evidenceId}>
                        <code>{evidenceId}</code>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
            {item.requirementIds.length ? (
              <>
                <dt>Requirement IDs</dt>
                <dd>
                  <ul className="compact-list">
                    {item.requirementIds.map((requirementId) => (
                      <li key={requirementId}>
                        <code>{requirementId}</code>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>
        </AuditTechnicalDetails>
      ) : null}
      {item.sourceText.length ? (
        <details className="interview-prep-sources">
          <summary>Profile source text</summary>
          <ul>
            {item.sourceText.map((source, index) => (
              <li key={`${item.itemId}:source:${index}`}>{source}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {item.warnings.length ? (
        <ResidualWarnings warnings={item.warnings} />
      ) : null}
    </article>
  );
}

function GateAudit({ prep }: { readonly prep: InterviewPrep }) {
  const warnings = prep.gateAudit.warnings;
  return (
    <div className="interview-prep-gate">
      <StatusBadge tone={prep.gateAudit.status === "passed" ? "ok" : "danger"}>
        gate {prep.gateAudit.status}
      </StatusBadge>
      <ContextHelp label="Interview prep validation" description="Saved validation result for this generated preparation set. The generation and model identify the stored version; warnings are accepted residual notes to inspect, and a passed gate does not verify every statement independently." />
      {prep.gateAudit.judgeVerdict ? (
        <StatusBadge
          tone={prep.gateAudit.status === "passed" ? "ok" : "danger"}
        >
          {prep.gateAudit.judgeVerdict}
        </StatusBadge>
      ) : null}
      <span className="tag muted">generation {prep.generation}</span>
      {prep.model ? <span className="tag muted">{prep.model}</span> : null}
      {warnings.length ? <ResidualWarnings warnings={warnings} /> : null}
    </div>
  );
}

function ResidualWarnings({
  warnings,
}: {
  readonly warnings: readonly string[];
}) {
  return (
    <Alert className="interview-prep-warning-group">
      <IconAlertTriangle aria-hidden="true" />
      <AlertTitle>Accepted residual warnings</AlertTitle>
      <AlertDescription>
        <ul>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function InterviewPrepPanel({
  jobId,
  prep,
  requirements = EMPTY_REQUIREMENTS,
  resolveEvidenceReference,
  reflectionContent,
}: InterviewPrepPanelProps): JSX.Element {
  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.id, requirement]),
  );
  return (
    <section
      className="section interview-prep-panel"
      aria-label="Interview preparation"
    >
      <div className="interview-prep-heading">
        <h3 aria-label="Interview prep">Interview prep <ContextHelp label="Interview prep" description="Generated interview practice grounded in recorded candidate evidence and role requirements when references exist. No prep generated means no accepted set is stored; generating a new draft does not submit an application." /></h3>
        <GenerateInterviewPrepButton
          jobId={jobId}
          hasAcceptedPrep={Boolean(prep)}
        />
      </div>
      {prep ? (
        <>
          <GateAudit prep={prep} />
          <div className="interview-prep-items">
            {prep.items.map((item) => (
              <PrepItemCard
                item={item}
                jobId={jobId}
                key={item.itemId}
                requirementsById={requirementsById}
                resolveEvidenceReference={resolveEvidenceReference}
              />
            ))}
          </div>
          {reflectionContent ? (
            <div className="interview-prep-reflections">
              {reflectionContent}
            </div>
          ) : null}
        </>
      ) : (
        <Empty title="No interview prep generated." />
      )}
    </section>
  );
}
