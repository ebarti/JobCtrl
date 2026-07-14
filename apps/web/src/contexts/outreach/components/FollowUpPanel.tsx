import type { OutreachFollowUp } from "@jobctrl/contracts";
import { useState, type JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { StatusLabel } from "../../../shared/ui/status-label.js";
import { useCompleteFollowUpMutation } from "../hooks/useCompleteFollowUpMutation.js";
import { useDismissFollowUpMutation } from "../hooks/useDismissFollowUpMutation.js";
import { useScheduleFollowUpMutation } from "../hooks/useScheduleFollowUpMutation.js";

export interface FollowUpPanelProps {
  threadId: string;
  contactId: string;
  followUp: OutreachFollowUp | null;
  jobId?: string;
}

// Context-owned surface for a thread's follow-up reminder. A follow-up is a plan,
// never an action: JobCtrl surfaces the reminder date but never sends anything
// and never acts on it (INV-1). With no custom date, scheduling asks the API to
// derive the default from the canonical application lifecycle; entering a date is
// the explicit user-edited override.
export function FollowUpPanel({
  threadId,
  contactId,
  followUp,
  jobId,
}: FollowUpPanelProps): JSX.Element {
  const schedule = useScheduleFollowUpMutation(threadId, contactId, jobId);
  const complete = useCompleteFollowUpMutation(threadId, contactId, jobId);
  const dismiss = useDismissFollowUpMutation(threadId, contactId, jobId);
  const [dueAt, setDueAt] = useState(followUp?.dueAt?.slice(0, 10) ?? "");

  const isScheduled = followUp?.state === "scheduled";
  const error =
    [schedule.error, complete.error, dismiss.error].find(
      (candidate): candidate is Error => candidate instanceof Error,
    )?.message ?? "";

  return (
    <div className="outreach-follow-up" aria-label="Follow-up">
      <h4>Follow-up</h4>
      <p className="muted">
        A follow-up is a reminder surfaced for you. JobCtrl never sends it or
        acts on it.
      </p>
      {error ? <div className="banner inline">{error}</div> : null}
      {isScheduled && followUp ? (
        <div className="outreach-follow-up-scheduled">
          <p>
            <StatusLabel tone="info">scheduled</StatusLabel> due{" "}
            {formatDateTime(followUp.dueAt)}
            {followUp.basis ? (
              <span className="muted"> · {followUp.basis}</span>
            ) : null}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="tab on"
              disabled={complete.isPending}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? "updating…" : "mark done"}
            </button>
            <button
              type="button"
              className="tab"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate()}
            >
              {dismiss.isPending ? "updating…" : "dismiss"}
            </button>
          </div>
        </div>
      ) : (
        <div className="outreach-follow-up-schedule">
          {followUp && followUp.state !== "none" ? (
            <p className="muted">
              Last follow-up {followUp.state}. Schedule a new reminder:
            </p>
          ) : null}
          <label className="field compact">
            <span>Remind me on</span>
            <input
              type="date"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="tab on"
              disabled={schedule.isPending}
              onClick={() => {
                const customDueAt = dueAt.trim();
                schedule.mutate(customDueAt ? { dueAt: customDueAt } : {});
              }}
            >
              {schedule.isPending ? "scheduling…" : "schedule follow-up"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
