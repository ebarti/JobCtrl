import { useRetryableAction, type RetryableActionRetention } from "../../../shared/lib/useRetryableAction.js";
import { isUnconfirmedWrite } from "../../../shared/lib/unconfirmed-write.js";
import { JobCtrlApiError } from "@jobctrl/api-client";
import {
  APPLICATION_OUTCOME_KINDS,
  ManualApplicationOutcomeRequestSchema,
  OutcomeSuggestionDecisionRequestSchema,
  type ApplicationOutcome,
  type ApplicationOutcomeKind,
  type ManualApplicationOutcomeRequest,
  type OutcomeSuggestionDecisionRequest,
  type OutcomeSuggestionDecisionConflict,
  type OutcomeSuggestionDecisionResponse,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useJobApplicationOutcomesQuery, type VersionedOutcomeSuggestion as OutcomeSuggestion } from "../outcomes.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
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
} from "../hooks/useOutcomeMutations.js";
import { OutcomeSuggestionAudit } from "./OutcomeSuggestionAudit.js";

type JobId = string;
type OutcomeWithAuthority = ApplicationOutcome & {
  readonly recordedBy?: "user" | "owned_submission";
  readonly submissionIntentId?: string | null;
};

function outcomeSourceLabel(outcome: OutcomeWithAuthority): string {
  if (outcome.recordedBy === "owned_submission") {
    return outcome.source === "manual" && outcome.kind === "applied_confirmation" && outcome.submissionIntentId
      ? "Confirmed send receipt" : "Submission source unavailable";
  }
  if (outcome.source === "email_suggestion") return "email suggestion";
  return outcome.recordedBy === "user" ? "manual" : "Outcome source unavailable";
}

interface ManualOutcomeFormValues {
  readonly kind: ApplicationOutcomeKind;
  readonly occurredAt: string;
  readonly note: string;
}

interface InterviewReflectionFormValues {
  readonly occurredAt: string;
  readonly note: string;
}

interface OutcomeDraftRetention<T> {
  drafts: Map<string, T>;
  actions: RetryableActionRetention<ManualApplicationOutcomeRequest>;
}

interface OutcomeDraftRetentions {
  manual: OutcomeDraftRetention<ManualOutcomeFormValues>;
  reflection: OutcomeDraftRetention<InterviewReflectionFormValues>;
  suggestions: SuggestionDraftRetention;
}

const OutcomeDraftRetentionContext = createContext<OutcomeDraftRetentions | null>(null);

/** Keeps private drafts only in memory for the mounted app session. */
export function OutcomeDraftRetentionProvider({ children }: { readonly children: ReactNode }) {
  const [retention] = useState<OutcomeDraftRetentions>(() => ({
    manual: { drafts: new Map(), actions: new Map() },
    reflection: { drafts: new Map(), actions: new Map() },
    suggestions: createSuggestionDraftRetention(),
  }));
  return <OutcomeDraftRetentionContext.Provider value={retention}>{children}</OutcomeDraftRetentionContext.Provider>;
}

function useOutcomeDraftRetention<T>(): OutcomeDraftRetention<T> {
  return useRef<OutcomeDraftRetention<T>>({ drafts: new Map(), actions: new Map() }).current;
}

const EMPTY_MANUAL_OUTCOME: ManualOutcomeFormValues = {
  kind: "applied_confirmation", occurredAt: "", note: "",
};
const EMPTY_REFLECTION: InterviewReflectionFormValues = { occurredAt: "", note: "" };

interface SuggestionCorrectionFormValues {
  readonly outcomeKind: ApplicationOutcomeKind;
  readonly occurredAt: string;
  readonly note: string;
  readonly reason: string;
}

interface RetainedSuggestionDraft {
  readonly tenantId: string;
  readonly suggestion: OutcomeSuggestion;
  readonly values: SuggestionCorrectionFormValues;
  readonly pending: symbol | null;
  readonly requestedDecision: OutcomeSuggestionDecisionRequest["decision"] | null;
  readonly conflict: OutcomeSuggestionDecisionConflict | null;
  readonly completion: OutcomeSuggestionDecisionResponse | null;
  readonly failed: boolean;
  readonly staleVersion: number | null;
  readonly uncertainRequest: OutcomeSuggestionDecisionRequest | null;
  readonly uncertainVersion: number | null;
}

interface SuggestionDraftRetention {
  readonly drafts: Map<string, RetainedSuggestionDraft>;
  readonly dismissed: Set<string>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
  readonly notify: () => void;
}

function createSuggestionDraftRetention(): SuggestionDraftRetention {
  const drafts = new Map<string, RetainedSuggestionDraft>();
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  return {
    drafts,
    dismissed,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => revision,
    notify: () => { revision += 1; listeners.forEach((listener) => listener()); },
  };
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
): Omit<ManualApplicationOutcomeRequest, "requestId"> {
  return {
    kind: values.kind,
    occurredAt: isoTimestampFromLocalInput(values.occurredAt),
    note: values.note.trim() || undefined,
  };
}

function interviewReflectionPayload(
  values: InterviewReflectionFormValues,
  prepGeneration: number,
): Omit<ManualApplicationOutcomeRequest, "requestId"> {
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
  outcomes: readonly OutcomeWithAuthority[],
): OutcomeWithAuthority[] {
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
  const localRetention = useOutcomeDraftRetention<ManualOutcomeFormValues>();
  const sharedRetention = useContext(OutcomeDraftRetentionContext);
  const manualRetention = sharedRetention?.manual ?? localRetention;
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
          {data.interpretationStatus?.status === "unavailable" ? <div className="banner inline" role="status">Email outcome interpretation is unavailable. Retry feedback sync after resolving the model or budget failure.</div> : null}
          <ManualOutcomeForm key={`manual-outcome:${jobId}`} jobId={jobId} retention={manualRetention} />
          <OutcomeTimeline outcomes={data.outcomes} />
          <OutcomeSuggestionsPanel suggestions={pendingSuggestions} jobId={jobId} />
        </>
      ) : null}
    </div>
  );
}

export interface ManualOutcomeFormProps {
  readonly jobId: JobId;
  readonly retention?: OutcomeDraftRetention<ManualOutcomeFormValues>;
}

export function ManualOutcomeForm({ jobId, retention }: ManualOutcomeFormProps) {
  const tenantId = useTenantId();
  const localRetention = useOutcomeDraftRetention<ManualOutcomeFormValues>();
  const retained = retention ?? localRetention;
  const key = JSON.stringify([tenantId, jobId]);
  return <ManualOutcomeFormFields key={key} jobId={jobId} initialValues={retained.drafts.get(key)}
    actions={retained.actions} onValuesChange={(values) => retained.drafts.set(key, values)} />;
}

function ManualOutcomeFormFields({ jobId, initialValues, actions, onValuesChange }: {
  readonly jobId: JobId;
  readonly initialValues: ManualOutcomeFormValues | undefined;
  readonly actions: RetryableActionRetention<ManualApplicationOutcomeRequest>;
  readonly onValuesChange: (values: ManualOutcomeFormValues) => void;
}) {
  const recordOutcome = useRecordManualApplicationOutcomeMutation();
  const action = useRetryableAction<ManualApplicationOutcomeRequest>(jobId, actions);
  const mounted = useRef(true);
  const defaults = useRef(initialValues ?? EMPTY_MANUAL_OUTCOME);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [statusMessage, setStatusMessage] = useState<FeedbackMessage | null>(
    null,
  );
  const form = useForm({
    defaultValues: defaults.current,
    listeners: { onChange: ({ formApi }) => onValuesChange({ ...formApi.state.values }) },
    validators: {
      onSubmit: ({ value }) => {
        const result = ManualApplicationOutcomeRequestSchema.safeParse(
          { ...manualOutcomePayload(value), requestId: action.requestId },
        );
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid outcome");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage(null);
      const result = ManualApplicationOutcomeRequestSchema.safeParse(
        { ...manualOutcomePayload(value), requestId: action.requestId },
      );
      if (!result.success) {
        setStatusMessage({
          message: result.error.issues[0]?.message ?? "Invalid outcome",
          role: "alert",
        });
        return;
      }
      try {
        await recordOutcome.mutateAsync({ jobId, body: action.prepare(result.data) });
      } catch {
        return;
      }
      // An acknowledgement from a form left behind by a tenant/job switch
      // must not clear a newer mounted draft. Its frozen action remains retryable.
      if (!mounted.current) return;
      action.newAction();
      defaults.current = EMPTY_MANUAL_OUTCOME;
      formApi.reset(EMPTY_MANUAL_OUTCOME);
      onValuesChange({ ...EMPTY_MANUAL_OUTCOME });
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
      {action.pending ? (
        <div className="outcome-retry-notice" role="status">
          Retry keeps the original submitted values; the action may already be recorded.
          <Button type="button" disabled={recordOutcome.isPending} onClick={() => { action.newAction(); recordOutcome.reset(); }}>Start a new action</Button>
        </div>
      ) : null}
      <fieldset className="outcome-fields" disabled={action.pending}>
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
      </fieldset>
      {recordOutcome.isError ? (
        <div aria-live="assertive" className="danger" role="alert">
          {recordOutcome.error?.message || "Outcome save failed"}
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
  const localRetention = useOutcomeDraftRetention<InterviewReflectionFormValues>();
  const sharedRetention = useContext(OutcomeDraftRetentionContext);
  const reflectionRetention = sharedRetention?.reflection ?? localRetention;
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
      <InterviewReflectionForm key={jobId} jobId={jobId} prepGeneration={prepGeneration} retention={reflectionRetention} />
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
  readonly retention?: OutcomeDraftRetention<InterviewReflectionFormValues>;
}

export function InterviewReflectionForm({
  jobId,
  prepGeneration,
  retention,
}: InterviewReflectionFormProps) {
  const tenantId = useTenantId();
  const localRetention = useOutcomeDraftRetention<InterviewReflectionFormValues>();
  const retained = retention ?? localRetention;
  const key = JSON.stringify([tenantId, jobId]);
  return <InterviewReflectionFormFields key={key} jobId={jobId} prepGeneration={prepGeneration}
    initialValues={retained.drafts.get(key)} actions={retained.actions}
    onValuesChange={(values) => retained.drafts.set(key, values)} />;
}

function InterviewReflectionFormFields({ jobId, prepGeneration, initialValues, actions, onValuesChange }: {
  readonly jobId: JobId;
  readonly prepGeneration: number;
  readonly initialValues: InterviewReflectionFormValues | undefined;
  readonly actions: RetryableActionRetention<ManualApplicationOutcomeRequest>;
  readonly onValuesChange: (values: InterviewReflectionFormValues) => void;
}) {
  const recordOutcome = useRecordManualApplicationOutcomeMutation();
  const action = useRetryableAction<ManualApplicationOutcomeRequest>(jobId, actions);
  const mounted = useRef(true);
  const defaults = useRef(initialValues ?? EMPTY_REFLECTION);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [statusMessage, setStatusMessage] = useState<FeedbackMessage | null>(
    null,
  );
  const form = useForm({
    defaultValues: defaults.current,
    listeners: { onChange: ({ formApi }) => onValuesChange({ ...formApi.state.values }) },
    validators: {
      onSubmit: ({ value }) => {
        const result = ManualApplicationOutcomeRequestSchema.safeParse(
          { ...interviewReflectionPayload(value, prepGeneration), requestId: action.requestId },
        );
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid reflection");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage(null);
      const result = ManualApplicationOutcomeRequestSchema.safeParse(
        { ...interviewReflectionPayload(value, prepGeneration), requestId: action.requestId },
      );
      if (!result.success) {
        setStatusMessage({
          message: result.error.issues[0]?.message ?? "Invalid reflection",
          role: "alert",
        });
        return;
      }
      try {
        await recordOutcome.mutateAsync({ jobId, body: action.prepare(result.data) });
      } catch {
        return;
      }
      if (!mounted.current) return;
      action.newAction();
      defaults.current = EMPTY_REFLECTION;
      formApi.reset(EMPTY_REFLECTION);
      onValuesChange({ ...EMPTY_REFLECTION });
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
      {action.pending ? (
        <div className="outcome-retry-notice" role="status">
          Retry keeps the original submitted values; the action may already be recorded.
          <Button type="button" disabled={recordOutcome.isPending} onClick={() => { action.newAction(); recordOutcome.reset(); }}>Start a new action</Button>
        </div>
      ) : null}
      {/* Native hidden controls preserve the named reflection metadata. */}
      <input name="kind" readOnly type="hidden" value="interview" />
      <input
        name="interviewPrepGeneration"
        readOnly
        type="hidden"
        value={prepGeneration}
      />
      <fieldset className="outcome-fields" disabled={action.pending}>
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
      </fieldset>
      {recordOutcome.isError ? (
        <div aria-live="assertive" className="danger" role="alert">
          {recordOutcome.error?.message || "Reflection save failed"}
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
  readonly outcomes: readonly OutcomeWithAuthority[];
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
            {outcomeSourceLabel(outcome)}
          </span>
          {outcome.recordedBy === "owned_submission" && outcome.source === "manual" && outcome.kind === "applied_confirmation" && outcome.submissionIntentId ? (
            <span className="meta mono">Submission intent {outcome.submissionIntentId}</span>
          ) : null}
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
  readonly interpretationStatus?: {readonly status:"available"|"unavailable"|"not_requested";readonly failureCode:string|null} | undefined;
  readonly jobId?: JobId;
}

export function OutcomeSuggestionsPanel({
  suggestions,
  interpretationStatus,
  jobId,
}: OutcomeSuggestionsPanelProps) {
  const tenantId = useTenantId();
  const shared = useContext(OutcomeDraftRetentionContext);
  const [localRetention] = useState(createSuggestionDraftRetention);
  const retention = shared?.suggestions ?? localRetention;
  useSyncExternalStore(retention.subscribe, retention.getSnapshot, retention.getSnapshot);
  const currentSuggestions = suggestions;
  const visible = new Map<string, OutcomeSuggestion>();
  for (const suggestion of currentSuggestions) {
    if (jobId && suggestion.jobKey !== jobId) continue;
    const key = JSON.stringify([tenantId, suggestion.jobKey, suggestion.suggestionId]);
    if (!retention.dismissed.has(key)) visible.set(key, suggestion);
  }
  for (const [key, draft] of retention.drafts) {
    if (draft.tenantId === tenantId && (!jobId || draft.suggestion.jobKey === jobId) && !retention.dismissed.has(key) && !visible.has(key)) {
      visible.set(key, draft.suggestion);
    }
  }
  if (interpretationStatus?.status === "unavailable" && !visible.size) return <div className="banner inline" role="status">Email outcome interpretation is unavailable. Retry feedback sync after resolving the model or budget failure.</div>;
  if (!visible.size) return <Empty title="No pending outcome suggestions." />;
  return (
    <div className="outcome-suggestions" aria-label="Pending outcome suggestions">
      {interpretationStatus?.status === "unavailable" ? <div className="banner inline" role="status">Email outcome interpretation is unavailable. Suggestions without recorded authority can still be ignored, but cannot be accepted or corrected.</div> : null}
      {[...visible].map(([key, suggestion]) => (
        <OutcomeSuggestionCard
          key={key}
          suggestion={suggestion}
          tenantId={tenantId}
          ownerKey={key}
          retention={retention}
          retained={retention.drafts.get(key)}
        />
      ))}
    </div>
  );
}

function decisionConflict(error: unknown, suggestion: OutcomeSuggestion): OutcomeSuggestionDecisionConflict | null {
  if (!(error instanceof JobCtrlApiError) || error.status !== 409 || !error.responseBody || typeof error.responseBody !== "object") return null;
  const envelope = error.responseBody as { error?: { code?: unknown; details?: unknown } };
  const details = envelope.error?.details;
  if (!details || typeof details !== "object") return null;
  const body = { ok: false, error: envelope.error?.code, ...details } as Partial<OutcomeSuggestionDecisionConflict>;
  if ((body.error !== "outcome_suggestion_conflict" && body.error !== "outcome_suggestion_replay_unverifiable") ||
      !body.suggestion || body.suggestion.suggestionId !== suggestion.suggestionId || body.suggestion.jobKey !== suggestion.jobKey ||
      !["accepted", "corrected", "ignored"].includes(body.suggestion.status) ||
      (body.suggestion.decisionReason !== null && typeof body.suggestion.decisionReason !== "string") ||
      (body.outcome !== null && (!body.outcome || body.outcome.jobKey !== suggestion.jobKey ||
        body.outcome.suggestionId !== suggestion.suggestionId || body.outcome.outcomeId !== body.suggestion.decidedOutcomeId ||
        typeof body.outcome.occurredAt !== "string" || (body.outcome.note !== null && typeof body.outcome.note !== "string") ||
        !APPLICATION_OUTCOME_KINDS.includes(body.outcome.kind)))) return null;
  return body as OutcomeSuggestionDecisionConflict;
}

function changedSuggestionVersion(error: unknown, suggestion: OutcomeSuggestion): number | null {
  if (!(error instanceof JobCtrlApiError) || error.status !== 409 || !error.responseBody || typeof error.responseBody !== "object") return null;
  const envelope = error.responseBody as { error?: { code?: unknown; details?: { suggestion?: unknown } } };
  const current = envelope.error?.details?.suggestion;
  if (envelope.error?.code !== "revision_conflict" || !current || typeof current !== "object") return null;
  const value = current as Partial<OutcomeSuggestion>;
  return value.suggestionId === suggestion.suggestionId && value.jobKey === suggestion.jobKey && value.status === "pending" &&
    Number.isInteger(value.version) && value.version! > suggestion.version ? value.version! : null;
}

function OutcomeSuggestionCard({
  suggestion,
  tenantId,
  ownerKey,
  retention,
  retained,
}: {
  readonly suggestion: OutcomeSuggestion;
  readonly tenantId: string;
  readonly ownerKey: string;
  readonly retention: SuggestionDraftRetention;
  readonly retained: RetainedSuggestionDraft | undefined;
}) {
  const decideSuggestion = useOutcomeSuggestionDecisionMutation();
  const [statusMessage, setStatusMessage] = useState<FeedbackMessage | null>(
    null,
  );
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const defaults = useRef<SuggestionCorrectionFormValues>(retained?.values ?? {
    outcomeKind: suggestion.suggestedKind, occurredAt: "", note: "", reason: "",
  });
  const conflict = retained?.conflict ?? null;
  const completion = retained?.completion ?? null;
  const requestedDecision = retained?.requestedDecision ?? null;
  const staleVersion = retained?.staleVersion ?? null;
  const uncertainRequest = retained?.uncertainRequest ?? null;
  const busy = decideSuggestion.isPending || retained?.pending != null;
  const suggestionTitleId = `outcome-suggestion-${suggestion.suggestionId}-title`;
  const suggestionContext = `suggestion ${suggestion.suggestionId} (${outcomeLabel(
    suggestion.suggestedKind,
  )}) for ${suggestion.jobKey}`;

  const retainValues = (values: SuggestionCorrectionFormValues) => {
    const previous = retention.drafts.get(ownerKey);
    if (previous?.pending) return;
    retention.drafts.set(ownerKey, {
      tenantId, suggestion, values: { ...values }, pending: null,
      requestedDecision: previous?.requestedDecision ?? null, staleVersion: previous?.staleVersion ?? null,
      uncertainRequest: previous?.uncertainRequest ?? null, uncertainVersion: previous?.uncertainVersion ?? null,
      conflict: previous?.conflict ?? null, completion: previous?.completion ?? null, failed: false,
    });
    retention.notify();
  };

  const decide = async (body: OutcomeSuggestionDecisionRequest, values: SuggestionCorrectionFormValues, retry = false) => {
    const previous = retention.drafts.get(ownerKey);
    if (previous?.pending || previous?.conflict || previous?.completion || previous?.staleVersion || (previous?.uncertainRequest && !retry)) return;
    const submitted = retry && previous?.uncertainRequest ? previous.uncertainRequest : body;
    const version = retry && previous?.uncertainVersion !== null && previous?.uncertainVersion !== undefined ? previous.uncertainVersion : suggestion.version;
    const attempt = Symbol("outcome-decision");
    setStatusMessage(null);
    retention.drafts.set(ownerKey, {
      tenantId, suggestion, values: { ...values }, pending: attempt,
      requestedDecision: submitted.decision, conflict: null, completion: null, failed: false, staleVersion: null,
      uncertainRequest: previous?.uncertainRequest ?? null, uncertainVersion: previous?.uncertainVersion ?? null,
    });
    retention.notify();
    try {
      if (!Number.isInteger(version)) throw new Error("Refresh the suggestion before deciding it.");
      const saved = await decideSuggestion.mutateAsync({ suggestionId: suggestion.suggestionId, jobId: suggestion.jobKey, expectedVersion: version, body: submitted });
      const current = retention.drafts.get(ownerKey);
      if (current?.pending !== attempt) return;
      if (mounted.current) retention.drafts.delete(ownerKey);
      else retention.drafts.set(ownerKey, { ...current, pending: null, completion: saved });
      retention.notify();
      if (mounted.current) setStatusMessage({
        message: saved.disposition === "replayed" ? "Suggestion decision already recorded"
          : submitted.decision === "ignore" ? "Suggestion ignored"
          : submitted.decision === "accept" ? "Suggestion accepted" : "Suggestion corrected",
        role: "status",
      });
    } catch (error) {
      const current = retention.drafts.get(ownerKey);
      if (current?.pending !== attempt) return;
      const savedConflict = decisionConflict(error, suggestion);
      const changedVersion = changedSuggestionVersion(error, suggestion);
      const uncertain = isUnconfirmedWrite(error);
      retention.drafts.set(ownerKey, { ...current, pending: null, conflict: savedConflict, staleVersion: changedVersion,
        uncertainRequest: uncertain ? submitted : null, uncertainVersion: uncertain ? version : null,
        failed: !savedConflict && changedVersion === null && !uncertain });
      retention.notify();
    }
  };

  const dismiss = () => {
    retention.drafts.delete(ownerKey);
    retention.dismissed.add(ownerKey);
    retention.notify();
  };

  const form = useForm({
    defaultValues: defaults.current,
    listeners: { onChange: ({ formApi }) => retainValues({ ...formApi.state.values }) },
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
      await decide(result.data, value);
    },
  });

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
        <StatusBadge tone="info">{conflict || completion ? "Already decided" : "Pending"}</StatusBadge>
      </header>
      <p>{suggestion.rationale}</p>
      {suggestion.citations.map((citation, index) => <blockquote key={`${citation.source_id}:${index}`}>{citation.quote}</blockquote>)}
      <p className="meta">{suggestion.determination
        ? `Model: ${suggestion.determination.provider}/${suggestion.determination.model} · Prompt: ${suggestion.determination.prompt_version} · Source: ${suggestion.determination.input_fingerprint}`
        : "No recorded determination"}</p>
      {suggestion.determination ? <details>
        <summary>Inspect recorded model determination</summary>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(suggestion.determination, null, 2)}</pre>
      </details> : null}
      {suggestion.determination && suggestion.evidenceId ? <OutcomeSuggestionAudit
        suggestionId={suggestion.suggestionId}
        jobId={suggestion.jobKey}
        evidenceId={suggestion.evidenceId}
        expectedReceiptId={suggestion.determination.determination_id}
        expectedFingerprint={suggestion.determination.input_fingerprint}
      /> : null}
      {conflict ? (
        <div role="alert" className="banner inline outcome-decision-notice">
          <p>{conflict.error === "outcome_suggestion_conflict"
            ? "Your requested decision was not applied."
            : "The stored decision or earlier request could not be verified."}</p>
          <p>Requested decision: {requestedDecision}.</p>
          <p>{conflict.error === "outcome_suggestion_conflict" ? "Saved decision" : "Currently stored decision"}: {conflict.suggestion.status}{conflict.outcome ? ` · ${outcomeLabel(conflict.outcome.kind)} · ${formatDateTime(conflict.outcome.occurredAt)}` : ""}.</p>
          {conflict.suggestion.decisionReason ? <p>Saved reason: {conflict.suggestion.decisionReason}</p> : null}
          {conflict.outcome?.note ? <p>Saved note: {conflict.outcome.note}</p> : null}
          <p>Your correction fields remain below for review or copying.</p>
          <Button type="button" size="sm" variant="outline" onClick={dismiss}>Dismiss</Button>
        </div>
      ) : null}
      {completion ? (
        <div role="status" className="banner inline outcome-decision-notice">
          <p>Your {requestedDecision} decision was recorded while you were away.</p>
          <p>Saved decision: {completion.suggestion.status}{completion.outcome ? ` · ${outcomeLabel(completion.outcome.kind)} · ${formatDateTime(completion.outcome.occurredAt)}` : ""}.</p>
          <p>Your correction fields remain below for review or copying.</p>
          <Button type="button" size="sm" variant="outline" onClick={dismiss}>Dismiss</Button>
        </div>
      ) : null}
      {busy ? <p role="status">Decision in progress.</p> : null}
      {uncertainRequest ? <div role="status" className="banner inline">
        <p>The decision may already be saved. Review the current outcome history; retry uses the exact same decision and fields.</p>
        <p>Submitted decision: {uncertainRequest.decision}.</p>
        <Button type="button" size="sm" disabled={busy} onClick={() => { void decide(uncertainRequest, retained?.values ?? form.state.values, true); }}>Retry the same decision</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={dismiss}>Dismiss retained correction</Button>
      </div> : null}
      {staleVersion !== null ? <div role="alert" className="banner inline">
        <p>This suggestion changed before your decision was saved. Your correction fields are preserved; review the current suggestion before trying again.</p>
        <Button type="button" size="sm" variant="outline" disabled={suggestion.version !== staleVersion} onClick={() => {
          const current = retention.drafts.get(ownerKey);
          if (current && suggestion.version === staleVersion) {
            retention.drafts.set(ownerKey, { ...current, suggestion, staleVersion: null });
            retention.notify();
          }
        }}>I reviewed the current suggestion</Button>
        <Button type="button" size="sm" variant="outline" onClick={dismiss}>Dismiss retained correction</Button>
      </div> : null}
      <div className="row-actions">
        <Button
          type="button"
          size="sm"
          disabled={busy || uncertainRequest !== null || staleVersion !== null || !suggestion.determination || conflict !== null || completion !== null}
          aria-label={`Accept ${suggestionContext}`}
          onClick={() =>
            void decide({ decision: "accept", reason: "Accepted from review UI." }, form.state.values)
          }
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || uncertainRequest !== null || staleVersion !== null || conflict !== null || completion !== null}
          aria-label={`Ignore ${suggestionContext}`}
          onClick={() =>
            void decide({ decision: "ignore", reason: "Ignored from review UI." }, form.state.values)
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
        <fieldset className="outcome-correction-fieldset" disabled={busy || uncertainRequest !== null}>
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
                    if (value !== null) {
                      field.handleChange(value as ApplicationOutcomeKind);
                    }
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
          {(retained?.failed || decideSuggestion.isError) && !conflict ? (
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
                  !canSubmit || isSubmitting || busy || uncertainRequest !== null || staleVersion !== null || !suggestion.determination || conflict !== null || completion !== null
                }
                aria-label={`Correct ${suggestionContext}`}
              >
                {isSubmitting || busy
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
