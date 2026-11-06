import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import type { Application } from "../contracts.js";
import {
  useApplyReviewSession,
  type ApplyReviewSession,
} from "../hooks/useApplyReviewSession.js";
import { ApplyReviewDecisionControls } from "./ApplyReviewDecisionControls.js";
import { RepeatApplicationPanel } from "./RepeatApplicationPanel.js";

const preparationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("browser"),
    recipient: z.string(),
    subject: z.string(),
    body: z.string(),
  }),
  z.object({
    mode: z.literal("email"),
    recipient: z.email().max(320),
    subject: z.string().min(1).max(998),
    body: z.string().min(1).max(32000),
  }),
]);

export function ApplicationPanel({ jobId }: { readonly jobId: string }) {
  const session = useApplyReviewSession(jobId);
  const application = session.application;
  const [copyStatus, setCopyStatus] = useState("");
  const { clipboard } = usePorts();
  return (
    <section className="section grid gap-4" aria-label="Application review">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 data-typography="component-title">Application review</h3>
        <Button
          variant="outline"
          onClick={() => {
            void session.query.refetch();
          }}
        >
          Reload application
        </Button>
      </div>
      {session.query.isPending ? (
        <p role="status">Loading application evidence…</p>
      ) : null}
      {session.query.error ? (
        <p role="alert">
          Application evidence could not be refreshed. Retained payloads and
          local edits remain available; reload before changing approval or
          execution.
        </p>
      ) : null}
      {application ? (
        <>
          <p>
            State: <strong>{application.status}</strong> · saved version{" "}
            {application.version}
            {application.stopped ? " · application stopped" : ""}
          </p>
          {session.externallyBound ? (
            <div role="alert" className="status-line">
              <strong>
                {application.receipt || application.confirmedApplication
                  ? "Submission confirmed"
                  : "Submission requires verification"}
              </strong>
              <p>
                {application.receipt || application.confirmedApplication
                  ? "A confirmed application is retained. Another submission cannot be authorized for this opening."
                  : "A submit intent or an uncertain outcome is retained. Do not send again. Inspect the receipt and record the actual outcome when independently known."}
              </p>
            </div>
          ) : null}
          {application.approvalBlockReason ? (
            <p role="alert">
              {application.approvalBlockReason ===
              "application_request_predates_stop" ? (
                "This payload predates a saved application stop. Prepare a fresh application payload after releasing the stop; the prior payload and review history remain inspectable."
              ) : (
                <>
                  Current application sources cannot authorize approval or
                  execution: {application.approvalBlockReason}. The previous
                  payload and review history remain inspectable.
                </>
              )}
            </p>
          ) : null}
          <RepeatApplicationPanel session={session} />
          <ApplicationPreparation key={jobId} session={session} />
          {session.payload ? (
            <section
              className="grid gap-3"
              aria-label="Exact prepared application payload"
            >
              <h4>Exact prepared payload</h4>
              <p>
                Destination:{" "}
                <span className="break-all">
                  {session.payload.applicationUrl}
                </span>{" "}
                · {session.payload.mode}
              </p>
              <dl className="grid gap-1 text-sm">
                <dt>Payload identifier</dt>
                <dd className="mono break-all">{session.payload.payloadId}</dd>
                <dt>Payload SHA-256</dt>
                <dd className="mono break-all">
                  {session.payload.payloadSha256}
                </dd>
                <dt>Profile revision</dt>
                <dd>{session.payload.sources.profile.revision}</dd>
                <dt>Posting revision</dt>
                <dd>{session.payload.sources.job.revision}</dd>
                <dt>Accepted resume revision</dt>
                <dd className="break-all">
                  {session.payload.sources.resume.revisionId}
                </dd>
                <dt>Accepted PDF SHA-256</dt>
                <dd className="mono break-all">
                  {session.payload.sources.resume.pdf.sha256}
                </dd>
              </dl>
              <p>
                The resume is the accepted revision shown in Resumes. Its exact
                PDF bytes and source revisions are checked again before approval
                and execution.
              </p>
              {session.payload.mode === "email" ? (
                <section aria-label="Exact outgoing email">
                  <h5>Email preview</h5>
                  <p>To: {session.payload.recipient}</p>
                  <p>Subject: {session.payload.subject}</p>
                  <pre className="whitespace-pre-wrap break-words">
                    {session.payload.body}
                  </pre>
                  <p>
                    Attachment: {session.payload.attachmentName} ·{" "}
                    {session.payload.sources.resume.pdf.sizeBytes} bytes
                  </p>
                </section>
              ) : null}
              <section aria-label="Prepared profile fields">
                <h5>Prepared fields</h5>
                {session.payload.fields.length ? (
                  <dl className="grid gap-2">
                    {session.payload.fields.map((field) => (
                      <div key={field.path}>
                        <dt>
                          {field.label}{" "}
                          <span className="text-sm">({field.path})</span>
                        </dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {field.value}{" "}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!application.approvalBlockReason}
                            onClick={async () => {
                              try {
                                await clipboard.write(field.value);
                                setCopyStatus(`Copied ${field.label}.`);
                              } catch {
                                setCopyStatus(`Could not copy ${field.label}.`);
                              }
                            }}
                          >
                            Copy {field.label}
                          </Button>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p>No profile fields prepared.</p>
                )}
                <p role="status">{copyStatus}</p>
              </section>
              <section aria-label="Prepared screening answers">
                <h5>Reviewed screening answers in this payload</h5>
                {session.payload.screeningAnswers.length ? (
                  session.payload.screeningAnswers.map((answer) => (
                    <article key={answer.questionId}>
                      <h6>{answer.question}</h6>
                      <pre className="whitespace-pre-wrap break-words">
                        {answer.text}
                      </pre>
                      <p>
                        Answer revision {answer.revision} · review{" "}
                        {answer.reviewId}
                      </p>
                    </article>
                  ))
                ) : (
                  <p>
                    No reviewed screening answers are bound to this payload.
                  </p>
                )}
              </section>
              <Button
                variant="outline"
                disabled={
                  session.blocked ||
                  session.externallyBound ||
                  application.approvalBlockReason ===
                    "application_request_predates_stop" ||
                  application.stopped
                }
                onClick={session.rehearse}
              >
                Run application rehearsal
              </Button>
              <ApplyReviewDecisionControls session={session} />
              {session.approval ? (
                <section
                  className="grid gap-3"
                  aria-label="Approved application execution"
                >
                  <p>
                    Approval {session.approval.decisionId} is bound to this
                    exact payload and rehearsal.
                  </p>
                  <Button
                    disabled={
                      session.blocked ||
                      session.repeatBlocked ||
                      session.draft.preparationEdited ||
                      session.externallyBound ||
                      application.stopped
                    }
                    onClick={session.execute}
                  >
                    {session.payload.mode === "email"
                      ? "Send approved application email"
                      : "Prepare assisted browser application"}
                  </Button>
                </section>
              ) : null}
              {application.status === "manual_required" &&
              session.payload.mode === "browser" ? (
                <section
                  className="grid gap-2"
                  aria-label="Manual browser submission"
                >
                  <p>
                    The browser application needs your manual completion and
                    final submission. JobCtrl has not submitted it or marked it
                    applied. The extension may copy or fill reviewed values; it
                    has no authority to perform final submission.
                  </p>
                  {browserHref(session.payload.applicationUrl) ? (
                    <a
                      href={session.payload.applicationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="title-link"
                    >
                      Open application destination
                    </a>
                  ) : (
                    <p role="alert">
                      The saved destination cannot be opened as a browser page.
                    </p>
                  )}
                  <p>
                    Download the accepted resume in Resumes, complete the
                    destination, then record the actual outcome in the
                    application timeline.
                  </p>
                  <Link to="/jobs/$jobId" params={{ jobId }}>
                    Open job and application timeline
                  </Link>
                </section>
              ) : null}
              <details>
                <summary>Exact source bindings</summary>
                <pre className="whitespace-pre-wrap break-words">
                  {JSON.stringify(session.payload.sources, null, 2)}
                </pre>
              </details>
            </section>
          ) : (
            <p>
              Review and accept a rendered resume in Resumes, then prepare an
              application payload.
            </p>
          )}
          <ApplicationExecution session={session} />
          <ApplicationHistory application={application} />
        </>
      ) : null}
      {session.mutation.uncertain ? (
        <div role="alert" className="grid gap-2">
          <p>
            The last {session.mutation.uncertain.kind} request has an
            unconfirmed result. Its identity and exact input are retained.
            Reload evidence, then reconcile this same request before creating
            another one.
          </p>
          <Button
            variant="outline"
            disabled={session.mutation.isPending}
            onClick={() => {
              if (session.mutation.uncertain)
                void session.command(session.mutation.uncertain);
            }}
          >
            Reconcile same request
          </Button>
        </div>
      ) : session.mutation.error ? (
        <p role="alert">
          {session.mutation.error.message} Saved evidence and local edits are
          preserved. Reload before retrying a changed version.
        </p>
      ) : null}
    </section>
  );
}

function ApplicationPreparation({ session }: { session: ApplyReviewSession }) {
  const id = useId();
  const { requestIdentity } = usePorts();
  const inspectedEmail = session.rehearsal?.inspection?.emailCandidate;
  const form = useForm({
    defaultValues: {
      mode: session.draft.mode,
      recipient: session.draft.recipient,
      subject: session.draft.subject,
      body: session.draft.body,
    },
    validators: {
      onSubmit: ({ value }) =>
        preparationSchema.safeParse(value).success
          ? undefined
          : "Enter the recipient, subject and complete email body.",
    },
    onSubmit: async ({ value }) => {
      const parsed = preparationSchema.safeParse(value);
      const application = session.application;
      if (
        !parsed.success ||
        !application ||
        session.blocked ||
        session.externallyBound ||
        application.stopped
      )
        return;
      await session.command({
        kind: "prepare",
        body: {
          expectedVersion: application.version,
          idempotencyKey: requestIdentity.create(),
          mode: parsed.data.mode,
          ...(parsed.data.mode === "email"
            ? {
                recipient: parsed.data.recipient,
                subject: parsed.data.subject,
                body: parsed.data.body,
              }
            : {}),
        },
      });
    },
  });
  return (
    <details
      open={
        !session.payload || session.draft.preparationEdited || !!inspectedEmail
      }
    >
      <summary>
        {session.payload
          ? "Prepare a replacement payload"
          : "Prepare application"}
      </summary>
      <p>
        A new payload replaces the current candidate and revokes its prior
        approval. Editing here preserves your draft until you deliberately
        prepare it.
      </p>
      {session.draft.preparationEdited ? (
        <p role="status">
          Preparation edits are pending. Prepare a new payload or discard those
          edits before approval or execution.
        </p>
      ) : null}
      {inspectedEmail ? (
        <section className="grid gap-2" aria-label="Inspected email candidate">
          <h5>Inspected email candidate</h5>
          <p>Recipient: {inspectedEmail.recipient}</p>
          <p>Subject: {inspectedEmail.subject}</p>
          <pre className="whitespace-pre-wrap break-words">
            {inspectedEmail.body}
          </pre>
          <p>
            Attachment: {inspectedEmail.attachmentName}. A new prepared payload,
            email rehearsal and approval are required.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={session.blocked || session.externallyBound}
            onClick={() => {
              const values = {
                mode: "email" as const,
                recipient: inspectedEmail.recipient,
                subject: inspectedEmail.subject,
                body: inspectedEmail.body,
              };
              form.reset(values);
              session.edit({
                ...values,
                preparationEdited: true,
                reviewedHash: "",
              });
            }}
          >
            Load inspected email candidate into preparation
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
        <form.Field name="mode">
          {(field) => (
            <label htmlFor={`${id}-mode`}>
              Application mode
              <select
                id={`${id}-mode`}
                value={field.state.value}
                onChange={(event) => {
                  const mode =
                    event.target.value === "email" ? "email" : "browser";
                  field.handleChange(mode);
                  session.edit({ mode, preparationEdited: true });
                }}
              >
                <option value="browser">
                  Assisted browser, manual final submission
                </option>
                <option value="email">
                  Email with accepted resume attachment
                </option>
              </select>
            </label>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.mode}>
          {(mode) =>
            mode === "email" ? (
              <>
                {(["recipient", "subject", "body"] as const).map((name) => (
                  <form.Field key={name} name={name}>
                    {(field) => (
                      <label htmlFor={`${id}-${name}`}>
                        {name === "recipient"
                          ? "Recipient email"
                          : name === "subject"
                            ? "Email subject"
                            : "Complete outgoing email body"}
                        {name === "body" ? (
                          <Textarea
                            id={`${id}-${name}`}
                            value={field.state.value}
                            maxLength={32000}
                            onBlur={field.handleBlur}
                            onChange={(event) => {
                              field.handleChange(event.target.value);
                              session.edit({
                                [name]: event.target.value,
                                preparationEdited: true,
                              });
                            }}
                          />
                        ) : (
                          <Input
                            id={`${id}-${name}`}
                            type={name === "recipient" ? "email" : "text"}
                            value={field.state.value}
                            maxLength={name === "recipient" ? 320 : 998}
                            onBlur={field.handleBlur}
                            onChange={(event) => {
                              field.handleChange(event.target.value);
                              session.edit({
                                [name]: event.target.value,
                                preparationEdited: true,
                              });
                            }}
                          />
                        )}
                      </label>
                    )}
                  </form.Field>
                ))}
              </>
            ) : (
              <p>
                Browser rehearsal inspects the exact destination with an empty
                browser. Final submission remains manual.
              </p>
            )
          }
        </form.Subscribe>
        <form.Subscribe selector={(state) => state.errors}>
          {(errors) =>
            errors.length ? (
              <p role="alert">
                Enter a valid recipient, subject and complete email body.
              </p>
            ) : null
          }
        </form.Subscribe>
        {session.payload?.mode === "email" ? (
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              const payload = session.payload!;
              form.setFieldValue("mode", "email");
              form.setFieldValue("recipient", payload.recipient ?? "");
              form.setFieldValue("subject", payload.subject ?? "");
              form.setFieldValue("body", payload.body ?? "");
              session.edit({
                mode: "email",
                recipient: payload.recipient ?? "",
                subject: payload.subject ?? "",
                body: payload.body ?? "",
                preparationEdited: false,
              });
            }}
          >
            Load prepared email into editor
          </Button>
        ) : null}
        {session.draft.preparationEdited ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const payload = session.payload;
              const values = {
                mode: payload?.mode ?? ("browser" as const),
                recipient: payload?.recipient ?? "",
                subject: payload?.subject ?? "",
                body: payload?.body ?? "",
              };
              form.reset(values);
              session.edit({ ...values, preparationEdited: false });
            }}
          >
            Discard preparation edits
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={
            session.blocked ||
            session.externallyBound ||
            session.application?.stopped
          }
        >
          {session.mutation.isPending
            ? "Saving application…"
            : "Prepare exact application payload"}
        </Button>
      </form>
    </details>
  );
}

function ApplicationExecution({ session }: { session: ApplyReviewSession }) {
  const application = session.application;
  if (!application) return null;
  const writeBlocked =
    session.query.isError ||
    session.mutation.isPending ||
    !!session.mutation.uncertain;
  return (
    <section className="grid gap-3" aria-label="Application execution controls">
      {session.actionRun.data ? (
        <p role="status">
          Action {session.actionRun.data.action} ·{" "}
          {session.actionRun.data.status} · {session.actionRun.data.runId}
          {session.actionRun.data.cancellationRequested
            ? " · cancellation requested"
            : ""}
        </p>
      ) : null}
      {session.actionRun.error ? (
        <p role="alert">
          Action status is unavailable. Reload before starting another action.
        </p>
      ) : null}
      {session.actionRun.data?.errorCode ? (
        <p role="alert">
          Action failed: {session.actionRun.data.errorCode}. Retained payload
          and approval history remain available.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="warning"
          disabled={writeBlocked || application.stopped}
          onClick={() => session.control("skip")}
        >
          Skip application
        </Button>
        <Button
          variant="warning"
          disabled={writeBlocked || application.stopped}
          onClick={() => session.control("cancel")}
        >
          Stop application
        </Button>
        {session.active ? (
          <Button
            variant="outline"
            disabled={writeBlocked}
            onClick={session.cancelRun}
          >
            Request action cancellation
          </Button>
        ) : null}
        {application.stopped ? (
          <Button
            variant="outline"
            disabled={writeBlocked || session.externallyBound || session.active}
            onClick={() => session.control("reset")}
          >
            Release application stop
          </Button>
        ) : null}
      </div>
      <p>
        Stopping prevents further admission. A submission already sent or with
        an uncertain result remains protected from retries.
      </p>
    </section>
  );
}

export function ApplicationHistory({
  application,
}: {
  application: Application;
}) {
  return (
    <details>
      <summary>Application, review and rehearsal history</summary>
      {application.intent ? (
        <p>
          Submit intent {application.intent.intentId} · run{" "}
          {application.intent.runId} · {application.intent.createdAt}
        </p>
      ) : null}
      {application.receipt ? (
        <p>
          Confirmed submission receipt · run {application.receipt.runId} ·{" "}
          {application.receipt.recordedAt}
        </p>
      ) : null}
      <ol>
        {application.decisions.map((decision) => (
          <li key={decision.decisionId}>
            {decision.decision} · {decision.decidedAt}
            {decision.reason ? <p>{decision.reason}</p> : null}
            <details>
              <summary>Exact approval bindings</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(decision, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
      <ol>
        {application.rehearsals.map((run) => (
          <li key={run.rehearsalId}>
            {run.status} rehearsal · {run.coverage} coverage · {run.finishedAt}
            <details>
              <summary>Rehearsal evidence {run.rehearsalId}</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(run, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
      <ol>
        {application.runs.map((run) => (
          <li key={run.runId}>
            {run.status} · {run.mode} · {run.startedAt}
            <details>
              <summary>Execution {run.runId}</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(run, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}

function browserHref(value: string) {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
