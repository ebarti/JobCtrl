import type { OutreachDraftKind } from "@jobctrl/contracts";
import type { OutreachDraftDto, OutreachThreadDetail } from "@jobctrl/contracts";
import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useRef, useState, type JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { ReviseDraftForm } from "../forms/revise-draft-form.js";
import { SendLogForm } from "../forms/send-log-form.js";
import { useOutreachThreadQuery } from "../hooks/useOutreachThreadQuery.js";
import type { ThreadDetail, ThreadDraft } from "../contracts.js";
import { outreachDraftKindLabel } from "../lib/draft-copy.js";
import { outreachKeys } from "../queryKeys.js";
import { ApproveDraftButton } from "./ApproveDraftButton.js";
import { CopyDraftButton } from "./CopyDraftButton.js";
import { DraftClaimProvenanceList } from "./DraftClaimProvenanceList.js";
import { DraftGateResultsPanel } from "./DraftGateResultsPanel.js";
import { DraftStatusBadge } from "./DraftStatusBadge.js";
import { FollowUpPanel } from "./FollowUpPanel.js";
import { GenerateDraftButton } from "./GenerateDraftButton.js";
import { OutreachSendLogList } from "./OutreachSendLogList.js";
import { OutreachDeterminations } from "./OutreachDeterminations.js";
import { RetainedOutreachSessions } from "./RetainedOutreachSessions.js";
import { RejectDraftButton } from "./RejectDraftButton.js";

export interface OutreachThreadPanelProps {
  contactId: string;
  jobId?: string;
  draftKind?: OutreachDraftKind;
  offerRevisionId?: string;
}

type Revision = { threadId: string; draftId: string; target: "approved" | "candidate"; bodyText: string; fingerprint: string; kind: OutreachDraftKind };

type DraftDecision = "approve" | "reject";

function approvedDraftOf(thread: ThreadDetail): ThreadDraft | undefined {
  return thread.drafts.find((draft) => draft.status === "approved");
}

function candidateUnderReviewOf(thread: ThreadDetail): ThreadDraft | undefined {
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
  revision,
  onRevisionChange,
}: {
  revision: Revision | null;
  onRevisionChange: (revision: Revision | null) => void;
  thread: ThreadDetail;
  contactId: string;
  jobId?: string;
}): JSX.Element {
  const revisionTarget = revision?.target ?? null;
  const [loggingSend, setLoggingSend] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<DraftDecision | null>(null);
  const decisionLock = useRef<DraftDecision | null>(null);
  const decisionMutationObserved = useRef(false);
  const tenantId = useTenantId();
  const activeThreadMutations = useIsMutating({
    mutationKey: outreachKeys.thread(tenantId, thread.threadId),
  });
  const approved = approvedDraftOf(thread);
  const candidate = candidateUnderReviewOf(thread);
  const history = historyNewestFirst(thread);
  const canApprove = candidate ? candidate.gateResults.passed && candidate.sourcesCurrent === true && candidate.reviewAuthorityVerified === true : false;
  const revisingApproved = revisionTarget === "approved";
  const revisingCandidate = revisionTarget === "candidate";
  const threadActionPending = pendingDecision !== null || activeThreadMutations > 0;
  const decisionControlsDisabled = threadActionPending || revisionTarget !== null;

  useEffect(() => {
    if (pendingDecision === null) {
      return;
    }
    if (activeThreadMutations > 0) {
      decisionMutationObserved.current = true;
      return;
    }
    if (!decisionMutationObserved.current) {
      return;
    }
    decisionLock.current = null;
    decisionMutationObserved.current = false;
    setPendingDecision(null);
  }, [activeThreadMutations, pendingDecision]);

  function beginDecision(decision: DraftDecision): boolean {
    if (decisionLock.current !== null || activeThreadMutations > 0 || revisionTarget !== null) {
      return false;
    }
    decisionLock.current = decision;
    decisionMutationObserved.current = false;
    setPendingDecision(decision);
    return true;
  }

  function settleDecision(decision: DraftDecision): void {
    if (decisionLock.current !== decision) {
      return;
    }
    decisionLock.current = null;
    decisionMutationObserved.current = false;
    setPendingDecision(null);
  }

  function revisionToggleDisabled(target: "approved" | "candidate"): boolean {
    return (
      decisionLock.current !== null ||
      threadActionPending ||
      (revisionTarget !== null && revisionTarget !== target)
    );
  }

  return (
    <>
      {approved ? (
        <div className="outreach-approved-draft">
          <h4>Approved message</h4>
          {approved.sourcesCurrent !== true ? <p role="status">The message sources changed or are unavailable. This approved message remains in history; verify a new draft before copying.</p> : null}
          {approved.reviewAuthorityVerified !== true ? <p role="status">The recorded review authority is unavailable or cannot be verified{approved.reviewAuthorityFailure ? `: ${approved.reviewAuthorityFailure}` : "."} This message remains in history.</p> : null}
          <DraftMeta draft={approved} timestamp={`approved ${formatDateTime(approved.approvedAt)}`} />
          <DraftBody bodyText={approved.bodyText} />
          <div className="outreach-draft-actions">
            <CopyDraftButton draft={approved} threadId={thread.threadId} expectedFingerprint={thread.fingerprint} sourcesCurrent={approved.sourcesCurrent === true} reviewAuthorityVerified={approved.reviewAuthorityVerified === true} />
            <Button
              type="button"
              variant="outline"
              aria-expanded={revisingApproved}
              disabled={revisionToggleDisabled("approved")}
              onClick={() => {
                if (revisionToggleDisabled("approved")) return;
                onRevisionChange(revisingApproved ? null : { threadId: thread.threadId, draftId: approved.draftId, target: "approved", bodyText: approved.bodyText, fingerprint: thread.fingerprint, kind: approved.kind });
              }}
            >
              {revisingApproved ? "Cancel revision" : "Revise approved message"}
            </Button>
          </div>

          <details className="outreach-draft-audit">
            <summary>Provenance and gate results</summary>
            <DraftClaimProvenanceList provenance={approved.provenance} />
            <DraftGateResultsPanel gateResults={approved.gateResults} />
            <OutreachDeterminations threadId={thread.threadId} draftId={approved.draftId} expectedIds={approved.gateResults.determinationIds} />
          </details>
        </div>
      ) : null}

      <div className="outreach-send-log">
        <h4>Sends</h4>
        <p className="muted">
          JobCtrl never sends outreach. After you send an approved message yourself, record it
          here so the thread reflects it.
        </p>
        <OutreachSendLogList thread={thread} />
        {(approved?.sourcesCurrent === true && approved.reviewAuthorityVerified === true) || loggingSend ? (
          <div className="outreach-send-log-actions">
            <Button
              type="button"
              variant="outline"
              aria-expanded={Boolean(loggingSend)}
              onClick={() => setLoggingSend((value) => value ? null : approved?.draftId ?? null)}
            >
              {loggingSend ? "Cancel" : "Log a send"}
            </Button>
            {loggingSend ? (
              <SendLogForm
                threadId={thread.threadId}
                contactId={contactId}
                draftId={loggingSend}
                onLogged={() => setLoggingSend(null)}
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
        expectedFingerprint={thread.fingerprint}
        {...(jobId ? { jobId } : {})}
      />

      {candidate ? (
        <div className="outreach-candidate-draft">
          <h4>Draft under review</h4>
          <DraftMeta draft={candidate} timestamp={`drafted ${formatDateTime(candidate.createdAt)}`} />
          <DraftBody bodyText={candidate.bodyText} />
          <DraftGateResultsPanel gateResults={candidate.gateResults} />
          <DraftClaimProvenanceList provenance={candidate.provenance} />
          <OutreachDeterminations threadId={thread.threadId} draftId={candidate.draftId} expectedIds={candidate.gateResults.determinationIds} />
          {!canApprove ? (
            <p className="muted outreach-approve-note">
              Approval requires current sources, verified review authority, and passing claim and quality reviews.
            </p>
          ) : null}
          {candidate.reviewAuthorityVerified !== true && candidate.reviewAuthorityFailure ? <p role="status">Review authority: {candidate.reviewAuthorityFailure}</p> : null}
          <div className="outreach-draft-actions">
            <ApproveDraftButton
              threadId={thread.threadId}
              contactId={contactId}
              draftId={candidate.draftId}
              expectedFingerprint={thread.fingerprint}
              disabled={!canApprove || decisionControlsDisabled}
              onActionStart={() => beginDecision("approve")}
              onActionSettled={() => settleDecision("approve")}
              {...(jobId ? { jobId } : {})}
            />
            <RejectDraftButton
              threadId={thread.threadId}
              contactId={contactId}
              draftId={candidate.draftId}
              expectedFingerprint={thread.fingerprint}
              disabled={decisionControlsDisabled}
              onActionStart={() => beginDecision("reject")}
              onActionSettled={() => settleDecision("reject")}
              {...(jobId ? { jobId } : {})}
            />
            <Button
              type="button"
              variant="outline"
              aria-expanded={revisingCandidate}
              disabled={revisionToggleDisabled("candidate")}
              onClick={() => {
                if (revisionToggleDisabled("candidate")) return;
                onRevisionChange(revisingCandidate ? null : { threadId: thread.threadId, draftId: candidate.draftId, target: "candidate", bodyText: candidate.bodyText, fingerprint: thread.fingerprint, kind: candidate.kind });
              }}
            >
              {revisingCandidate ? "Cancel revision" : "Revise draft"}
            </Button>
          </div>

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
                <OutreachDeterminations threadId={thread.threadId} draftId={draft.draftId} expectedIds={draft.gateResults.determinationIds} />
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
export function OutreachThreadPanel(props: OutreachThreadPanelProps): JSX.Element {
  const tenantId = useTenantId();
  return (
    <RetainedOutreachSessions key={tenantId} targetKey={JSON.stringify([props.contactId, props.jobId ?? null])}>
      <OutreachThreadPanelSession {...props} />
    </RetainedOutreachSessions>
  );
}

function OutreachThreadPanelSession({ contactId, jobId, draftKind, offerRevisionId }: OutreachThreadPanelProps): JSX.Element {
  const [revision, setRevision] = useState<Revision | null>(null);
  const query = useOutreachThreadQuery({ contactId, ...(jobId ? { jobId } : {}) });
  const errorMessage = query.error instanceof Error ? query.error.message : "";
  const thread = query.data?.thread ?? null;

  return (
    <section className="section outreach-thread-panel" aria-label="Outreach">
      <div className="outreach-thread-head">
        <h3>Outreach</h3>
        <GenerateDraftButton contactId={contactId} threadReady={Boolean(query.data) && !query.isFetching && !query.error} {...(query.data ? { expectedFingerprint: thread?.fingerprint ?? null } : {})} {...(jobId ? { jobId } : {})} {...(draftKind ? { kind: draftKind } : {})} {...(offerRevisionId ? { offerRevisionId, label: "Generate offer draft" } : {})} />
      </div>
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {!thread && !errorMessage ? (
        <Empty title={query.isPending ? "Loading outreach thread." : "No outreach drafts yet. Generate one to review it before you send."} />
      ) : null}
      {revision ? (
        <div className="outreach-retained-revision">
          <h4>Your message revision</h4>
          <ReviseDraftForm
            threadId={revision.threadId}
            contactId={contactId}
            initialBodyText={revision.bodyText}
            initialFingerprint={revision.fingerprint}
            initialKind={revision.kind}
            sourceDraftId={revision.draftId}
            {...(thread?.threadId === revision.threadId ? { currentFingerprint: thread.fingerprint } : {})}
            onRevised={() => setRevision(null)}
            onDiscard={() => setRevision(null)}
            {...(jobId ? { jobId } : {})}
          />
        </div>
      ) : null}
      {thread ? (
        <OutreachThreadBody key={thread.threadId} revision={revision} onRevisionChange={setRevision} thread={thread} contactId={contactId} {...(jobId ? { jobId } : {})} />
      ) : null}
    </section>
  );
}
