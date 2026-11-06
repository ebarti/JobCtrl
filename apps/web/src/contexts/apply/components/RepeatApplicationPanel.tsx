import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { z } from "zod";

import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import type { ApplyReviewSession } from "../hooks/useApplyReviewSession.js";

const reasonSchema = z.string().trim().min(1).max(4000);

export function RepeatApplicationPanel({
  session,
}: {
  readonly session: ApplyReviewSession;
}) {
  const id = useId();
  const { requestIdentity, featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "checkRepeatApplication");
  const query = session.repeatQuery;
  const assessment = query.data;
  const form = useForm({
    defaultValues: { reason: session.draft.repeatReason },
    validators: {
      onSubmit: ({ value }) =>
        reasonSchema.safeParse(value.reason).success
          ? undefined
          : "Enter a reason for this one-use exception.",
    },
    onSubmit: async ({ value }) => {
      const parsed = reasonSchema.safeParse(value.reason);
      if (
        !parsed.success ||
        !assessment?.checkId ||
        assessment.status !== "same_employer_equivalent_role" ||
        assessment.override
      )
        return;
      await session.command({
        kind: "repeat_override",
        body: {
          expectedCheckId: assessment.checkId,
          evidenceSha256: assessment.evidenceSha256,
          reason: parsed.data,
          idempotencyKey: requestIdentity.create(),
        },
      });
    },
  });
  return (
    <section className="grid gap-3" aria-label="Repeat application review">
      <h4>Prior application check</h4>
      {query.isPending ? (
        <p role="status">Loading prior application evidence…</p>
      ) : null}
      {query.error ? (
        <p role="alert">
          Prior application evidence could not be refreshed. Execution remains
          blocked until the current assessment is available.
        </p>
      ) : null}
      {assessment ? (
        <>
          <p>
            {assessment.status === "clear"
              ? "No repeat-application risk is recorded for the current evidence."
              : assessment.status === "same_opening"
                ? "A confirmed application already exists for this exact opening. Another submission is blocked."
                : assessment.status === "check_required"
                  ? "Confirmed application history needs a source-bound assessment before this opening can proceed."
                  : assessment.status === "uncertain"
                    ? "The relationship to prior applications remains uncertain. Another assessment is required; no exception is available for uncertainty."
                    : "A source-bound assessment found a prior application to the same employer for an equivalent role at a different opening."}
          </p>
          {assessment.blockReason ? (
            <p role="alert">Application gate: {assessment.blockReason}</p>
          ) : null}
          {assessment.matchedApplications.length ? (
            <ul>
              {assessment.matchedApplications.map((jobId) => (
                <li key={jobId}>
                  <Link to="/jobs/$jobId" params={{ jobId }}>
                    Inspect confirmed application {jobId}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {assessment.override ? (
            <p>
              One-use exception {assessment.override.overrideId} ·{" "}
              {assessment.override.usedByRunId
                ? `used by run ${assessment.override.usedByRunId}`
                : "unused"}{" "}
              · {assessment.override.createdAt}
            </p>
          ) : null}
          <details>
            <summary>Assessment provenance</summary>
            <p>Check {assessment.checkId ?? "not required"}</p>
            <p className="mono break-all">
              Evidence SHA-256: {assessment.evidenceSha256}
            </p>
            {assessment.determinationIds?.map((determinationId) => (
              <p key={determinationId}>Model determination {determinationId}</p>
            ))}
          </details>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void query.refetch();
          }}
        >
          Reload prior application evidence
        </Button>
        {assessment?.status !== "same_opening" ? (
          <Button
            type="button"
            variant="outline"
            aria-describedby={availability.available ? undefined : `${id}-repeat-unavailable`}
            disabled={session.blocked || session.externallyBound || !availability.available}
            onClick={() => {
              if (!availability.available) return;
              void session.command({
                kind: "repeat_check",
                idempotencyKey: requestIdentity.create(),
              });
            }}
          >
            Assess repeat application risk
          </Button>
        ) : null}
      </div>
      {assessment?.status !== "same_opening" && !availability.available ? (
        <p id={`${id}-repeat-unavailable`}>{availability.reason}</p>
      ) : null}
      {assessment?.status === "same_employer_equivalent_role" &&
      !assessment.override ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <p>
            A reasoned exception applies once to this exact assessed history and
            different opening. It never permits another submission to the same
            opening or after submit intent.
          </p>
          <form.Field name="reason">
            {(field) => (
              <label htmlFor={`${id}-reason`}>
                Reason for a one-use application exception
                <Textarea
                  id={`${id}-reason`}
                  value={field.state.value}
                  maxLength={4000}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    session.edit({ repeatReason: event.target.value });
                  }}
                />
              </label>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.errors}>
            {(errors) =>
              errors.length ? <p role="alert">A reason is required.</p> : null
            }
          </form.Subscribe>
          <Button
            type="submit"
            variant="warning"
            disabled={
              session.blocked || session.externallyBound || query.isError
            }
          >
            Record one-use exception
          </Button>
        </form>
      ) : null}
    </section>
  );
}
