import type { ResumeArtifact } from "../../contexts/resumes/index.js";
import { useResumeArtifactFiles } from "../../contexts/resumes/index.js";
import { Button } from "../../shared/ui/button.js";

export function ArtifactFileActions({
  artifact,
  compact = false,
}: {
  artifact: ResumeArtifact;
  compact?: boolean;
}) {
  const files = useResumeArtifactFiles(artifact);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={files.open.isPending}
          onClick={() => files.open.mutate()}
        >
          {files.open.isPending ? "Requesting open…" : "Open recorded PDF"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={files.download.isPending}
          onClick={() => files.download.mutate("pdf")}
        >
          Download recorded PDF
        </Button>
        {!compact
          ? (["docx", "html", "txt"] as const).map((format) => (
              <Button
                key={format}
                type="button"
                variant="outline"
                size="sm"
                disabled={files.download.isPending}
                onClick={() => files.download.mutate(format)}
              >
                Export source {format.toUpperCase()}
              </Button>
            ))
          : null}
      </div>
      {files.download.error ? (
        <p role="alert">
          {files.download.error.message} Recorded files and accepted history
          remain unchanged.
        </p>
      ) : null}
      {files.open.data ? (
        <p role="status">
          Open requested. The system viewer decides how to display this recorded
          PDF.
        </p>
      ) : null}
      {files.open.error ? (
        <p role="alert">
          {files.open.error.message}{" "}
          {files.openOutcomeUnknown
            ? "The open result remains unconfirmed."
            : "The open request was refused."}{" "}
          Recorded files and accepted history remain unchanged.
        </p>
      ) : null}
    </div>
  );
}
