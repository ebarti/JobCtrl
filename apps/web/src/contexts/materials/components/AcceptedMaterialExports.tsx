import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldGroup,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "../../../shared/ui/toggle-group.js";
import {
  useAcceptedMaterialExports,
  type MaterialExportHistory,
  type MaterialExportReceipt,
  type MaterialExportRequest,
} from "../hooks/useAcceptedMaterialExports.js";

const paperSchema = z.enum(["A4", "Letter"]);
const failureSchema = z.object({
  responseBody: z.object({ error: z.string() }),
});
const messages: Readonly<Record<string, string>> = {
  stale_export_source:
    "The accepted source changed. Refresh the list and export the current version.",
  stale_source_generation:
    "A different generation is now available. Refresh the list before exporting.",
  accepted_source_unavailable:
    "This source is no longer accepted. Refresh the list and choose a current accepted version.",
  source_bytes_or_metadata_unavailable:
    "The accepted source file is unavailable. Restore it or accept a new material before exporting.",
  unsupported_source_locale:
    "The recorded source language is invalid. Correct the material's language metadata before exporting.",
  unsupported_source_characters:
    "The source contains characters that DOCX cannot represent. Review the material before exporting.",
  source_text_empty:
    "The accepted source is empty. Accept a material with content before exporting.",
  source_too_large: "The source exceeds the 200 KB DOCX export limit.",
  export_bytes_changed:
    "The retained file changed. Generate a new export from the accepted source.",
  export_file_unavailable:
    "The retained file is unavailable. Restore it or generate a new export.",
};
function failureMessage(error: unknown) {
  const parsed = failureSchema.safeParse(error);
  return parsed.success
    ? (messages[parsed.data.responseBody.error] ??
        "The operation is unavailable. Check the local service and try again.")
    : "The operation is unavailable. Check the local service and try again.";
}

export function AcceptedMaterialExports({ jobId }: { readonly jobId: string }) {
  const { history, mutation, download, exportAndDownload, isDemo } =
    useAcceptedMaterialExports(jobId);
  const pending = mutation.isPending || download.isPending;
  return (
    <section aria-label="Editable DOCX exports" className="flex flex-col gap-4">
      <h4>Editable DOCX</h4>
      <p>
        Download an accepted resume or cover letter for editing in Word. Text
        and order are preserved in a single-column layout; PDF fonts,
        pagination, images and custom styling are not reproduced.
      </p>
      {isDemo ? (
        <p>
          DOCX export requires accepted materials saved in your local workspace.
        </p>
      ) : (
        <>
          {history.error ? (
            <Alert variant="warning">
              <AlertTitle>Export list unavailable</AlertTitle>
              <AlertDescription>
                Accepted materials and previous exports are preserved. Check the
                local service and refresh.
              </AlertDescription>
            </Alert>
          ) : null}
          {mutation.error ? (
            <Alert variant="warning">
              <AlertTitle>DOCX export failed</AlertTitle>
              <AlertDescription>
                {failureMessage(mutation.error)} Accepted materials and previous
                exports are preserved.
              </AlertDescription>
            </Alert>
          ) : null}
          {download.error ? (
            <Alert variant="warning">
              <AlertTitle>Download failed</AlertTitle>
              <AlertDescription>
                {failureMessage(download.error)} The export remains in the list
                below; retry its download.
              </AlertDescription>
            </Alert>
          ) : null}
          {pending ? (
            <p role="status">
              {mutation.isPending ? "Creating DOCX…" : "Downloading DOCX…"}
            </p>
          ) : download.isSuccess ? (
            <p role="status">
              Download started. A retained copy remains available below.
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={pending || history.isFetching}
            onClick={() => {
              void history.refetch();
            }}
          >
            Refresh export list
          </Button>
          {!history.data && history.isPending ? (
            <p role="status">Loading accepted materials…</p>
          ) : null}
          {history.data ? (
            <AcceptedMaterialExportPanel
              history={history.data}
              pending={pending}
              sourceUnavailable={history.isError}
              onExport={(request) => {
                void exportAndDownload(request).catch(() => {});
              }}
              onDownload={(receipt) => download.mutate(receipt)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

export function AcceptedMaterialExportPanel({
  history,
  pending,
  sourceUnavailable = false,
  onExport,
  onDownload,
}: {
  readonly history: MaterialExportHistory;
  readonly pending: boolean;
  readonly sourceUnavailable?: boolean;
  readonly onExport: (request: MaterialExportRequest) => void;
  readonly onDownload: (receipt: MaterialExportReceipt) => void;
}) {
  const form = useForm({ defaultValues: { paper: "A4" as "A4" | "Letter" } });
  return (
    <div className="flex flex-col gap-4">
      {history.sources.length ? (
        <>
          <FieldGroup>
            <FieldSet>
              <FieldLegend>Paper size</FieldLegend>
              <Field>
                <form.Field name="paper">
                  {(field) => (
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      aria-label="DOCX paper size"
                      value={field.state.value}
                      disabled={pending || sourceUnavailable}
                      onValueChange={(value) => {
                        const result = paperSchema.safeParse(value);
                        if (result.success) field.handleChange(result.data);
                      }}
                    >
                      <ToggleGroupItem value="A4">A4</ToggleGroupItem>
                      <ToggleGroupItem value="Letter">Letter</ToggleGroupItem>
                    </ToggleGroup>
                  )}
                </form.Field>
              </Field>
            </FieldSet>
          </FieldGroup>
          {history.sources.map((source) => (
            <div
              key={source.artifactId}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div>
                <p>
                  {source.kind === "tailored_resume"
                    ? "Resume"
                    : "Cover letter"}{" "}
                  · generation {source.generation}
                </p>
                <p className="text-muted-foreground">
                  {source.locale
                    ? `Source language: ${source.locale}`
                    : "Source language not recorded; no translation is performed."}
                </p>
                {source.unavailableReason ? (
                  <p>
                    {messages[source.unavailableReason] ??
                      "This accepted source is unavailable for export."}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending ||
                  sourceUnavailable ||
                  !!source.unavailableReason ||
                  !source.sha256 ||
                  !source.metadataSha256
                }
                onClick={() => {
                  const paper = paperSchema.safeParse(
                    form.getFieldValue("paper"),
                  );
                  if (paper.success && source.sha256 && source.metadataSha256)
                    onExport({
                      operation: "export",
                      sourceArtifactId: source.artifactId,
                      expectedGeneration: source.generation,
                      expectedSourceSha256: source.sha256,
                      expectedMetadataSha256: source.metadataSha256,
                      paper: paper.data,
                    });
                }}
              >
                Export{" "}
                {source.kind === "tailored_resume" ? "resume" : "cover letter"}{" "}
                DOCX
              </Button>
            </div>
          ))}
        </>
      ) : (
        <Empty
          title="No accepted text materials to export."
          description="Accept a resume or cover letter to enable DOCX export."
        />
      )}
      {history.exports.length ? (
        <div className="flex flex-col gap-3">
          <h5>Retained DOCX exports</h5>
          {history.exports.map((receipt) => (
            <article
              key={receipt.artifactId}
              aria-label={`DOCX export ${receipt.artifactId}`}
              className="flex flex-col gap-2 border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>
                  {receipt.kind === "tailored_resume"
                    ? "Resume"
                    : "Cover letter"}{" "}
                  · generation {receipt.generation} · {receipt.settings.paper} ·{" "}
                  {receipt.settings.locale}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onDownload(receipt)}
                >
                  Download DOCX
                </Button>
              </div>
              <time dateTime={receipt.createdAt}>
                {new Date(receipt.createdAt).toLocaleString()}
              </time>
              <details>
                <summary>Export details and limitations</summary>
                <p>Accepted source: {receipt.sourceArtifactId}</p>
                <ul>
                  {receipt.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
