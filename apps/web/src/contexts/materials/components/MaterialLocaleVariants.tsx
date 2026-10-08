import { useForm } from "@tanstack/react-form";
import { useEffect, useId, useState } from "react";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { useJobDetailQuery } from "../../operations/hooks/useJobDetailQuery.js";
import {
  useMaterialLocaleVariantMutation,
  type MaterialLocaleMutation,
  type MaterialLocaleState,
} from "../hooks/useResumeTemplateMaterialMutations.js";

const LocaleFormSchema = z
  .object({
    kind: z.enum(["resume", "cover_letter"]),
    source_locale: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
    target_locale: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
  })
  .strict();

export interface MaterialLocaleVariantsProps {
  readonly jobId: string;
  readonly state?: MaterialLocaleState;
}

export function MaterialLocaleVariants({
  jobId,
  state: supplied,
}: MaterialLocaleVariantsProps) {
  const detail = useJobDetailQuery(jobId);
  const [lastLoaded, setLastLoaded] = useState<{
    jobId: string;
    state: MaterialLocaleState;
  } | null>(null);
  useEffect(() => {
    if (detail.data?.localeVariants)
      setLastLoaded({ jobId, state: detail.data.localeVariants });
  }, [jobId, detail.data?.localeVariants]);
  const state = supplied ??
    detail.data?.localeVariants ??
    (lastLoaded?.jobId === jobId ? lastLoaded.state : null) ?? {
      revision: 0,
      variants: [],
      failures: [],
    };
  const mutation = useMaterialLocaleVariantMutation();
  const { session, featureFlags } = usePorts();
  const demo = featureFlags.get("demoMode", false);
  const headingId = useId();
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<string | null>(null);
  const submit = async (body: MaterialLocaleMutation) => {
    setError(null);
    try {
      await mutation.mutateAsync({ jobId, body });
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Locale operation failed. Accepted materials are preserved.",
      );
      return false;
    }
  };
  const form = useForm({
    defaultValues: { kind: "resume", source_locale: "", target_locale: "" },
    onSubmit: async ({ value }) => {
      const signature = JSON.stringify(value);
      const id =
        signature === lastInput && requestId
          ? requestId
          : session.newRequestId?.();
      if (!id) {
        setError("Request identifiers are unavailable in this session.");
        return;
      }
      const parsed = LocaleFormSchema.safeParse(value);
      if (
        !parsed.success ||
        value.source_locale.toLowerCase() === value.target_locale.toLowerCase()
      ) {
        setError(
          "Choose different explicit source and target locale tags, such as en and es.",
        );
        return;
      }
      setRequestId(id);
      setLastInput(signature);
      if (
        await submit({
          operation: "generate",
          ...parsed.data,
          expected_revision: state.revision,
          request_id: id,
        })
      )
        setRequestId(null);
    },
  });
  const unavailable = Boolean(detail.error || detail.data?.localeVariantsError);
  const busy = mutation.isPending || demo || unavailable;
  return (
    <section className="section" aria-labelledby={headingId}>
      <h3 id={headingId}>Reviewed locale variants</h3>
      <p>
        Translate accepted resumes or letters while keeping the original.
        Historical names, titles, dates and achievements keep their original
        wording and values.
      </p>
      {demo ? (
        <p role="status">
          Locale generation, review and export are unavailable in the offline
          demo.
        </p>
      ) : null}
      {unavailable ? (
        <p role="alert">
          Locale history or its recorded authority could not be loaded. Original
          materials and last loaded previews remain available. Reload before
          reviewing.
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="kind">
          {(field) => (
            <label className="field">
              Material
              <select
                value={field.state.value}
                disabled={busy}
                onChange={(event) => field.handleChange(event.target.value)}
              >
                <option value="resume">Resume</option>
                <option value="cover_letter">Cover letter</option>
              </select>
            </label>
          )}
        </form.Field>
        <form.Field name="source_locale">
          {(field) => (
            <label className="field">
              Source locale
              <Input
                value={field.state.value}
                placeholder="en"
                disabled={demo}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
          )}
        </form.Field>
        <form.Field name="target_locale">
          {(field) => (
            <label className="field">
              Target locale
              <Input
                value={field.state.value}
                placeholder="es"
                disabled={demo}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
          )}
        </form.Field>
        <Button type="submit" disabled={busy || Boolean(detail.error)}>
          Generate locale variant
        </Button>
      </form>
      {mutation.isPending ? (
        <p role="status">Saving locale operation…</p>
      ) : null}
      {error ? (
        <p role="alert">
          {error} Your draft and accepted materials remain available.
        </p>
      ) : null}
      {state.failures.length ? (
        <details>
          <summary>Failed locale operations ({state.failures.length})</summary>
          <ul>
            {state.failures.map((failure, index) => (
              <li key={`${failure.at}:${index}`}>
                {failure.operation}: {failure.code} ({failure.at})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {!state.variants.length && !unavailable ? (
        <p>No recorded locale variants.</p>
      ) : null}
      {[...state.variants].reverse().map((variant) => {
        const stale = Boolean(variant.stale_reasons?.length);
        const canReview =
          variant.status === "candidate" &&
          variant.gate_passed &&
          !stale &&
          !busy;
        return (
          <article
            key={variant.variant_id}
            className="section"
            aria-label={`${variant.kind} ${variant.target_locale} generation ${variant.locale_generation}`}
          >
            <h4>
              {variant.kind === "resume" ? "Resume" : "Cover letter"}:{" "}
              {variant.source_locale} → {variant.target_locale} · generation{" "}
              {variant.locale_generation}
            </h4>
            <p>
              Status: {variant.status}. Semantic gates:{" "}
              {variant.gate_passed ? "passed" : "not passed"}.
            </p>
            <p>
              Terminology review: {variant.terminology_review}. Formatting
              review: {variant.formatting_review}.
            </p>
            {stale ? (
              <p role="status">
                Inputs changed: {variant.stale_reasons?.join(", ")}. Generate a
                fresh variant to review or export. Accepted history remains
                available.
              </p>
            ) : null}
            <details>
              <summary>Original accepted material</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {variant.text}
              </pre>
            </details>
            <div lang={variant.target_locale}>
              <h5>Translated preview</h5>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {variant.lines.map((line) => line.text).join("\n") ||
                  "The model refused this locale."}
              </pre>
            </div>
            <details style={{ overflowWrap: "anywhere" }}>
              <summary>Source and translation authority</summary>
              <p>
                Source artifact {variant.artifact_id}, generation{" "}
                {variant.generation}, recorded state {variant.source_status},
                created {variant.source_created_at}, SHA-256 {variant.sha256}.
                Profile version {variant.profile_version}.
              </p>
              <ul>
                {variant.determinations.map((determination) => (
                  <li key={determination.determination_id}>
                    {determination.kind}: {determination.provider}/
                    {determination.model}, {determination.prompt_version},
                    fingerprint {determination.input_fingerprint}
                  </li>
                ))}
              </ul>
              <ul>
                {variant.lines.map((line) => (
                  <li key={line.line_id}>
                    {line.line_id}: {line.source.quote}
                  </li>
                ))}
              </ul>
            </details>
            {variant.concerns.length ? (
              <div>
                <h5>Unresolved terminology and credentials</h5>
                <ul>
                  {variant.concerns.map((concern, index) => (
                    <li key={index}>
                      {concern.kind}: {concern.explanation} Original:{" "}
                      {concern.source.quote}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(["terminology", "formatting"] as const).map((reviewKind) => (
              <span key={reviewKind}>
                <Button
                  variant="outline"
                  disabled={!canReview}
                  onClick={() => {
                    void submit({
                      operation: "review",
                      variant_id: variant.variant_id,
                      expected_revision: state.revision,
                      expected_variant_revision: variant.revision,
                      review_kind: reviewKind,
                      decision: "accepted",
                    });
                  }}
                >
                  Accept {reviewKind}
                </Button>
                <Button
                  variant="outline"
                  disabled={variant.status !== "candidate" || stale || busy}
                  onClick={() => {
                    void submit({
                      operation: "review",
                      variant_id: variant.variant_id,
                      expected_revision: state.revision,
                      expected_variant_revision: variant.revision,
                      review_kind: reviewKind,
                      decision: "rejected",
                    });
                  }}
                >
                  Reject {reviewKind}
                </Button>
              </span>
            ))}
            {variant.status === "accepted" ? (
              <div>
                {(["text", "html", "pdf", "docx"] as const).map((format) => (
                  <Button
                    key={format}
                    variant="outline"
                    disabled={busy || stale}
                    onClick={() => {
                      void submit({
                        operation: "export",
                        variant_id: variant.variant_id,
                        expected_revision: state.revision,
                        expected_variant_revision: variant.revision,
                        export_format: format,
                      });
                    }}
                  >
                    Export {format.toUpperCase()}
                  </Button>
                ))}
                <ul>
                  {variant.exports.map((output) => (
                    <li key={output.export_id}>
                      <a
                        href={`/v1/jobs/${encodeURIComponent(jobId)}/locale-variants/exports/${output.export_id}`}
                        download
                      >
                        {output.format.toUpperCase()} · accepted revision{" "}
                        {output.accepted_revision}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
