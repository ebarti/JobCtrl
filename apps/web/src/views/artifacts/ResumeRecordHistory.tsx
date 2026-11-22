import { Link } from "@tanstack/react-router";

import type { ResumeArtifactSource } from "../../contexts/resumes/index.js";

export function ResumeRecordHistory({
  resume,
  selectedArtifactId,
}: {
  readonly resume: ResumeArtifactSource;
  readonly selectedArtifactId?: string;
}) {
  return (
    <section
      className="section grid gap-3"
      aria-label="Resume artifact history"
    >
      <h2>Resume and artifact history</h2>
      <p>
        Resume {resume.resume_id} · version {resume.version} ·{" "}
        <Link
          className="title-link"
          to="/jobs/$jobId"
          params={{ jobId: resume.job_id }}
        >
          Open related job
        </Link>
      </p>
      <p>
        Current document revision: {resume.current_revision}. Accepted document
        revision: {resume.accepted_revision_id ?? "none"}.
      </p>
      {resume.revisions.map((revision) => (
        <details
          key={revision.revision_id}
          open={!selectedArtifactId && resume.revisions.length === 1}
        >
          <summary>
            Revision {revision.number} · {revision.mode} · review{" "}
            {revision.review.status} · {revision.renders.length} recorded PDFs
          </summary>
          <p>
            Saved {revision.created_at} · Profile revision{" "}
            {revision.profile_revision} · mechanical check{" "}
            {revision.mechanical.status}
          </p>
          {revision.mechanical.failures.length ? (
            <ul>
              {revision.mechanical.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          ) : null}
          <ul>
            {revision.renders.map((render) => (
              <li key={render.artifact_id}>
                {render.artifact_id === selectedArtifactId ? (
                  <strong>Selected artifact {render.artifact_id}</strong>
                ) : (
                  <Link
                    className="title-link"
                    to="/artifacts/$artifactId"
                    params={{ artifactId: render.artifact_id }}
                  >
                    Inspect PDF {render.artifact_id}
                  </Link>
                )}{" "}
                · {render.size_bytes} bytes · {render.page_count} pages
              </li>
            ))}
          </ul>
          <details>
            <summary>Render attempts, including failures</summary>
            {revision.render_attempts.length ? (
              <ol>
                {revision.render_attempts.map((attempt, index) => (
                  <li key={`${attempt.created_at}:${index}`}>
                    {attempt.status} · {attempt.created_at}
                    {attempt.failure_code ? ` · ${attempt.failure_code}` : ""}
                    {attempt.artifact_id
                      ? ` · artifact ${attempt.artifact_id}`
                      : ""}
                  </li>
                ))}
              </ol>
            ) : (
              <p>No rendering attempt is recorded.</p>
            )}
          </details>
          <details>
            <summary>Assembly review and prior attempts</summary>
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(
                { review: revision.review, attempts: revision.review_attempts },
                null,
                2,
              )}
            </pre>
          </details>
          <details>
            <summary>Exact selected wording and coverage audit</summary>
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(
                {
                  selected_variants: revision.selected_variants,
                  coverage_manifest: revision.coverage_manifest,
                  mechanical: revision.mechanical,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <details>
            <summary>Document and source snapshots</summary>
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(
                {
                  document: revision.document,
                  profile_snapshot: revision.profile_snapshot,
                  requirements_snapshot: revision.requirements_snapshot,
                  fit_snapshot: revision.fit_snapshot,
                  template: revision.template,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </details>
      ))}
      <details>
        <summary>Acceptance history ({resume.acceptances.length})</summary>
        {resume.acceptances.map((acceptance) => (
          <article key={acceptance.acceptance_id}>
            <p>
              Acceptance {acceptance.acceptance_id} · {acceptance.accepted_at} ·
              revision {acceptance.revision_id}
            </p>
            <p>
              Assembly review: {acceptance.review_status}
              {acceptance.review_override ? " · explicit user override" : ""}
            </p>
            <Link
              className="title-link"
              to="/artifacts/$artifactId"
              params={{ artifactId: acceptance.pdf.artifact_id }}
            >
              Inspect pinned accepted PDF
            </Link>
            <p className="mono break-all">
              PDF SHA-256 {acceptance.pdf.sha256}
            </p>
            <details>
              <summary>Exact acceptance snapshot</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(acceptance, null, 2)}
              </pre>
            </details>
          </article>
        ))}
      </details>
      <details>
        <summary>Translation history ({resume.locales.length})</summary>
        {resume.locales.map((locale) => (
          <article key={locale.locale_id}>
            <h3>
              {locale.source_locale} → {locale.target_locale} · {locale.status}
            </h3>
            <p>
              Source acceptance {locale.source_acceptance_id} · source revision{" "}
              {locale.source_revision_id}
            </p>
            <p>
              Created {locale.created_at}
              {locale.accepted_at ? ` · accepted ${locale.accepted_at}` : ""}
            </p>
            <ul>
              {locale.renders.map((render) => (
                <li key={render.artifact_id}>
                  <Link
                    className="title-link"
                    to="/artifacts/$artifactId"
                    params={{ artifactId: render.artifact_id }}
                  >
                    Inspect translated PDF {render.artifact_id}
                  </Link>
                </li>
              ))}
            </ul>
            <details>
              <summary>Translation review and source bindings</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(locale, null, 2)}
              </pre>
            </details>
          </article>
        ))}
      </details>
      <details>
        <summary>
          Saved review comment threads ({resume.comments.length})
        </summary>
        <pre className="whitespace-pre-wrap break-words">
          {JSON.stringify(resume.comments, null, 2)}
        </pre>
      </details>
    </section>
  );
}
