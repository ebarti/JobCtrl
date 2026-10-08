import { z } from "zod";
import { useForm } from "@tanstack/react-form";
import { useId, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { Button } from "../../../shared/ui/button.js";
import {
  useLocaleVariants,
  type LocaleVariant,
} from "../hooks/useResumeTemplateMaterialMutations.js";

export function MaterialLocaleVariants({
  jobKey,
}: {
  readonly jobKey: string;
}) {
  const { query, generate, review } = useLocaleVariants(jobKey);
  const locales = query.data?.locales ?? [];
  const [inputError, setInputError] = useState("");
  const form = useForm({
    defaultValues: { artifactId: "", sourceLocale: "en", targetLocale: "es" },
    onSubmit: ({ value }) => {
      const parsed = z
        .object({
          artifactId: z.string().min(1),
          sourceLocale: z.string().min(1),
          targetLocale: z.string().min(1),
          expectedRevision: z.number().int().nonnegative(),
        })
        .safeParse({ ...value, expectedRevision: query.data?.revision ?? 0 });
      if (!parsed.success || value.sourceLocale === value.targetLocale) {
        setInputError(
          "Select accepted source material and two different locales.",
        );
        return;
      }
      const sourceLocale = locales.find(
        (locale) => locale === parsed.data.sourceLocale,
      );
      const targetLocale = locales.find(
        (locale) => locale === parsed.data.targetLocale,
      );
      if (!sourceLocale || !targetLocale) {
        setInputError("Select a supported locale.");
        return;
      }
      setInputError("");
      generate.mutate({ ...parsed.data, sourceLocale, targetLocale });
    },
  });
  const error = generate.error ?? review.error ?? query.error;
  return (
    <section aria-label="Reviewed locale variants" className="section">
      <h3>Reviewed locale variants</h3>
      <p>
        Translate descriptions from accepted material. Originals remain
        available. Historical names, titles, dates and achievements stay
        source-bound.
      </p>
      {error ? <p role="alert">{error.message}</p> : null}
      {inputError ? <p role="alert">{inputError}</p> : null}
      {!query.data ? (
        <p role="status">
          Locale variants are unavailable until accepted material and a
          configured worker are available. The offline demo cannot generate
          translations.
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="artifactId">
          {(field) => (
            <LocaleChoice
              label="Accepted source"
              value={field.state.value}
              items={(query.data?.sources ?? []).map((source) => ({
                value: source.artifactId,
                label: `${source.kind} · generation ${source.generation}`,
              }))}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.Field name="sourceLocale">
          {(field) => (
            <LocaleChoice
              label="Source locale"
              value={field.state.value}
              items={locales.map((locale) => ({
                label: locale,
                value: locale,
              }))}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.Field name="targetLocale">
          {(field) => (
            <LocaleChoice
              label="Target locale"
              value={field.state.value}
              items={locales.map((locale) => ({
                label: locale,
                value: locale,
              }))}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <Button
          type="submit"
          disabled={
            !query.data?.sources.length ||
            generate.isPending ||
            review.isPending
          }
        >
          {generate.isPending ? "Translating…" : "Generate locale variant"}
        </Button>
      </form>
      <div aria-live="polite">
        {query.data?.variants.map((variant) => (
          <LocaleVariantCard
            key={variant.variantId}
            variant={variant}
            jobKey={jobKey}
            pending={review.isPending}
            onReview={(decision, terminology, formatting) =>
              review.mutate({
                variantId: variant.variantId,
                expectedRevision: query.data?.revision ?? 0,
                decision,
                terminology,
                formatting,
              })
            }
          />
        ))}
      </div>
    </section>
  );
}

export function LocaleVariantCard({
  variant,
  jobKey,
  pending,
  onReview,
}: {
  readonly variant: LocaleVariant;
  readonly jobKey: string;
  readonly pending: boolean;
  readonly onReview: (
    decision: "accepted" | "rejected",
    terminology: "confirmed" | "rejected",
    formatting: "confirmed" | "rejected",
  ) => void;
}) {
  const id = useId();
  const reviewForm = useForm({
    defaultValues: { terminology: false, formatting: false },
    onSubmit: ({ value }) => {
      if (
        z
          .object({ terminology: z.literal(true), formatting: z.literal(true) })
          .safeParse(value).success
      )
        onReview("accepted", "confirmed", "confirmed");
    },
  });
  return (
    <article aria-labelledby={id}>
      <h4 id={id}>
        {variant.binding.sourceLocale} → {variant.binding.targetLocale} ·{" "}
        {variant.binding.kind} · {variant.status}
      </h4>
      <p>
        Source generation {variant.binding.generation}. Semantic review:{" "}
        {variant.semanticReview.verdict}. Terminology:{" "}
        {variant.semanticReview.terminology}; formatting:{" "}
        {variant.semanticReview.formatting}.
      </p>
      {variant.issues.map((issue, index) => (
        <p key={index} role="note">
          <strong>{issue.kind.replaceAll("_", " ")}</strong>:{" "}
          {issue.explanation} — {issue.citation.quote}
        </p>
      ))}
      <table>
        <caption>Original and translated descriptions</caption>
        <thead>
          <tr>
            <th scope="col">Original</th>
            <th scope="col">Translation</th>
          </tr>
        </thead>
        <tbody>
          {variant.lines.map((line) => (
            <tr key={line.line_id}>
              <td>
                {variant.binding.lines.find(
                  (source) => source.line_id === line.source.source_id,
                )?.text ?? "No recorded source"}
              </td>
              <td>{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {variant.status === "candidate" ? (
        <fieldset disabled={pending}>
          <legend>Independent user review</legend>
          <reviewForm.Field name="terminology">
            {(field) => (
              <label>
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                I reviewed terminology and original credential designations
              </label>
            )}
          </reviewForm.Field>
          <reviewForm.Field name="formatting">
            {(field) => (
              <label>
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                I reviewed formatting separately
              </label>
            )}
          </reviewForm.Field>
          <reviewForm.Subscribe selector={(state) => state.values}>
            {(values) => (
              <Button
                disabled={
                  !variant.eligible || !values.terminology || !values.formatting
                }
                onClick={() => {
                  void reviewForm.handleSubmit();
                }}
              >
                Accept translation
              </Button>
            )}
          </reviewForm.Subscribe>
          <Button
            variant="outline"
            onClick={() =>
              onReview(
                "rejected",
                reviewForm.state.values.terminology ? "confirmed" : "rejected",
                reviewForm.state.values.formatting ? "confirmed" : "rejected",
              )
            }
          >
            Reject translation
          </Button>
          {!variant.eligible ? (
            <p>
              Acceptance is blocked by the recorded semantic review. User
              confirmation cannot override failed claims or create credential
              equivalence.
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {variant.status === "accepted" ? (
        <nav aria-label="Accepted locale downloads">
          {(["text", "html", "pdf", "docx"] as const)
            .filter((format) => variant.exports[format])
            .map((format) => (
              <a
                key={format}
                href={`/v1/jobs/${encodeURIComponent(jobKey)}/locale-variants/download?variantId=${encodeURIComponent(variant.variantId)}&format=${format}`}
                download
              >
                Download {format.toUpperCase()}
              </a>
            ))}
        </nav>
      ) : null}
      <details>
        <summary>Review history and provenance</summary>
        {variant.reviews.map((record, index) => (
          <p key={index}>
            {record.kind}: {record.decision} · {record.reviewedAt}
          </p>
        ))}
        <p>
          Source artifact {variant.binding.artifactId} · SHA-256{" "}
          {variant.binding.sourceHash}
        </p>
        {variant.determinations.map((record) => (
          <p key={record.determination_id}>
            {record.kind} · {record.provider}/{record.model} · schema{" "}
            {record.schema_version} · prompt {record.prompt_version} ·{" "}
            {record.determination_id}
          </p>
        ))}
      </details>
    </article>
  );
}

function LocaleChoice({
  label,
  value,
  items,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly items: { label: string; value: string }[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="field compact">
      <span>{label}</span>
      <Select
        items={items}
        value={value || null}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Select material or locale" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}
