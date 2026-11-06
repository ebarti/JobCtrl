import { useForm } from "@tanstack/react-form";
import { useId, useState } from "react";
import { z } from "zod";

import type {
  ScreeningRead,
  ScreeningQuestion as ScreeningQuestionState,
  ScreeningCommand,
} from "../contracts.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { Button } from "../../../shared/ui/button.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  useScreeningCopyValidation,
  useScreeningAnswerMutation,
  useScreeningAnswers,
} from "../hooks/useScreeningAnswers.js";
import { useScreeningDraftStore } from "../stores/review-drafts.js";

type Read = ScreeningRead;
type State = ScreeningQuestionState;
type Command = ScreeningCommand;
const captureSchema = z.object({
  applicationId: z.string().min(1).max(160),
  question: z.string().min(1).max(4000),
  context: z.string().min(1).max(4000),
});
const textSchema = z.string().min(1).max(16000);

export function ScreeningAnswerLibrary({
  jobId,
  initialOpen = false,
}: {
  readonly jobId: string;
  readonly initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <section className="section" aria-label="Screening answers">
      <h3 data-typography="component-title">Screening answers</h3>
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Hide screening answers" : "Open screening answers"}
      </Button>
      {open ? (
        <ScreeningAnswerLibraryContent key={jobId} jobId={jobId} />
      ) : null}
    </section>
  );
}

function ScreeningAnswerLibraryContent({ jobId }: { readonly jobId: string }) {
  const query = useScreeningAnswers(jobId);
  const { requestIdentity } = usePorts();
  const mutation = useScreeningAnswerMutation(jobId);
  const id = useId();
  const tenant = useTenantId();
  const captureKey = JSON.stringify([tenant, jobId, "screening-capture"]);
  const texts = useScreeningDraftStore((state) => state.texts);
  const editCapture = useScreeningDraftStore((state) => state.edit);
  const form = useForm({
    defaultValues: {
      applicationId: texts[captureKey + ":applicationId"] ?? "",
      question: texts[captureKey + ":question"] ?? "",
      context: texts[captureKey + ":context"] ?? "",
    },
    validators: {
      onSubmit: ({ value }) =>
        captureSchema.safeParse(value).success
          ? undefined
          : "Enter an application attempt, exact question and context.",
    },
    onSubmit: async ({ value }) => {
      const parsed = captureSchema.safeParse(value);
      if (!parsed.success) return;
      try {
        await mutation.mutateAsync({
          ...parsed.data,
          action: "capture",
          expectedRevision: 0,
          idempotencyKey: requestIdentity.create(),
          selectedFactIds: [],
          sensitiveFactIds: [],
          attested: false,
        });
      } catch {
        /* Preserve entered questions. */
      }
    },
  });
  return (
    <section
      className="section grid gap-3"
      aria-label="Private screening answer library"
    >
      <p>
        Drafts need explicit review. Copying and recording manual use never
        enter or submit a form, or mark an application submitted.
      </p>
      <p>Application job: {jobId}</p>
      {query.isLoading ? (
        <p role="status">Loading private answer history…</p>
      ) : null}
      {query.data?.sourceFailure ? (
        <p role="alert">
          Current sources unavailable: {query.data.sourceFailure}. Retained
          history remains inspectable.
        </p>
      ) : null}
      {query.error ? (
        <p role="alert">
          Screening answers unavailable. Saved answers and your edits are
          preserved. A saved profile, posting and destination are required.
        </p>
      ) : null}
      <Button
        variant="outline"
        onClick={() => {
          void query.refetch();
        }}
      >
        Reload screening history
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        className="grid gap-3"
      >
        {(["applicationId", "question", "context"] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <label htmlFor={`${id}-${name}`}>
                {name === "applicationId"
                  ? "Application attempt identifier"
                  : name === "question"
                    ? "Exact screening question"
                    : "Question context and constraints"}
                <Textarea
                  id={`${id}-${name}`}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    editCapture(captureKey + ":" + name, event.target.value);
                  }}
                  maxLength={name === "applicationId" ? 160 : 4000}
                />
              </label>
            )}
          </form.Field>
        ))}
        <form.Subscribe selector={(state) => state.errors}>
          {(errors) =>
            errors.length ? (
              <p role="alert">Enter all question fields.</p>
            ) : null
          }
        </form.Subscribe>
        <Button
          type="submit"
          disabled={
            !query.data ||
            !!query.data.sourceFailure ||
            mutation.isPending ||
            !!mutation.uncertain
          }
        >
          Capture question
        </Button>
      </form>
      {mutation.uncertain ? (
        <div role="alert">
          <p>
            The last screening write has an unconfirmed result. Exact input and
            request identity are retained; reconcile it before another change.
          </p>
          <Button
            disabled={mutation.isPending}
            onClick={() => {
              if (mutation.uncertain)
                void mutation
                  .mutateAsync(mutation.uncertain)
                  .catch(() => undefined);
            }}
          >
            Reconcile same screening request
          </Button>
        </div>
      ) : mutation.error ? (
        <p role="alert">
          Question capture failed; your input remains available.
        </p>
      ) : null}
      {query.data?.questions.map((question) => (
        <ScreeningQuestion
          key={question.questionId}
          jobId={jobId}
          question={question}
          read={query.data!}
        />
      ))}
      <details>
        <summary>Failed attempts</summary>
        {query.data?.failures.map((failure, index) => (
          <p key={`${failure.questionId}:${index}`}>
            {failure.action} · {failure.code} · {failure.recordedAt}
          </p>
        ))}
      </details>
      <details>
        <summary>Persisted model authority</summary>
        <pre className="whitespace-pre-wrap break-words">
          {JSON.stringify(query.data?.determinations ?? [], null, 2)}
        </pre>
      </details>
      <details>
        <summary>Application-bound history</summary>
        {query.data?.history.map((entry) => (
          <article key={entry.snapshotId} className="border p-3">
            <p>
              Attempt {entry.applicationId} · revision {entry.revision} ·{" "}
              {entry.action} · {entry.recordedAt}
            </p>
            <p>{entry.question}</p>
            {entry.manualUse && entry.action === "use" ? (
              <>
                <p>
                  Explicit manual-use attestation ·{" "}
                  {entry.manualUse.changed
                    ? "Changed text, unverified user statement"
                    : "Reviewed text"}
                </p>
                <pre className="whitespace-pre-wrap">
                  {entry.manualUse.text}
                </pre>
              </>
            ) : null}
            <details>
              <summary>Exact retained snapshot</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(entry, null, 2)}
              </pre>
            </details>
          </article>
        ))}
      </details>
    </section>
  );
}

function ScreeningQuestion({
  jobId,
  question,
  read,
}: {
  jobId: string;
  question: State;
  read: Read;
}) {
  const mutation = useScreeningAnswerMutation(jobId);
  const { clipboard, requestIdentity } = usePorts();
  const copyValidation = useScreeningCopyValidation(jobId);
  const tenant = useTenantId();
  const id = useId();
  const [facts, setFacts] = useState<string[]>([]);
  const [consent, setConsent] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const editKey = JSON.stringify([
    tenant,
    jobId,
    "screening",
    question.questionId,
  ]);
  const localText = useScreeningDraftStore((state) => state.texts[editKey]);
  const edit = useScreeningDraftStore((state) => state.edit);
  const usedText = useScreeningDraftStore(
    (state) => state.texts[editKey + ":used"],
  );
  const revisions = useScreeningDraftStore((state) => state.revisions);
  const editRevision = useScreeningDraftStore((state) => state.editRevision);
  const rebase = useScreeningDraftStore((state) => state.rebase);
  const editKeys = [editKey, editKey + ":question", editKey + ":context"];
  const staleEdits = editKeys.some(
    (key) =>
      revisions[key] !== undefined && revisions[key]! < question.revision,
  );
  const localQuestion = useScreeningDraftStore(
    (state) => state.texts[editKey + ":question"],
  );
  const localContext = useScreeningDraftStore(
    (state) => state.texts[editKey + ":context"],
  );
  const form = useForm({
    defaultValues: {
      question: localQuestion ?? question.question,
      context: localContext ?? question.context,
      text: localText ?? "",
      usedText: usedText ?? question.accepted?.text ?? "",
    },
    validators: {
      onSubmit: ({ value }) =>
        textSchema.safeParse(value.text).success
          ? undefined
          : "Enter an answer of up to 16,000 characters.",
    },
    onSubmit: async ({ value }) => {
      if (textSchema.safeParse(value.text).success)
        await execute("edit", { text: value.text });
    },
  });
  async function execute(
    action: Command["action"],
    extras: Partial<Command> = {},
  ) {
    try {
      await mutation.mutateAsync({
        action,
        idempotencyKey: requestIdentity.create(),
        questionId: question.questionId,
        expectedRevision:
          action === "edit"
            ? (revisions[editKey] ?? question.revision)
            : action === "capture"
              ? Math.min(
                  revisions[editKey + ":question"] ?? question.revision,
                  revisions[editKey + ":context"] ?? question.revision,
                )
              : question.revision,
        selectedFactIds: facts,
        sensitiveFactIds: facts.filter((ident) =>
          read.facts.some(
            (fact) =>
              fact.id === ident &&
              fact.sensitive &&
              consent[ident] === fact.text,
          ),
        ),
        attested: false,
        ...extras,
      });
    } catch {
      /* Accepted answers and unsaved edits remain visible. */
    }
  }
  const accepted = question.accepted;
  const attestationMatches =
    !!accepted &&
    attested ===
      JSON.stringify([accepted.answerId, form.getFieldValue("usedText")]);
  const writeBlocked = mutation.isPending || !!mutation.uncertain;
  return (
    <article
      className="border p-3 grid gap-3"
      aria-label={`Screening question: ${question.question}`}
    >
      <h4>{question.question}</h4>
      <p>
        Attempt {question.applicationId} · revision {question.revision}
      </p>
      <p>{question.context}</p>
      {staleEdits ? (
        <div role="alert">
          <p>
            A saved question revision changed after these local edits began.
            Your edits are retained and their original revision fence is
            preserved. Inspect the saved question and draft shown here before
            resolving the conflict.
          </p>
          <Button
            variant="outline"
            disabled={writeBlocked}
            onClick={() => rebase(editKeys, question.revision)}
          >
            Keep local edits against saved revision {question.revision}
          </Button>
        </div>
      ) : null}
      <details>
        <summary>Revise question or context</summary>
        {(["question", "context"] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <label htmlFor={`${id}-revise-${name}`}>
                Updated {name}
                <Textarea
                  id={`${id}-revise-${name}`}
                  value={field.state.value}
                  maxLength={4000}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    editRevision(
                      editKey + ":" + name,
                      event.target.value,
                      question.revision,
                    );
                  }}
                />
              </label>
            )}
          </form.Field>
        ))}
        <Button
          disabled={writeBlocked}
          onClick={() => {
            void execute("capture", {
              applicationId: question.applicationId,
              question: form.getFieldValue("question"),
              context: form.getFieldValue("context"),
            });
          }}
        >
          Save question version
        </Button>
      </details>
      <fieldset>
        <legend>Select saved supporting facts deliberately</legend>
        {read.facts.map((fact, index) => (
          <div key={fact.id}>
            <label htmlFor={`${id}-fact-${index}`}>
              <input
                id={`${id}-fact-${index}`}
                type="checkbox"
                checked={facts.includes(fact.id)}
                onChange={(event) =>
                  setFacts((current) =>
                    event.target.checked
                      ? [...current, fact.id]
                      : current.filter((ident) => ident !== fact.id),
                  )
                }
              />
              {fact.id}: {fact.text}
            </label>
            {fact.sensitive && facts.includes(fact.id) ? (
              <label htmlFor={`${id}-consent-${index}`}>
                <input
                  id={`${id}-consent-${index}`}
                  type="checkbox"
                  checked={consent[fact.id] === fact.text}
                  onChange={(event) =>
                    setConsent((current) => ({
                      ...current,
                      [fact.id]: event.target.checked ? fact.text : "",
                    }))
                  }
                />
                I deliberately authorize this sensitive value for this answer
              </label>
            ) : null}
          </div>
        ))}
      </fieldset>
      <Button
        disabled={writeBlocked}
        onClick={() => {
          void execute("draft");
        }}
      >
        Generate answer draft
      </Button>
      <details>
        <summary>Reviewed answer library</summary>
        {read.library.map((entry) => (
          <article key={entry.libraryId}>
            <p>
              {entry.answer.question} · original attempt {entry.applicationId}
            </p>
            <pre className="whitespace-pre-wrap">{entry.answer.text}</pre>
            <Button
              disabled={writeBlocked}
              onClick={() => {
                void execute("reuse", { libraryId: entry.libraryId });
              }}
            >
              Verify reuse {entry.libraryId}
            </Button>
          </article>
        ))}
      </details>
      {question.draft ? (
        <section aria-label="Answer draft">
          <h5>Draft awaiting review</h5>
          <pre className="whitespace-pre-wrap">{question.draft.text}</pre>
          {question.draft.uncertainty ? (
            <p>Uncertainty: {question.draft.uncertainty}</p>
          ) : null}
          {question.draft.staleReason ? (
            <p role="alert">
              Stale: {question.draft.staleReason}. Verify a new draft before
              review.
            </p>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              form.setFieldValue("text", question.draft!.text);
              editRevision(editKey, question.draft!.text, question.revision);
            }}
          >
            Load draft into editor
          </Button>
          <Button
            disabled={writeBlocked || !!question.draft.staleReason}
            onClick={() => {
              void execute("review", { decision: "approved" });
            }}
          >
            Approve saved draft above
          </Button>
          <Button
            disabled={writeBlocked}
            variant="outline"
            onClick={() => {
              void execute("review", { decision: "rejected" });
            }}
          >
            Reject draft
          </Button>
        </section>
      ) : null}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="text">
          {(field) => (
            <label htmlFor={`${id}-text`}>
              Edit answer draft
              <Textarea
                id={`${id}-text`}
                value={field.state.value}
                maxLength={16000}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  editRevision(editKey, event.target.value, question.revision);
                }}
              />
            </label>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.errors}>
          {(errors) =>
            errors.length ? (
              <p role="alert">Enter an answer of up to 16,000 characters.</p>
            ) : null
          }
        </form.Subscribe>
        <Button type="submit" disabled={writeBlocked}>
          Verify edited draft
        </Button>
      </form>
      {accepted ? (
        <section aria-label="Accepted screening answer">
          <h5>Reviewed answer</h5>
          <pre className="whitespace-pre-wrap">{accepted.text}</pre>
          {accepted.staleReason ? (
            <p role="alert">
              Stale: {accepted.staleReason}. The previous accepted answer
              remains available for inspection; fresh verification and review
              are required.
            </p>
          ) : null}
          <Button
            disabled={!!accepted.staleReason || writeBlocked}
            onClick={async () => {
              try {
                const text = await copyValidation.mutateAsync({
                  questionId: question.questionId,
                  answerId: accepted.answerId,
                });
                await clipboard.write(text);
                setCopyStatus(
                  "Copied reviewed answer; no manual use recorded.",
                );
              } catch {
                setCopyStatus("Copy failed; no manual use recorded.");
                useToastStore
                  .getState()
                  .toast({
                    variant: "error",
                    message: "Screening answer copy failed.",
                  });
              }
            }}
          >
            Copy reviewed answer
          </Button>
          <p role="status">{copyStatus}</p>
          <form.Field name="usedText">
            {(field) => (
              <label htmlFor={`${id}-used`}>
                Actual manually used text
                <Textarea
                  id={`${id}-used`}
                  value={field.state.value}
                  maxLength={16000}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    edit(editKey + ":used", event.target.value);
                    setAttested("");
                  }}
                />
              </label>
            )}
          </form.Field>
          <Button
            variant="outline"
            onClick={() => {
              form.setFieldValue("usedText", accepted.text);
              edit(editKey + ":used", accepted.text);
              setAttested("");
            }}
          >
            Use reviewed text for attestation
          </Button>
          <label htmlFor={`${id}-attested`}>
            <input
              id={`${id}-attested`}
              type="checkbox"
              checked={attestationMatches}
              onChange={(event) =>
                setAttested(
                  event.target.checked
                    ? JSON.stringify([
                        accepted.answerId,
                        form.getFieldValue("usedText"),
                      ])
                    : "",
                )
              }
            />
            I manually used the exact text above for this application attempt
          </label>
          <Button
            disabled={
              !attestationMatches || !!accepted.staleReason || writeBlocked
            }
            onClick={() => {
              const text = form.getFieldValue("usedText");
              if (textSchema.safeParse(text).success)
                void execute("use", { text, attested: true });
            }}
          >
            Record manual use
          </Button>
        </section>
      ) : null}
      {mutation.error ? (
        <p role="alert">
          Answer operation failed. Accepted content and local edits are
          preserved. Reload history to inspect a competing revision.
        </p>
      ) : null}
      <details>
        <summary>Inspect exact source bindings and model receipts</summary>
        <pre className="whitespace-pre-wrap break-words">
          {JSON.stringify(
            {
              draft: question.draft,
              accepted,
              captured: question.captureBinding,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}
