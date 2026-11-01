import { useEffect, useId } from "react";
import { useForm } from "@tanstack/react-form";
import { CoverLetterSettingsSchema, type CoverLetterSettings } from "@jobctrl/contracts";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { PdfPreviewViewer } from "../../../shared/ui/PdfPreviewViewer.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
import type { CoverLetterReview } from "../hooks/useCoverLetterReview.js";

const dimensions = [
  ["fontSizePt", "Font size (pt)", 9, 14, 0.5],
  ["marginMm", "Margins (mm)", 8, 28, 0.01],
  ["lineHeight", "Line spacing", 1, 2, 0.1],
  ["paragraphSpacingPx", "Paragraph spacing (px)", 0, 24, 1],
] as const;

export function CoverLetterReviewSurface({ review }: { readonly review: CoverLetterReview }) {
  const id = useId();
  const form = useForm({ defaultValues: { settings: review.settings },
    validators: { onSubmit: ({ value }) => CoverLetterSettingsSchema.safeParse(value.settings).success ? undefined : "Choose settings within the displayed limits." },
    onSubmit: async () => { await review.renderPreview(); },
  });
  useEffect(() => { form.reset({ settings: review.settings }); }, [form, review.settings]);
  if (!review.available) return review.unavailableReason ? <section aria-label="Cover-letter PDF formatting"><h3>Cover-letter PDF</h3><p role="alert">{review.unavailableReason}</p></section> : null;
  return <section className="grid gap-3" aria-label="Cover-letter PDF formatting">
    <h3>Cover-letter PDF</h3>
    <p>Formatting applies to the full accepted letter. Previewing keeps accepted materials unchanged. Save explicitly accepts the rendered PDF.</p>
    <p className="min-w-0 break-all">Accepted version: <code>{review.accepted?.acceptedVersion.slice(0, 12)}</code></p>
    {review.accepted && !review.accepted.pdfSourceCurrent ? <p role="alert">The accepted PDF does not match the current source. Render and save the current letter before approval.</p> : null}
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="settings">{field => {
        const change = (settings: CoverLetterSettings) => { field.handleChange(settings); review.editSettings(settings); };
        return <>
          {([ ["paper", "Paper size", ["Letter", "A4"]], ["fontFamily", "Font family", ["georgia", "times", "arial"]] ] as const).map(([key, label, values]) => <div key={key}>
            <label htmlFor={`${id}-${key}`}>{label}</label>
            <Select value={field.state.value[key]} items={values.map(value => ({ value, label: value }))}
              onValueChange={value => {
                const parsed = CoverLetterSettingsSchema.safeParse({ ...field.state.value, [key]: value });
                if (parsed.success) change(parsed.data);
              }}>
              <SelectTrigger id={`${id}-${key}`} aria-label={label}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{values.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </div>)}
          {dimensions.map(([key, label, min, max, step]) => <div key={key}>
            <label htmlFor={`${id}-${key}`}>{label}</label>
            <Input id={`${id}-${key}`} type="number" min={min} max={max} step={step}
              value={Number.isFinite(field.state.value[key]) ? field.state.value[key] : ""}
              onChange={event => change({ ...field.state.value, [key]: event.target.valueAsNumber })} />
          </div>)}
        </>;
      }}</form.Field>
      <Button type="submit" disabled={!review.valid || review.saving || review.rendering}>{review.rendering ? "Rendering cover letter…" : "Preview cover-letter PDF"}</Button>
      <Button type="button" disabled={!review.canSave} onClick={() => { void review.savePreview(); }}>{review.saving ? "Saving cover letter…" : "Save cover-letter PDF"}</Button>
      <Button type="button" variant="outline" onClick={review.restoreAccepted}>Restore accepted settings</Button>
    </form>
    <p role="status">{review.dirty ? "Local settings have not been accepted. " : "Settings match the accepted version. "}
      {review.preview ? review.previewCurrent ? "Rendered preview is ready to save." : "Showing a previous render; preview the current settings before saving." : "Showing the accepted PDF."}</p>
    {review.error ? <p role="alert">{review.error} Reload to reconcile a save with an uncertain response. Failed operations preserve the previously accepted materials.</p> : null}
    {review.url ? <>
      <a href={review.url} download="cover-letter.pdf">Download displayed cover-letter PDF</a>
      <PdfPreviewViewer url={review.url} cacheKey={review.preview?.pdfSha256 ?? review.accepted?.pdfSha256 ?? "accepted"}
        title="Cover-letter PDF preview" loadingTitle="Loading cover-letter PDF"
        loadingMessage="Rendering every page of the PDF." pageAltPrefix="Cover-letter PDF" />
    </> : <p>No accepted PDF is available. Render a preview to create one.</p>}
  </section>;
}
