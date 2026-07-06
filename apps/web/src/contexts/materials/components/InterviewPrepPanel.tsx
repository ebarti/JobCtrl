import type { InterviewPrep, InterviewPrepItem, InterviewPrepItemKind } from "@jobhunter/contracts";
import { Link } from "@tanstack/react-router";

import { Empty } from "../../../shared/ui/empty.js";
import { GenerateInterviewPrepButton } from "./GenerateInterviewPrepButton.js";

export interface InterviewPrepPanelProps {
  jobId: string;
  prep: InterviewPrep | null;
}

const KIND_LABELS: Record<InterviewPrepItemKind, string> = {
  theme: "Theme",
  star_draft: "STAR draft",
  gap_drill: "Gap drill",
  company_note: "Company note",
};

function kindTone(kind: InterviewPrepItemKind): "info" | "muted" | "warn" {
  if (kind === "gap_drill") return "warn";
  if (kind === "company_note") return "muted";
  return "info";
}

function PrepItemCard({ item, jobId }: { readonly item: InterviewPrepItem; readonly jobId: string }) {
  return (
    <article className="interview-prep-item">
      <div className="interview-prep-item-head">
        <span className={`tag ${kindTone(item.kind)}`}>{KIND_LABELS[item.kind]}</span>
        <h4>{item.title}</h4>
      </div>
      <p>{item.generatedText}</p>
      {item.evidenceIds.length || item.requirementIds.length ? (
        <dl className="interview-prep-provenance">
          {item.evidenceIds.length ? (
            <>
              <dt>Grounded in</dt>
              <dd>
                {item.evidenceIds.map((evidenceId) => (
                  <Link
                    className="tag info"
                    key={evidenceId}
                    search={{ q: "", entry: evidenceId, job: jobId }}
                    to="/evidence-map"
                  >
                    {evidenceId}
                  </Link>
                ))}
              </dd>
            </>
          ) : null}
          {item.requirementIds.length ? (
            <>
              <dt>{item.kind === "gap_drill" ? "Gap requirements" : "Requirements"}</dt>
              <dd>
                {item.requirementIds.map((requirementId) => (
                  <span className="tag muted" key={requirementId}>
                    {requirementId}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
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
        <div className="interview-prep-warning-group">
          <span className="tag warn">accepted residual warnings</span>
          <ul>
            {item.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function GateAudit({ prep }: { readonly prep: InterviewPrep }) {
  const warnings = prep.gateAudit.warnings;
  return (
    <div className="interview-prep-gate">
      <span className={prep.gateAudit.status === "passed" ? "tag ok" : "tag danger"}>
        gate {prep.gateAudit.status}
      </span>
      {prep.gateAudit.judgeVerdict ? <span className="tag muted">{prep.gateAudit.judgeVerdict}</span> : null}
      <span className="tag muted">generation {prep.generation}</span>
      {prep.model ? <span className="tag muted">{prep.model}</span> : null}
      {warnings.length ? (
        <div className="interview-prep-warning-group">
          <span className="tag warn">accepted residual warnings</span>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function InterviewPrepPanel({ jobId, prep }: InterviewPrepPanelProps) {
  return (
    <section className="section interview-prep-panel" aria-label="Interview preparation">
      <div className="interview-prep-heading">
        <h3>Interview prep</h3>
        <GenerateInterviewPrepButton jobId={jobId} hasAcceptedPrep={Boolean(prep)} />
      </div>
      {prep ? (
        <>
          <GateAudit prep={prep} />
          <div className="interview-prep-items">
            {prep.items.map((item) => (
              <PrepItemCard item={item} jobId={jobId} key={item.itemId} />
            ))}
          </div>
        </>
      ) : (
        <Empty title="No interview prep generated." />
      )}
    </section>
  );
}
