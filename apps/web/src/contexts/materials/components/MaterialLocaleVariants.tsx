import { z } from "zod";
import { useForm } from "@tanstack/react-form";
import { useId, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
import { useMaterialLocaleVariants, type LocaleHistory, type LocaleRequest, type LocaleVariant } from "../hooks/useGenerateMaterialsMutation.js";

const selectionSchema = z.object({ sourceArtifactId: z.string().min(1), sourceLocale: z.string().min(2), targetLocale: z.string().min(2) });

export function MaterialLocaleVariants({ jobId }: { readonly jobId: string }) {
  const { history, mutation, exportAndOpen, openRetainedExport } = useMaterialLocaleVariants(jobId);
  const [openError, setOpenError] = useState<string | null>(null);
  return <section aria-label="Reviewed locale variants" className="section space-y-4">
    <h3>Reviewed locale variants</h3>
    <p>Translate accepted resume or cover-letter descriptions. Original historical names, titles, credentials, dates and achievements remain unchanged. Locale acceptance is separate from application approval.</p>
    {history.error ? <p role="alert">Locale history unavailable. Existing accepted artifacts remain intact.</p> : null}
    {mutation.error ? <p role="alert">Locale operation failed: {mutation.error.message}. Accepted revisions remain available.</p> : null}
    {openError ? <p role="alert">{openError}</p> : null}
    {!history.data ? (history.isPending ? <p role="status">Loading locale history…</p> : null) : <MaterialLocalePanel history={history.data} pending={mutation.isPending}
      onOpenExport={(artifactId) => { setOpenError(null); void openRetainedExport(artifactId).catch(() => setOpenError("Opening failed. The retained export remains registered.")); }}
      onRequest={(request) => mutation.mutate(request)} onExport={(request) => {
        setOpenError(null); void exportAndOpen(request).catch(() => setOpenError("Export or opening failed. Previous exports remain available."));
      }} />}
  </section>;
}

export function MaterialLocalePanel({ history, pending, onRequest, onExport, onOpenExport }: {
  readonly history: LocaleHistory; readonly pending: boolean;
  readonly onRequest: (request: LocaleRequest) => void;
  readonly onExport: (request: Extract<LocaleRequest, { operation: "export" }>) => void;
  readonly onOpenExport?: ((artifactId: string) => void) | undefined;
}) {
  const id = useId();
  const form = useForm({ defaultValues: { sourceArtifactId: history.sources[0]?.artifactId ?? "", sourceLocale: "en", targetLocale: "es" },
    onSubmit: ({ value }) => {
      const source = history.sources.find(row => row.artifactId === value.sourceArtifactId);
      const parsed = selectionSchema.safeParse(value);
      if (parsed.success && !pending && source && history.profileVersion) onRequest({ operation: "generate", ...parsed.data, expectedGeneration: source.generation, expectedProfileVersion: history.profileVersion });
    },
  });
  return <>
    <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="sourceArtifactId">{field => <LocaleSelect id={`${id}-source`} label="Accepted source" value={field.state.value} disabled={pending} onChange={field.handleChange} items={history.sources.map(source => ({ value: source.artifactId, label: `${source.kind === "tailored_resume" ? "Resume" : "Cover letter"} · generation ${source.generation}` }))} />}</form.Field>
      <form.Field name="sourceLocale">{field => <LocaleSelect id={`${id}-from`} label="Source language" value={field.state.value} disabled={pending} onChange={field.handleChange} items={history.supportedLocales.map(locale => ({ value: locale, label: locale }))} />}</form.Field>
      <form.Field name="targetLocale">{field => <LocaleSelect id={`${id}-to`} label="Target language" value={field.state.value} disabled={pending} onChange={field.handleChange} items={history.supportedLocales.map(locale => ({ value: locale, label: locale }))} />}</form.Field>
      <Button type="submit" disabled={pending || !history.sources.length || !history.profileVersion}>Generate locale variant</Button>
      {!history.sources.length ? <p>Accept source material before requesting a translation.</p> : null}
    </form>
    {history.variants.length ? history.variants.map(variant => <LocaleRevision key={variant.revisionId} variant={variant} pending={pending} onRequest={onRequest} onExport={onExport} onOpenExport={onOpenExport} />) : <p>No locale variants recorded.</p>}
  </>;
}

function LocaleSelect({ id, label, value, disabled, items, onChange }: {
  readonly id: string; readonly label: string; readonly value: string; readonly disabled: boolean;
  readonly items: { value: string; label: string }[]; readonly onChange: (value: string) => void;
}) {
  return <div><label htmlFor={id}>{label}</label><Select value={value} disabled={disabled} items={items} onValueChange={next => { if (next !== null) onChange(next); }}>
    <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select></div>;
}

function LocaleRevision({ variant, pending, onRequest, onExport, onOpenExport }: {
  readonly variant: LocaleVariant; readonly pending: boolean;
  readonly onRequest: (request: LocaleRequest) => void;
  readonly onExport: (request: Extract<LocaleRequest, { operation: "export" }>) => void;
  readonly onOpenExport?: ((artifactId: string) => void) | undefined;
}) {
  const binding = { revisionId: variant.revisionId, expectedVersion: variant.version };
  const reviewForm = useForm({ defaultValues: { note: "" } });
  const id = useId();
  const latest = Object.fromEntries(variant.reviews.map(row => [row.dimension, row.decision]));
  const rejected = variant.acceptanceHistory.some(row => row.decision === "rejected");
  return <article className="space-y-3 border p-3" aria-label={`${variant.sourceLocale} to ${variant.targetLocale} locale revision`}>
    <h4>{variant.sourceLocale} → {variant.targetLocale} · {variant.accepted ? "Accepted" : rejected ? "Rejected" : "Awaiting review"}</h4>
    <p>Source generation {variant.source.generation} · profile version {variant.profileVersion} · translator {variant.provider}/{variant.model}</p>
    <div className="grid gap-3 md:grid-cols-2"><div><h5>Original accepted source</h5><pre className="whitespace-pre-wrap break-words">{variant.source.text}</pre></div><div><h5>Translated descriptions</h5><pre lang={variant.targetLocale} className="whitespace-pre-wrap break-words">{variant.text}</pre></div></div>
    <p>Independent semantic verification: {variant.authorityStatus === "recorded" ? variant.verificationVerdict : "Recorded authority unavailable"}</p>
    {variant.findings.map((finding, index) => <p key={index} role="status">{finding.kind.replaceAll("_", " ")}: {finding.detail} · {finding.source.quote}</p>)}
    <details><summary>Recorded verification sources</summary><p>Translation {variant.translationId ?? "unavailable"} · verification {variant.verificationId ?? "unavailable"}</p><p>Prompt {variant.promptVersion} · schema {variant.schemaVersion} · source hash {variant.source.sha256}</p>
      {variant.lines.map(line => <div key={line.line_id}><p>{line.text}</p><blockquote>{line.source.quote}</blockquote><p>{line.fact_ids.length ? line.fact_ids.map(factId => variant.facts.find(fact => fact.source_id === factId)?.text ?? "No recorded source").join("; ") : "No recorded canonical fact"}</p><p>{variant.verification.find(row => row.line_id === line.line_id)?.reason ?? "No recorded verification"}</p></div>)}
    </details>
    {!variant.accepted && !rejected ? <>
      <reviewForm.Field name="note">{field => <label htmlFor={`${id}-note`}>Review note<textarea id={`${id}-note`} maxLength={2000} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</reviewForm.Field>
      {(["terminology", "formatting"] as const).map(dimension => <div key={dimension}><p>{dimension}: {latest[dimension] ?? "Not reviewed"}</p>
        {(["accepted", "rejected"] as const).map(decision => <Button key={decision} type="button" variant="outline" disabled={pending} onClick={() => onRequest({ operation: "review", ...binding, dimension, decision, note: reviewForm.getFieldValue("note") })}>{decision === "accepted" ? "Approve" : "Reject"} {dimension}</Button>)}
      </div>)}
      <Button type="button" disabled={pending || variant.authorityStatus !== "recorded" || variant.verificationVerdict !== "pass" || !!variant.findings.length || latest["terminology"] !== "accepted" || latest["formatting"] !== "accepted"} onClick={() => onRequest({ operation: "accept", ...binding })}>Accept locale revision</Button>
      <Button type="button" variant="outline" disabled={pending} onClick={() => onRequest({ operation: "reject", ...binding })}>Reject locale revision</Button>
    </> : variant.accepted ? <div className="flex flex-wrap gap-2">{(["txt", "html", "pdf", "docx"] as const).map(format => <Button key={format} type="button" variant="outline" disabled={pending} onClick={() => onExport({ operation: "export", ...binding, format })}>Export {format.toUpperCase()}</Button>)}</div> : <p>Rejected revision retained. Generate another revision to review again.</p>}
    <details><summary>Revision and export history</summary><p>Revision {variant.revisionId} · version {variant.version} · {variant.createdAt}</p>{variant.reviews.map((row, index) => <p key={index}>{row.dimension}: {row.decision} · {row.recordedAt} · {row.note}</p>)}{variant.acceptanceHistory.map((row, index) => <p key={index}>{row.decision} · {row.recordedAt}</p>)}{variant.exports.map(row => <div key={row.artifactId}><p>{row.format.toUpperCase()} · {row.createdAt} · claim snapshot {row.textSha256}</p><Button type="button" variant="outline" disabled={!onOpenExport} onClick={() => onOpenExport?.(row.artifactId)}>Open retained {row.format.toUpperCase()} export</Button></div>)}</details>
  </article>;
}
