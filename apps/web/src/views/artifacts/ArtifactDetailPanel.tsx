import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ArtifactsSearch } from "../../routes/-artifacts.search.js";

import {
  useResumeArtifactDetail,
  useResumeArtifactFiles,
  useResumeArtifactHtml,
  type ResumeArtifact,
} from "../../contexts/resumes/index.js";
import { Button } from "../../shared/ui/button.js";
import { PdfPreviewViewer } from "../../shared/ui/PdfPreviewViewer.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { ArtifactFileActions } from "./ArtifactFileActions.js";
import { ArtifactState, artifactBytes } from "./columns.js";
import { ResumeRecordHistory } from "./ResumeRecordHistory.js";

export interface ArtifactDetailPanelProps {
  readonly artifactId: string;
}
export function ArtifactDetailPanel({ artifactId }: ArtifactDetailPanelProps) {
  const query = useResumeArtifactDetail(artifactId);
  const artifact = query.artifact;
  const files = useResumeArtifactFiles(artifact ?? null);
  const [htmlOpen, setHtmlOpen] = useState(false);
  return (
    <main className="route-page grid gap-5" aria-label="Artifact details">
      <Link
        className="title-link"
        to="/artifacts"
        search={(previous: ArtifactsSearch) => previous}
      >
        Back to artifact catalog
      </Link>
      <PageHead
        eyebrow="Saved artifact"
        title={artifact?.title ?? "Artifact details"}
        subtitle={artifactId}
      />
      {query.catalog.isPending ? (
        <p role="status">Loading saved artifact catalog…</p>
      ) : null}
      {query.catalog.error ? (
        <p role="alert">
          {query.catalog.error.message} Previously loaded artifacts remain
          inspectable.
        </p>
      ) : null}
      {query.owner.isFetching ? (
        <p role="status">
          Refreshing the source revision and its accepted-source freshness…
        </p>
      ) : null}
      {query.owner.error ? (
        <p role="alert">
          {query.owner.error.message} Retained catalog metadata remains below;
          current source freshness could not be verified.
        </p>
      ) : null}
      {!artifact && !query.catalog.isPending && !query.catalog.error ? (
        <p role="alert">
          No registered artifact with this identity is present in the saved
          Resumes catalog.
        </p>
      ) : null}
      <Button
        variant="outline"
        onClick={() => {
          void query.catalog.refetch();
          if (artifact) void query.owner.refetch();
        }}
      >
        Reload artifact evidence
      </Button>
      {artifact ? (
        <>
          <section
            className="section grid gap-3"
            aria-label="Registered artifact metadata"
          >
            <ArtifactState row={artifact} />
            <dl className="detail-list">
              <div>
                <dt>Related job</dt>
                <dd>
                  <Link
                    className="title-link"
                    to="/jobs/$jobId"
                    params={{ jobId: artifact.jobId }}
                  >
                    {artifact.title}
                    {artifact.company ? ` · ${artifact.company}` : ""}
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Resume</dt>
                <dd className="mono break-all">{artifact.resumeId}</dd>
              </div>
              <div>
                <dt>Source revision</dt>
                <dd>
                  Revision {artifact.revision.number} ·{" "}
                  {artifact.sourceRevisionId}
                </dd>
              </div>
              <div>
                <dt>File</dt>
                <dd>
                  {artifact.render.filename} · PDF ·{" "}
                  {artifactBytes(artifact.render.size_bytes)} ·{" "}
                  {artifact.render.page_count} pages
                </dd>
              </div>
              <div>
                <dt>Recorded SHA-256</dt>
                <dd className="mono break-all">{artifact.render.sha256}</dd>
              </div>
              <div>
                <dt>Rendered</dt>
                <dd>{artifact.renderedAt ?? "Render time not recorded"}</dd>
              </div>
              <div>
                <dt>Accepted</dt>
                <dd>
                  {artifact.acceptedAt ??
                    "This file has no recorded acceptance"}
                </dd>
              </div>
              <div>
                <dt>Text preservation</dt>
                <dd>
                  {artifact.render.text_verified
                    ? "Renderer recorded text verification"
                    : "Text verification not recorded"}
                </dd>
              </div>
            </dl>
            <ArtifactFileActions artifact={artifact} />
            <p>
              PDF download and preview select this exact registered file. HTML,
              text and DOCX exports use its recorded source revision. Exporting
              never approves a draft or authorizes an application.
            </p>
          </section>
          {query.owner.data?.accepted_freshness ? (
            <section
              className="section"
              aria-label="Current accepted source freshness"
            >
              <h2>Accepted source freshness</h2>
              <p>
                Current accepted source status:{" "}
                {query.owner.data.accepted_freshness.status}
              </p>
              {query.owner.data.accepted_freshness.failures.map((failure) => (
                <p role="alert" key={failure}>
                  {failure}
                </p>
              ))}
              {query.owner.data.accepted_freshness.library_outdated ? (
                <p>
                  The Profile library has a newer revision. The selected
                  accepted-source check remains separate from this notice.
                </p>
              ) : null}
              {query.owner.data.accepted_freshness.coverage_stale ? (
                <p>
                  Requirements or Fit coverage changed. The retained PDF and
                  acceptance history remain inspectable.
                </p>
              ) : null}
              <p>
                This status belongs to the resume record's current accepted
                source. It does not relabel historical file contents.
              </p>
            </section>
          ) : (
            <p>
              Current accepted-source freshness is unavailable or this resume
              has no accepted revision. Recorded files remain historical
              evidence.
            </p>
          )}
          <section
            className="section grid gap-3"
            aria-label="Recorded PDF preview"
          >
            <h2>Recorded PDF preview</h2>
            <PdfPreviewViewer
              key={artifact.artifactId}
              cacheKey={artifact.render.sha256}
              loadPdf={files.loadPdf}
              onOpenPdf={() => files.open.mutate()}
              openLabel="Request system PDF open"
              title="Recorded resume PDF"
              loadingTitle="Loading recorded PDF"
              loadingMessage="Reading the selected registered PDF bytes."
              pageAltPrefix="Recorded resume PDF"
            />
            {files.open.data ? (
              <p role="status">
                Open requested. The system viewer decides how to display the
                recorded PDF.
              </p>
            ) : null}
            {files.open.error ? (
              <p role="alert">
                {files.open.error.message}{" "}
                {files.openOutcomeUnknown
                  ? "The open result remains unconfirmed."
                  : "The open request was refused."}
              </p>
            ) : null}
          </section>
          <details onToggle={(event) => setHtmlOpen(event.currentTarget.open)}>
            <summary>Source HTML preview</summary>
            {htmlOpen ? <ArtifactHtmlPreview artifact={artifact} /> : null}
          </details>
          <details>
            <summary>Recorded layout and file audit</summary>
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(
                {
                  artifactId: artifact.artifactId,
                  sha256: artifact.render.sha256,
                  sizeBytes: artifact.render.size_bytes,
                  pageCount: artifact.render.page_count,
                  textVerified: artifact.render.text_verified,
                  layoutMetadata: artifact.render.layout_metadata,
                  layoutBoxes: artifact.render.layout_boxes,
                  layoutConflicts: artifact.render.layout_conflicts,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <ResumeRecordHistory
            resume={artifact.resume}
            selectedArtifactId={artifact.artifactId}
          />
        </>
      ) : null}
    </main>
  );
}
function ArtifactHtmlPreview({ artifact }: { artifact: ResumeArtifact }) {
  const query = useResumeArtifactHtml(artifact);
  return (
    <section className="grid gap-3" aria-label="Source HTML preview">
      <p>
        This preview renders the recorded document source. The registered PDF
        above remains the exact historical file.
      </p>
      {query.isPending ? <p role="status">Loading source HTML…</p> : null}
      {query.error ? (
        <p role="alert">
          {query.error.message} The recorded PDF and source history remain
          available.
        </p>
      ) : null}
      {query.data ? (
        <iframe
          title="Recorded resume source HTML"
          sandbox=""
          srcDoc={query.data}
          className="w-full min-h-[60vh] border"
        />
      ) : null}
    </section>
  );
}
