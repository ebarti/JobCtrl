import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  useResumeArtifactCatalog,
  type ResumeArtifact,
} from "../../contexts/resumes/index.js";
import type { ArtifactsSearch } from "../../routes/-artifacts.search.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { ArtifactFilterBar } from "./ArtifactFilterBar.js";
import { ArtifactsTable } from "./ArtifactsTable.js";
import { ResumeRecordHistory } from "./ResumeRecordHistory.js";

function field(
  row: ResumeArtifact,
  sort: ArtifactsSearch["sort"],
): string | number {
  return sort === "created_at"
    ? (row.renderedAt ?? "")
    : sort === "title"
      ? row.title
      : sort === "company"
        ? (row.company ?? "")
        : sort === "type"
          ? row.locale
            ? "translation_pdf"
            : "resume_pdf"
          : sort === "status"
            ? row.status
            : row.render.size_bytes;
}
export function ArtifactsView() {
  const search = useSearch({ from: "/artifacts" });
  const navigate = useNavigate({ from: "/artifacts" });
  const query = useResumeArtifactCatalog();
  const rows = useMemo(() => {
    const literal = search.q.toLocaleLowerCase();
    return (query.data?.artifacts ?? [])
      .filter(
        (row) =>
          (search.status === "all" || row.status === search.status) &&
          (!literal ||
            [
              row.title,
              row.company ?? "",
              row.artifactId,
              row.jobId,
              row.resumeId,
              row.locale?.target_locale ?? "",
              row.locale ? "translation PDF" : "resume PDF",
            ].some((value) => value.toLocaleLowerCase().includes(literal))),
      )
      .toSorted((left, right) => {
        const a = field(left, search.sort);
        const b = field(right, search.sort);
        const order =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b));
        return (
          (search.dir === "desc" ? -order : order) ||
          left.artifactId.localeCompare(right.artifactId)
        );
      });
  }, [query.data, search.q, search.status, search.sort, search.dir]);
  const setSearch = (next: Partial<ArtifactsSearch>) => {
    void navigate({
      search: (previous: ArtifactsSearch) => ({ ...previous, ...next }),
    });
  };
  const pages = Math.max(1, Math.ceil(rows.length / search.pageSize));
  const page = Math.min(search.page, pages);
  const unrendered = (query.data?.resumes ?? []).filter(
    (resume) =>
      !query.data?.artifacts.some((row) => row.resumeId === resume.resume_id) &&
      (!search.q ||
        [
          resume.resume_id,
          resume.job_id,
          resume.job?.title ?? "",
          resume.job?.company ?? "",
        ].some((value) =>
          value.toLocaleLowerCase().includes(search.q.toLocaleLowerCase()),
        )),
  );
  return (
    <main className="route-page grid gap-5">
      <PageHead
        eyebrow="Library"
        title="Materials"
        subtitle={
          query.data
            ? `${query.data.artifacts.length} registered PDF files · ${query.data.resumes.length} resume records`
            : "Loading saved materials"
        }
      />
      <p>
        Browse recorded resume and translation PDFs, their exact source
        revisions, accepted history and audit. Acceptance and source freshness
        are shown separately.
      </p>
      {query.error ? (
        <p role="alert">
          {query.error.message} The last loaded catalog remains visible.
        </p>
      ) : null}
      <Button
        variant="outline"
        className="justify-self-start"
        onClick={() => {
          void query.refetch();
        }}
      >
        Refresh materials
      </Button>
      <section className="card full data-list-card">
        <ArtifactFilterBar search={search} />
        <ArtifactsTable
          items={rows.slice(
            (page - 1) * search.pageSize,
            page * search.pageSize,
          )}
          loading={query.isPending}
          total={rows.length}
          page={page}
          pages={pages}
          pageSize={search.pageSize}
          sort={search.sort}
          direction={search.dir}
          onSort={(sort, dir) => setSearch({ sort, dir, page: 1 })}
          onPageChange={(next) => setSearch({ page: next })}
          onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        />
      </section>
      {unrendered.length && search.status === "all" ? (
        <section
          className="section grid gap-3"
          aria-label="Resume records without a rendered PDF"
        >
          <h2>Resume records without a rendered PDF</h2>
          <p>
            Drafts and failed render attempts remain recorded even when no PDF
            has been registered.
          </p>
          {unrendered.map((resume) => (
            <ResumeRecordHistory key={resume.resume_id} resume={resume} />
          ))}
        </section>
      ) : null}
    </main>
  );
}
