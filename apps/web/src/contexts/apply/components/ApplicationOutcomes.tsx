import {
  APPLICATION_OUTCOME_KINDS,
  ManualApplicationOutcomeRequestSchema,
  OutcomeSuggestionDecisionRequestSchema,
  type ApplicationOutcome,
  type ApplicationOutcomeKind,
  type ManualApplicationOutcomeRequest,
  type OutcomeSuggestion,
  type OutcomeSuggestionDecisionRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";

import { useJobApplicationOutcomesQuery } from "../../operations/hooks/useJobApplicationOutcomesQuery.js";
import type { JobId } from "../../operations/types.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { StatusDot } from "../../../shared/ui/status-dot.js";
import type { StatusDotState } from "../../../shared/ui/status-tokens.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  useOutcomeSuggestionDecisionMutation,
  useRecordManualApplicationOutcomeMutation,
} from "../hooks/useApplyReviewMutations.js";

interface ManualOutcomeFormValues {
  readonly kind: ApplicationOutcomeKind;
  readonly occurredAt: string;
  readonly note: string;
}

interface InterviewReflectionFormValues {
  readonly occurredAt: string;
  readonly note: string;
}

interface SuggestionCorrectionFormValues {
  readonly outcomeKind: ApplicationOutcomeKind;
  readonly occurredAt: string;
  readonly note: string;
  readonly reason: string;
}

interface FeedbackMessage {
  readonly message: string;
  readonly role: "alert" | "status";
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

function manualOutcomePayload(
  values: ManualOutcomeFormValues,
): ManualApplicationOutcomeRequest {
  return {
    kind: values.kind,
    occurredAt: isoTimestampFromLocalInput(values.occurredAt),
    note: values.note.trim() || undefined,
  };
}

function interviewReflectionPayload(
  values: InterviewReflectionFormValues,
  prepGeneration: number,
): ManualApplicationOutcomeRequest {
  return {
    kind: "interview",
    occurredAt: isoTimestampFromLocalInput(values.occurredAt),
    note: values.note.trim() || undefined,
    interviewPrepGeneration: prepGeneration,
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

function sortOutcomes(
  outcomes: readonly ApplicationOutcome[],
): ApplicationOutcome[] {
  return [...outcomes].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function outcomeLabel(kind: ApplicationOutcomeKind): string {
  return OUTCOME_LABELS[kind] ?? kind;
}

function outcomeDotState(kind: ApplicationOutcomeKind): StatusDotState {
  switch (kind) {
    case "applied_confirmation":
    case "recruiter_reply":
    case "interview":
    case "assessment":
    case "offer":
      return "succeeded";
    case "rejection":
    case "bounced":
      return "failed";
    case "withdrawn":
      return "canceled";
    case "no_response":
    case "unknown":
      return "pending";
  }
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
      {!data && !message ? (
        <Empty title={isFetching ? "Loading outcomes." : "No outcomes."} />
      ) : null}
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
  const [statusMessage, setStatusMessage] = useState<FeedbackMessage | null>(
    null,
  );
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
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid outcome");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage(null);
      const result = ManualApplicationOutcomeRequestSchema.safeParse(
        manualOutcomePayload(value),
      );
      if (!result.success) {
        setStatusMessage({
          message: result.error.issues[0]?.message ?? "Invalid outcome",
          role: "alert",
        });
        return;
      }
      try {
        await recordOutcome.mutateAsync({ jobId, body: result.data });
      } catch {
        return;
      }
      formApi.reset({
        kind: "applied_confirmation",
        occurredAt: "",
        note: "",
      });
      setStatusMessage({ message: "Outcome recorded", role: "status" });
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
          <Field className="field">
            <FieldLabel htmlFor="manual-outcome-kind">Outcome</FieldLabel>
            <Select
              items={APPLICATION_OUTCOME_KINDS.map((kind) => ({
                label: outcomeLabel(kind),
                value: kind,
              }))}
              value={field.state.value}
              onValueChange={(value) => {
                if (value !== null)
                  field.handleChange(value as ApplicationOutcomeKind);
              }}
            >
              <SelectTrigger
                id="manual-outcome-kind"
                aria-label="Outcome"
                className="w-full"
                onBlur={field.handleBlur}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {APPLICATION_OUTCOME_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {outcomeLabel(kind)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="occurredAt">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor="manual-outcome-occurred-at">
              Occurred at
            </FieldLabel>
            <Input
              id="manual-outcome-occurred-at"
              type="datetime-local"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="note">
        {(field) => (
          <Field className="field wide">
            <FieldLabel htmlFor="manual-outcome-note">Local note</FieldLabel>
            <Textarea
              id="manual-outcome-note"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      {recordOutcome.isError ? (
        <div aria-live="assertive" className="danger" role="alert">
          Outcome save failed
        </div>
      ) : null}
      {statusMessage ? (
        <div
          aria-live={statusMessage.role === "alert" ? "assertive" : "polite"}
          className="status-line"
          role={statusMessage.role}
        >
          {statusMessage.message}
        </div>
      ) : null}
      <form.Subscribe
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            className="outcome-submit"
            type="submit"
            size="sm"
            disabled={!canSubmit || isSubmitting || recordOutcome.isPending}
          >
            {isSubmitting || recordOutcome.isPending
              ? "Recording"
              : "Record outcome"}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

export interface InterviewReflectionPanelProps {
  readonly jobId: JobId;
  readonly prepGeneration: number;
}

export function InterviewReflectionPanel({
  jobId,
  prepGeneration,
}: InterviewReflectionPanelProps) {
  const { data, error, isFetching } = useJobApplicationOutcomesQuery(jobId);
  const message = error instanceof Error ? error.message : null;
  const reflections = (data?.outcomes ?? []).filter(
    (outcome) =>
      outcome.kind === "interview" &&
      outcome.interviewPrepGeneration === prepGeneration,
  );

  return (
    <div
      className="interview-reflection-panel"
      aria-label="Post-interview reflections"
    >
      <InterviewReflectionForm jobId={jobId} prepGeneration={prepGeneration} />
      {message ? <div className="banner inline">{message}</div> : null}
      {!data && !message ? (
        <Empty
          title={isFetching ? "Loading reflections." : "No reflections."}
        />
      ) : null}
      {data ? <OutcomeTimeline outcomes={reflections} /> : null}
    </div>
  );
}

export interface InterviewReflectionFormProps {
  readonly jobId: JobId;
  readonly prepGeneration: number;
}

export function InterviewReflectionForm({
  jobId,
  prepGeneration,
}: InterviewReflectionFormProps) {
  const recordOutcome = useRecordManualApplicationOutcomeMutation();
  const [statusMessage, setStatusMessage] = useState<FeedbackMessage | null>(
    null,
  );
  const form = useForm({
    defaultValues: {
      occurredAt: "",
      note: "",
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = ManualApplicationOutcomeRequestSchema.safeParse(
          interviewReflectionPayload(value, prepGeneration),
        );
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid reflection");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage(null);
      const result = ManualApplicationOutcomeRequestSchema.safeParse(
        interviewReflectionPayload(value, prepGeneration),
      );
      if (!result.success) {
        setStatusMessage({
          message: result.error.issues[0]?.message ?? "Invalid reflection",
          role: "alert",
        });
        return;
      }
      try {
        await recordOutcome.mutateAsync({ jobId, body: result.data });
      } catch {
        return;
      }
      formApi.reset({
        occurredAt: "",
        note: "",
      });
      setStatusMessage({ message: "Reflection recorded", role: "status" });
    },
  });

  return (
    <form
      className="outcome-form interview-reflection-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {/* Native hidden controls preserve the named reflection metadata. */}
      <input name="kind" readOnly type="hidden" value="interview" />
      <input
        name="interviewPrepGeneration"
        readOnly
        type="hidden"
        value={prepGeneration}
      />
      <form.Field name="occurredAt">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor="interview-reflection-occurred-at">
              Interview date
            </FieldLabel>
            <Input
              id="interview-reflection-occurred-at"
              name="occurredAt"
              type="datetime-local"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="note">
        {(field) => (
          <Field className="field wide">
            <FieldLabel htmlFor="interview-reflection-note">
              Reflection note
            </FieldLabel>
            <Textarea
              id="interview-reflection-note"
              name="note"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      {recordOutcome.isError ? (
        <div aria-live="assertive" className="danger" role="alert">
          Reflection save failed
        </div>
      ) : null}
      {statusMessage ? (
        <div
          aria-live={statusMessage.role === "alert" ? "assertive" : "polite"}
          className="status-line"
          role={statusMessage.role}
        >
          {statusMessage.message}
        </div>
      ) : null}
      <form.Subscribe
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            className="outcome-submit"
            type="submit"
            size="sm"
            disabled={!canSubmit || isSubmitting || recordOutcome.isPending}
          >
            {isSubmitting || recordOutcome.isPending
              ? "Recording"
              : "Record reflection"}
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
            <StatusDot state={outcomeDotState(outcome.kind)} />
            <b>{outcomeLabel(outcome.kind)}</b>
          </span>
          <time dateTime={outcome.occurredAt}>
            {formatDateTime(outcome.occurredAt)}
          </time>
          <span className="meta">
            {outcome.source === "email_suggestion"
              ? "email suggestion"
              : "manual"}
          </span>
          {outcome.interviewPrepGeneration !== null ? (
            <span className="meta">
              prep generation {outcome.interviewPrepGeneration}
            </span>
          ) : null}
          {outcome.note ? <p className="outcome-note">{outcome.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export interface OutcomeSuggestionsPanelProps {
  readonly suggestions: readonly OutcomeSuggestion[];
}

export function OutcomeSuggestionsPanel({
  suggestions,
}: OutcomeSuggestionsPanelProps) {
  if (!suggestions.length) {
    return <Empty title="No pending outcome suggestions." />;
  }
  return (
    <div
      className="outcome-suggestions"
      aria-label="Pending outcome suggestions"
    >
      {suggestions.map((suggestion) => (
        <OutcomeSuggestionCard
          key={suggestion.suggestionId}
          suggestion={suggestion}
        />
      ))}
    </div>
  );
}

function OutcomeSuggestionCard({
  suggestion,
}: {
  readonly suggestion: OutcomeSuggestion;
}) {
  const decideSuggestion = useOutcomeSuggestionDecisionMutation();
  const [statusMessage, setStatusMessage] = useState<FeedbackMessage | null>(
    null,
  );
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
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid correction");
      },
    },
    onSubmit: async ({ value }) => {
      setStatusMessage(null);
      const result = OutcomeSuggestionDecisionRequestSchema.safeParse(
        suggestionPayload(value),
      );
      if (!result.success) {
        setStatusMessage({
          message: result.error.issues[0]?.message ?? "Invalid correction",
          role: "alert",
        });
        return;
      }
      try {
        await decideSuggestion.mutateAsync({
          suggestionId: suggestion.suggestionId,
          jobId: suggestion.jobKey,
          body: result.data,
        });
      } catch {
        return;
      }
      setStatusMessage({ message: "Suggestion corrected", role: "status" });
    },
  });

  const decide = (body: OutcomeSuggestionDecisionRequest) => {
    setStatusMessage(null);
    decideSuggestion.mutate(
      {
        suggestionId: suggestion.suggestionId,
        jobId: suggestion.jobKey,
        body,
      },
      {
        onSuccess: () => {
          setStatusMessage({
            message:
              body.decision === "ignore"
                ? "Suggestion ignored"
                : "Suggestion accepted",
            role: "status",
          });
        },
      },
    );
  };

  return (
    <article
      className="outcome-suggestion-card"
      aria-labelledby={suggestionTitleId}
    >
      <header className="outcome-suggestion-head">
        <span>
          <b id={suggestionTitleId}>
            {outcomeLabel(suggestion.suggestedKind)} suggestion
          </b>
          <span className="meta">
            {Math.round(suggestion.confidence * 100)}% confidence ·{" "}
            {formatDateTime(suggestion.createdAt)}
          </span>
          <span className="meta">{suggestion.jobKey}</span>
        </span>
        <StatusBadge tone="info">Pending</StatusBadge>
      </header>
      <p>{suggestion.rationale}</p>
      <div className="row-actions">
        <Button
          type="button"
          size="sm"
          disabled={decideSuggestion.isPending}
          aria-label={`Accept ${suggestionContext}`}
          onClick={() =>
            decide({ decision: "accept", reason: "Accepted from review UI." })
          }
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={decideSuggestion.isPending}
          aria-label={`Ignore ${suggestionContext}`}
          onClick={() =>
            decide({ decision: "ignore", reason: "Ignored from review UI." })
          }
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
              <Field className="field">
                <FieldLabel
                  htmlFor={`suggestion-${suggestion.suggestionId}-outcome-kind`}
                >
                  Correct to
                </FieldLabel>
                <Select
                  items={APPLICATION_OUTCOME_KINDS.map((kind) => ({
                    label: outcomeLabel(kind),
                    value: kind,
                  }))}
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (value !== null)
                      field.handleChange(value as ApplicationOutcomeKind);
                  }}
                >
                  <SelectTrigger
                    id={`suggestion-${suggestion.suggestionId}-outcome-kind`}
                    aria-label="Correct to"
                    className="w-full"
                    onBlur={field.handleBlur}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {APPLICATION_OUTCOME_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {outcomeLabel(kind)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Field name="occurredAt">
            {(field) => (
              <Field className="field">
                <FieldLabel
                  htmlFor={`suggestion-${suggestion.suggestionId}-occurred-at`}
                >
                  Occurred at
                </FieldLabel>
                <Input
                  id={`suggestion-${suggestion.suggestionId}-occurred-at`}
                  type="datetime-local"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="reason">
            {(field) => (
              <Field className="field">
                <FieldLabel
                  htmlFor={`suggestion-${suggestion.suggestionId}-reason`}
                >
                  Reason
                </FieldLabel>
                <Input
                  id={`suggestion-${suggestion.suggestionId}-reason`}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="note">
            {(field) => (
              <Field className="field wide">
                <FieldLabel
                  htmlFor={`suggestion-${suggestion.suggestionId}-note`}
                >
                  Local note
                </FieldLabel>
                <Textarea
                  id={`suggestion-${suggestion.suggestionId}-note`}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          {decideSuggestion.isError ? (
            <div aria-live="assertive" className="danger" role="alert">
              Suggestion decision failed
            </div>
          ) : null}
          {statusMessage ? (
            <div
              aria-live={
                statusMessage.role === "alert" ? "assertive" : "polite"
              }
              className="status-line"
              role={statusMessage.role}
            >
              {statusMessage.message}
            </div>
          ) : null}
          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button
                className="outcome-submit"
                type="submit"
                size="sm"
                variant="secondary"
                disabled={
                  !canSubmit || isSubmitting || decideSuggestion.isPending
                }
                aria-label={`Correct ${suggestionContext}`}
              >
                {isSubmitting || decideSuggestion.isPending
                  ? "Saving"
                  : "Correct"}
              </Button>
            )}
          </form.Subscribe>
        </fieldset>
      </form>
    </article>
  );
}
