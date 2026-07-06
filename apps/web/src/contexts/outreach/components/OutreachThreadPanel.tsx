import type { OutreachDraftDto, OutreachThreadDetail } from "@jobhunter/contracts";
import { useState, type JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ReviseDraftForm } from "../forms/revise-draft-form.js";
import { SendLogForm } from "../forms/send-log-form.js";
import { useOutreachThreadQuery } from "../hooks/useOutreachThreadQuery.js";
import { outreachDraftKindLabel } from "../lib/draft-copy.js";
import { ApproveDraftButton } from "./ApproveDraftButton.js";
import { CopyDraftButton } from "./CopyDraftButton.js";
import { DraftClaimProvenanceList } from "./DraftClaimProvenanceList.js";
import { DraftGateResultsPanel } from "./DraftGateResultsPanel.js";
import { DraftStatusBadge } from "./DraftStatusBadge.js";
import { FollowUpPanel } from "./FollowUpPanel.js";
import { GenerateDraftButton } from "./GenerateDraftButton.js";
import { OutreachSendLogList } from "./OutreachSendLogList.js";
import { RejectDraftButton } from "./RejectDraftButton.js";

export interface OutreachThreadPanelProps {
  contactId: string;
  jobId?: string;
}

function approvedDraftOf(thread: OutreachThreadDetail): OutreachDraftDto | undefined {
  return thread.drafts.find((draft) => draft.status === "approved");
}

function candidateUnderReviewOf(thread: OutreachThreadDetail): OutreachDraftDto | undefined {
  return thread.drafts
    .filter((draft) => draft.status === "candidate")
    .sort((first, second) => second.generation - first.generation)
    .at(0);
}

function historyNewestFirst(thread: OutreachThreadDetail): OutreachDraftDto[] {
  return [...thread.drafts].sort((first, second) => second.generation - first.generation);
}

function DraftBody({ bodyText }: { bodyText: string }): JSX.Element {
  return (
    <p className="outreach-draft-body" style={{ whiteSpace: "pre-wrap" }}>
      {bodyText}
    </p>
  );
}

function DraftMeta({ draft, timestamp }: { draft: OutreachDraftDto; timestamp: string }): JSX.Element {
  return (
    <div className="outreach-draft-meta">
      <DraftStatusBadge status={draft.status} />
      <span className="tag muted">{outreachDraftKindLabel(draft.kind)}</span>
      <span className="mono">gen {draft.generation}</span>
      <span>{timestamp}</span>
    </div>
  );
}

function OutreachThreadBody({
  thread,
  contactId,
  jobId,
}: {
  thread: OutreachThreadDetail;
  contactId: string;
  jobId?: string;
}): JSX.Element {
  const [revisionTarget, setRevisionTarget] = useState<"approved" | "candidate" | null>(null);
  const [loggingSend, setLoggingSend] = useState(false);
  const approved = approvedDraftOf(thread);
  const candidate = candidateUnderReviewOf(thread);
  const history = historyNewestFirst(thread);
  const canApprove = candidate ? candidate.gateResults.passed : false;
  const revisingApproved = revisionTarget === "approved";
  const revisingCandidate = revisionTarget === "candidate";

  return (
    <>
      {approved ? (
        <div className="outreach-approved-draft">
          <h4>Approved message</h4>
          <DraftMeta draft={approved} timestamp={`approved ${formatDateTime(approved.approvedAt)}`} />
          <DraftBody bodyText={approved.bodyText} />
          <div className="outreach-draft-actions">
            <CopyDraftButton draft={approved} />
            <button
              type="button"
              className="tab"
              aria-expanded={revisingApproved}
              onClick={() =>
                setRevisionTarget((value) => (value === "approved" ? null : "approved"))
              }
            >
              {revisingApproved ? "cancel revision" : "revise approved message"}
            </button>
          </div>
          {revisingApproved ? (
            <ReviseDraftForm
              threadId={thread.threadId}
              contactId={contactId}
              initialBodyText={approved.bodyText}
              onRevised={() => setRevisionTarget(null)}
              {...(jobId ? { jobId } : {})}
            />
          ) : null}
          <details className="outreach-draft-audit">
            <summary>Provenance and gate results</summary>
            <DraftClaimProvenanceList provenance={approved.provenance} />
            <DraftGateResultsPanel gateResults={approved.gateResults} />
          </details>
        </div>
      ) : null}

      <div className="outreach-send-log">
        <h4>Sends</h4>
        <p className="muted">
          JobHunter never sends outreach. After you send an approved message yourself, record it
          here so the thread reflects it.
        </p>
        <OutreachSendLogList thread={thread} />
        {approved ? (
          <div className="outreach-send-log-actions">
            <button
              type="button"
              className="tab"
              aria-expanded={loggingSend}
              onClick={() => setLoggingSend((value) => !value)}
            >
              {loggingSend ? "cancel" : "log a send"}
            </button>
            {loggingSend ? (
              <SendLogForm
                threadId={thread.threadId}
                contactId={contactId}
                draftId={approved.draftId}
                onLogged={() => setLoggingSend(false)}
                {...(jobId ? { jobId } : {})}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <FollowUpPanel
        threadId={thread.threadId}
        contactId={contactId}
        followUp={thread.followUp}
        {...(jobId ? { jobId } : {})}
      />

      {candidate ? (
        <div className="outreach-candidate-draft">
          <h4>Draft under review</h4>
          <DraftMeta draft={candidate} timestamp={`drafted ${formatDateTime(candidate.createdAt)}`} />
          <DraftBody bodyText={candidate.bodyText} />
          <DraftGateResultsPanel gateResults={candidate.gateResults} />
          <DraftClaimProvenanceList provenance={candidate.provenance} />
          {!canApprove ? (
            <p className="muted outreach-approve-note">
              Approval is disabled until the truthfulness gates pass.
            </p>
          ) : null}
          <div className="outreach-draft-actions">
            <ApproveDraftButton
              threadId={thread.threadId}
              contactId={contactId}
              draftId={candidate.draftId}
              disabled={!canApprove}
              {...(jobId ? { jobId } : {})}
            />
            <RejectDraftButton
              threadId={thread.threadId}
              contactId={contactId}
              draftId={candidate.draftId}
              {...(jobId ? { jobId } : {})}
            />
            <button
              type="button"
              className="tab"
              aria-expanded={revisingCandidate}
              onClick={() =>
                setRevisionTarget((value) => (value === "candidate" ? null : "candidate"))
              }
            >
              {revisingCandidate ? "cancel revision" : "revise draft"}
            </button>
          </div>
          {revisingCandidate ? (
            <ReviseDraftForm
              threadId={thread.threadId}
              contactId={contactId}
              initialBodyText={candidate.bodyText}
              onRevised={() => setRevisionTarget(null)}
              {...(jobId ? { jobId } : {})}
            />
          ) : null}
        </div>
      ) : null}

      <div className="outreach-generation-history">
        <h4>Generation history</h4>
        <ul className="outreach-draft-history-list">
          {history.map((draft) => (
            <li key={draft.draftId} className="outreach-draft-history-item">
              <DraftMeta draft={draft} timestamp={formatDateTime(draft.createdAt)} />
              <details className="outreach-draft-audit">
                <summary>View draft, gate results, and provenance</summary>
                <DraftBody bodyText={draft.bodyText} />
                <DraftGateResultsPanel gateResults={draft.gateResults} />
                <DraftClaimProvenanceList provenance={draft.provenance} />
              </details>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// Context-owned composer for the outreach draft review surface. Shows the current
// approved draft prominently (with clipboard copy + revision), the latest candidate under
// review with its gate results + claim provenance + approve/reject/revise actions,
// and the full generation history so a re-draft never hides prior generations
// (INV-5). There is no send action anywhere (INV-1).
export function OutreachThreadPanel({ contactId, jobId }: OutreachThreadPanelProps): JSX.Element {
  const query = useOutreachThreadQuery({ contactId, ...(jobId ? { jobId } : {}) });
  const errorMessage = query.error instanceof Error ? query.error.message : "";
  const thread = query.data?.thread ?? null;

  return (
    <section className="section outreach-thread-panel" aria-label="Outreach">
      <div className="outreach-thread-head">
        <h3>Outreach</h3>
        <GenerateDraftButton contactId={contactId} {...(jobId ? { jobId } : {})} />
      </div>
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {!thread && !errorMessage ? (
        <Empty title="No outreach drafts yet. Generate one to review it before you send." />
      ) : null}
      {thread ? (
        <OutreachThreadBody thread={thread} contactId={contactId} {...(jobId ? { jobId } : {})} />
      ) : null}
    </section>
  );
}
