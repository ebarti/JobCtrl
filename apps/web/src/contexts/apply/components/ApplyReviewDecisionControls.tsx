import { useId } from "react";

import { Button } from "../../../shared/ui/button.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import type { ApplyReviewSession } from "../hooks/useApplyReviewSession.js";

export interface ApplyReviewDecisionControlsProps {
  readonly session: ApplyReviewSession;
}

export function ApplyReviewDecisionControls({
  session,
}: ApplyReviewDecisionControlsProps) {
  const id = useId();
  const payload = session.payload;
  if (!payload) return null;
  return (
    <section className="grid gap-3" aria-label="Exact payload approval">
      <h5>Review and approval</h5>
      {session.rehearsals.length ? (
        <label htmlFor={`${id}-rehearsal`}>
          Completed rehearsal for this payload
          <select
            id={`${id}-rehearsal`}
            value={session.rehearsal?.rehearsalId ?? ""}
            onChange={(event) =>
              session.edit({
                rehearsalId: event.target.value,
                partialOverrideRunId: "",
              })
            }
          >
            {session.rehearsals.map((run) => (
              <option key={run.rehearsalId} value={run.rehearsalId}>
                {run.rehearsalId} · {run.coverage} · {run.finishedAt}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>
          Submission approval requires a completed rehearsal for this exact
          payload.
        </p>
      )}
      {session.rehearsal ? (
        <>
          <p>
            Coverage: <strong>{session.rehearsal.coverage}</strong> · blocked
            requests {session.rehearsal.blockedMutationCount}
          </p>
          <ul>
            {session.rehearsal.checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        </>
      ) : null}
      {payload.mode === "browser" ? (
        session.rehearsal?.inspection ? (
          <section
            className="grid gap-2"
            aria-label="Recorded browser inspection"
          >
            <h6>Browser inspection: {session.rehearsal.inspection.status}</h6>
            <p>{session.rehearsal.inspection.rationale}</p>
            <ul>
              {session.rehearsal.inspection.findings.map((finding, index) => (
                <li key={index}>{finding}</li>
              ))}
            </ul>
            {!["ready", "manual"].includes(
              session.rehearsal.inspection.status,
            ) ? (
              <p role="alert">
                This inspection requires resolution before browser approval.
                Login, CAPTCHA, expiration, failure and uncertainty do not grant
                submission authority.
              </p>
            ) : null}
            {session.rehearsal.inspection.emailCandidate ? (
              <p>
                An email-only destination was found. Load the inspected email
                candidate into preparation, review its exact recipient and text,
                then prepare a new email payload with its own rehearsal and
                approval.
              </p>
            ) : null}
            <details>
              <summary>Browser inspection provenance</summary>
              <p>
                Determination {session.rehearsal.inspection.determinationId}
              </p>
              {session.rehearsal.inspection.citations.map((citation, index) => (
                <blockquote key={index}>
                  <p>{citation.quote}</p>
                  <cite>{citation.source_id}</cite>
                </blockquote>
              ))}
            </details>
          </section>
        ) : (
          <p role="status">
            Browser submission approval requires a recorded, source-verified
            inspection. Rehearsal coverage alone grants no authority.
          </p>
        )
      ) : null}
      {session.rehearsal && session.rehearsal.coverage !== "full" ? (
        <label htmlFor={`${id}-partial`}>
          <input
            id={`${id}-partial`}
            type="checkbox"
            checked={
              session.draft.partialOverrideRunId ===
              session.rehearsal.rehearsalId
            }
            onChange={(event) =>
              session.edit({
                partialOverrideRunId: event.target.checked
                  ? session.rehearsal!.rehearsalId
                  : "",
              })
            }
          />
          I reviewed partial rehearsal {session.rehearsal.rehearsalId}. Dynamic
          or later steps remain unverified, and I accept that specific coverage
          limit.
        </label>
      ) : null}
      <label htmlFor={`${id}-reviewed`}>
        <input
          id={`${id}-reviewed`}
          type="checkbox"
          checked={session.draft.reviewedHash === payload.payloadSha256}
          onChange={(event) =>
            session.edit({
              reviewedHash: event.target.checked ? payload.payloadSha256 : "",
            })
          }
        />
        I reviewed this exact destination, prepared fields, screening answers,
        accepted resume PDF, and outgoing email where present.
      </label>
      <label htmlFor={`${id}-reason`}>
        Review reason or note
        <Textarea
          id={`${id}-reason`}
          value={session.draft.reason}
          maxLength={4000}
          onChange={(event) => session.edit({ reason: event.target.value })}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={session.approveRehearsalDisabled}
          onClick={() => session.decide("approve_dry_run")}
        >
          Approve rehearsal only
        </Button>
        <Button
          disabled={session.approveDisabled}
          onClick={() => session.decide("approve_submit")}
        >
          Approve exact application payload
        </Button>
        <Button
          variant="outline"
          disabled={session.blocked || session.externallyBound}
          onClick={() => session.decide("defer")}
        >
          Defer
        </Button>
        <Button
          variant="outline"
          disabled={session.blocked || session.externallyBound}
          onClick={() => session.decide("decline")}
        >
          Decline
        </Button>
        <Button
          variant="outline"
          disabled={session.blocked || session.externallyBound}
          onClick={() => session.decide("reset")}
        >
          Revoke approval
        </Button>
      </div>
      <p>
        Rehearsal approval binds this saved version and exact payload without
        permitting submission. Submission approval additionally records the
        exact qualifying rehearsal. A later source or payload change must be
        reviewed again.
      </p>
    </section>
  );
}
