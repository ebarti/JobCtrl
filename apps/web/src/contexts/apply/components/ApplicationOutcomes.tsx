import {
  APPLICATION_OUTCOME_KINDS,
  ManualApplicationOutcomeRequestSchema,
  OutcomeSuggestionDecisionRequestSchema,
  type ApplicationOutcome,
  type ApplicationOutcomeKind,
  type ManualApplicationOutcomeRequest,
  type OutcomeSuggestion,
  type OutcomeSuggestionDecisionRequest,
} from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";

import { useJobApplicationOutcomesQuery } from "../../operations/hooks/useJobApplicationOutcomesQuery.js";
import type { JobId } from "../../operations/types.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  useOutcomeSuggestionDecisionMutation,
  useRecordManualApplicationOutcomeMutation,
} from "../hooks/useApplyReviewMutations.js";

interface ManualOutcomeFormValues {
  readonly kind: ApplicationOutcomeKind;
  readonly occurredAt: string;
  readonly note: string;
}

interface SuggestionCorrectionFormValues {
  readonly outcomeKind: ApplicationOutcomeKind;
  readonly occurredAt: string;
  readonly note: string;
  readonly reason: string;
}

const OUTCOME_LABELS: Record<ApplicationOutcomeKind, string> = {
  applied_confirmation: "Applied confirmation",
  recruiter_reply: "Recruiter reply",
  interview: "Interview",
  assessment: "Assessment",
  rejection: "Rejection",
  offer: "Offer",
  withdrawn: "Withdrawn",
  bounced: "Bounced",
  no_response: "No response",
  unknown: "Unknown",
};

function isoTimestampFromLocalInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
}

function manualOutcomePayload(values: ManualOutcomeFormValues): ManualApplicationOutcomeRequest {
  return {
    kind: values.kind,
    occurredAt: isoTimestampFromLocalInput(values.occurredAt),
    note: values.note.trim() || undefined,
  };
}

function suggestionPayload(
  values: SuggestionCorrectionFormValues,
): OutcomeSuggestionDecisionRequest {
  return {
    decision: "correct",
    outcomeKind: values.outcomeKind,
    occurredAt: isoTimestampFromLocalInput(values.occurredAt),
    note: values.note.trim() || undefined,
    reason: values.reason.trim() || undefined,
  };
}

function sortOutcomes(outcomes: readonly ApplicationOutcome[]): ApplicationOutcome[] {
  return [...outcomes].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function outcomeLabel(kind: ApplicationOutcomeKind): string {
  return OUTCOME_LABELS[kind] ?? kind;
}

export interface JobOutcomePanelProps {
  readonly jobId: JobId;
}

export function JobOutcomePanel({ jobId }: JobOutcomePanelProps) {
  const { data, error, isFetching } = useJobApplicationOutcomesQuery(jobId);
  const message = error instanceof Error ? error.message : null;
  const pendingSuggestions = (data?.suggestions ?? []).filter(
    (suggestion) => suggestion.status === "pending",
  );

  return (
    <div className="outcome-panel">
      {message ? <div className="banner inline">{message}</div> : null}
      {!data && !message ? <Empty title={isFetching ? "Loading outcomes." : "No outcomes."} /> : null}
      {data ? (
        <>
          <ManualOutcomeForm jobId={jobId} />
          <OutcomeTimeline outcomes={data.outcomes} />
          <OutcomeSuggestionsPanel suggestions={pendingSuggestions} />
        </>
      ) : null}
    </div>
  );
}

export interface ManualOutcomeFormProps {
  readonly jobId: JobId;
}

export function ManualOutcomeForm({ jobId }: ManualOutcomeFormProps) {
  const recordOutcome = useRecordManualApplicationOutcomeMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const form = useForm({
    defaultValues: {
      kind: "applied_confirmation" as ApplicationOutcomeKind,
      occurredAt: "",
      note: "",
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = ManualApplicationOutcomeRequestSchema.safeParse(
          manualOutcomePayload(value),
        );
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid outcome");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const result = ManualApplicationOutcomeRequestSchema.safeParse(
        manualOutcomePayload(value),
      );
      if (!result.success) {
        setStatusMessage(result.error.issues[0]?.message ?? "Invalid outcome");
        return;
      }
      await recordOutcome.mutateAsync({ jobId, body: result.data });
      formApi.reset({
        kind: "applied_confirmation",
        occurredAt: "",
        note: "",
      });
      setStatusMessage("Outcome recorded");
    },
  });

  return (
    <form
      className="outcome-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="kind">
        {(field) => (
          <label className="field">
            <span>Outcome</span>
            <select
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value as ApplicationOutcomeKind)}
            >
              {APPLICATION_OUTCOME_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {outcomeLabel(kind)}
                </option>
              ))}
            </select>
          </label>
        )}
      </form.Field>
      <form.Field name="occurredAt">
        {(field) => (
          <label className="field">
            <span>Occurred at</span>
            <input
              type="datetime-local"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="note">
        {(field) => (
          <label className="field wide">
            <span>Local note</span>
            <textarea
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      {recordOutcome.isError ? <div className="danger">Outcome save failed</div> : null}
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}>
        {({ canSubmit, isSubmitting }) => (
          <Button
            className="outcome-submit"
            type="submit"
            size="sm"
            disabled={!canSubmit || isSubmitting || recordOutcome.isPending}
          >
            {isSubmitting || recordOutcome.isPending ? "Recording" : "Record outcome"}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

export interface OutcomeTimelineProps {
  readonly outcomes: readonly ApplicationOutcome[];
}

export function OutcomeTimeline({ outcomes }: OutcomeTimelineProps) {
  const sorted = sortOutcomes(outcomes);
  if (!sorted.length) {
    return <Empty title="No reviewed outcomes yet." />;
  }
  return (
    <ol className="outcome-timeline" aria-label="Application outcome timeline">
      {sorted.map((outcome) => (
        <li className="timeline-row" key={outcome.outcomeId}>
          <span className="timeline-row-head">
            <span className={`status-dot ${outcome.kind}`} aria-hidden="true" />
            <b>{outcomeLabel(outcome.kind)}</b>
          </span>
          <time dateTime={outcome.occurredAt}>{formatDateTime(outcome.occurredAt)}</time>
          <span className="meta">{outcome.source === "email_suggestion" ? "email suggestion" : "manual"}</span>
          {outcome.note ? <p className="outcome-note">{outcome.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export interface OutcomeSuggestionsPanelProps {
  readonly suggestions: readonly OutcomeSuggestion[];
}

export function OutcomeSuggestionsPanel({ suggestions }: OutcomeSuggestionsPanelProps) {
  if (!suggestions.length) {
    return <Empty title="No pending outcome suggestions." />;
  }
  return (
    <div className="outcome-suggestions" aria-label="Pending outcome suggestions">
      {suggestions.map((suggestion) => (
        <OutcomeSuggestionCard key={suggestion.suggestionId} suggestion={suggestion} />
      ))}
    </div>
  );
}

function OutcomeSuggestionCard({ suggestion }: { readonly suggestion: OutcomeSuggestion }) {
  const decideSuggestion = useOutcomeSuggestionDecisionMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const suggestionTitleId = `outcome-suggestion-${suggestion.suggestionId}-title`;
  const suggestionContext = `suggestion ${suggestion.suggestionId} (${outcomeLabel(
    suggestion.suggestedKind,
  )}) for ${suggestion.jobKey}`;
  const form = useForm({
    defaultValues: {
      outcomeKind: suggestion.suggestedKind,
      occurredAt: "",
      note: "",
      reason: "",
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = OutcomeSuggestionDecisionRequestSchema.safeParse(
          suggestionPayload(value),
        );
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid correction");
      },
    },
    onSubmit: async ({ value }) => {
      setStatusMessage("");
      const result = OutcomeSuggestionDecisionRequestSchema.safeParse(
        suggestionPayload(value),
      );
      if (!result.success) {
        setStatusMessage(result.error.issues[0]?.message ?? "Invalid correction");
        return;
      }
      await decideSuggestion.mutateAsync({
        suggestionId: suggestion.suggestionId,
        jobId: suggestion.jobKey,
        body: result.data,
      });
      setStatusMessage("Suggestion corrected");
    },
  });

  const decide = (body: OutcomeSuggestionDecisionRequest) => {
    setStatusMessage("");
    decideSuggestion.mutate(
      {
        suggestionId: suggestion.suggestionId,
        jobId: suggestion.jobKey,
        body,
      },
      {
        onSuccess: () => {
          setStatusMessage(body.decision === "ignore" ? "Suggestion ignored" : "Suggestion accepted");
        },
      },
    );
  };

  return (
    <article className="outcome-suggestion-card" aria-labelledby={suggestionTitleId}>
      <header className="outcome-suggestion-head">
        <span>
          <b id={suggestionTitleId}>{outcomeLabel(suggestion.suggestedKind)} suggestion</b>
          <span className="meta">
            {Math.round(suggestion.confidence * 100)}% confidence · {formatDateTime(suggestion.createdAt)}
          </span>
          <span className="meta">{suggestion.jobKey}</span>
        </span>
        <span className="tag info">pending</span>
      </header>
      <p>{suggestion.rationale}</p>
      <div className="row-actions">
        <Button
          type="button"
          size="sm"
          disabled={decideSuggestion.isPending}
          aria-label={`Accept ${suggestionContext}`}
          onClick={() => decide({ decision: "accept", reason: "Accepted from review UI." })}
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={decideSuggestion.isPending}
          aria-label={`Ignore ${suggestionContext}`}
          onClick={() => decide({ decision: "ignore", reason: "Ignored from review UI." })}
        >
          Ignore
        </Button>
      </div>
      <form
        className="outcome-correction-form"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <fieldset className="outcome-correction-fieldset">
          <legend>Correct {suggestionContext}</legend>
          <form.Field name="outcomeKind">
            {(field) => (
              <label className="field">
                <span>Correct to</span>
                <select
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value as ApplicationOutcomeKind)}
                >
                  {APPLICATION_OUTCOME_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {outcomeLabel(kind)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>
          <form.Field name="occurredAt">
            {(field) => (
              <label className="field">
                <span>Occurred at</span>
                <input
                  type="datetime-local"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="reason">
            {(field) => (
              <label className="field">
                <span>Reason</span>
                <input
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="note">
            {(field) => (
              <label className="field wide">
                <span>Local note</span>
                <textarea
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </label>
            )}
          </form.Field>
          {decideSuggestion.isError ? <div className="danger">Suggestion decision failed</div> : null}
          {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
          <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}>
            {({ canSubmit, isSubmitting }) => (
              <Button
                className="outcome-submit"
                type="submit"
                size="sm"
                variant="secondary"
                disabled={!canSubmit || isSubmitting || decideSuggestion.isPending}
                aria-label={`Correct ${suggestionContext}`}
              >
                {isSubmitting || decideSuggestion.isPending ? "Saving" : "Correct"}
              </Button>
            )}
          </form.Subscribe>
        </fieldset>
      </form>
    </article>
  );
}
