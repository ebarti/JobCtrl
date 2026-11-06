import { useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  createUnconfirmedWriteError,
  isUnconfirmedWrite,
} from "../../shared/lib/unconfirmed-write.js";

import type { HttpLoaderReadContext } from "../../shared/lib/loaderReadContext.js";
import type { HttpPort } from "../../shared/ports/HttpPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { resumeKeys } from "./client.js";

const identity = z.string().min(1);
const metadata = z.record(z.string(), z.unknown());
const renderSchema = z.object({
  artifact_id: identity,
  resume_id: identity,
  revision_id: identity,
  filename: z.string(),
  format: z.literal("pdf"),
  sha256: z.string().length(64),
  size_bytes: z.number().int().nonnegative(),
  page_count: z.number().int().positive(),
  layout_boxes: z.array(metadata),
  layout_conflicts: z.array(metadata),
  layout_metadata: metadata,
  text_verified: z.boolean(),
});
const reviewSchema = z
  .object({ status: z.string(), findings: z.array(metadata) })
  .passthrough();
const revisionSchema = z
  .object({
    revision_id: identity,
    number: z.number().int().positive(),
    created_at: z.string(),
    profile_revision: z.number().int(),
    mode: z.enum(["tailored", "baseline_copy"]),
    document: metadata,
    profile_snapshot: metadata,
    requirements_snapshot: metadata.nullable(),
    fit_snapshot: metadata.nullable(),
    selected_variants: z.array(metadata),
    coverage_manifest: metadata,
    mechanical: z
      .object({ status: z.string(), failures: z.array(z.string()) })
      .passthrough(),
    review: reviewSchema,
    review_attempts: z.array(metadata),
    template: metadata.nullable(),
    render_attempts: z.array(
      z
        .object({
          status: z.string(),
          created_at: z.string(),
          artifact_id: identity.optional(),
          failure_code: z.string().optional(),
        })
        .passthrough(),
    ),
    renders: z.array(renderSchema),
  })
  .passthrough();
const acceptanceSchema = z
  .object({
    acceptance_id: identity,
    revision_id: identity,
    accepted_at: z.string(),
    review_status: z.string(),
    review_override: z.boolean(),
    document_sha256: z.string().length(64),
    profile_revision: z.number().int(),
    pdf: renderSchema,
  })
  .passthrough();
const localeSchema = z
  .object({
    locale_id: identity,
    source_revision_id: identity,
    source_acceptance_id: identity,
    source_sha256: z.string().length(64),
    source_locale: z.string(),
    target_locale: z.string(),
    created_at: z.string(),
    status: z.string(),
    accepted_at: z.string().nullable(),
    document: metadata.nullable(),
    review: reviewSchema,
    findings: z.array(metadata),
    renders: z.array(renderSchema),
  })
  .passthrough();
const resumeSchema = z
  .object({
    resume_id: identity,
    job_id: identity,
    profile_id: identity,
    version: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    current_revision: identity,
    accepted_revision_id: identity.nullable(),
    revisions: z.array(revisionSchema),
    acceptances: z.array(acceptanceSchema),
    locales: z.array(localeSchema),
    comments: z.array(metadata),
    job: z
      .object({
        jobId: identity,
        title: z.string().nullable(),
        company: z.string().nullable(),
      })
      .nullable()
      .optional(),
    accepted_freshness: z
      .object({
        status: z.string(),
        failures: z.array(z.string()),
        library_outdated: z.boolean(),
        coverage_stale: z.boolean(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const listSchema = z.object({
  ok: z.literal(true),
  resumes: z.array(resumeSchema),
});
const detailSchema = z.object({ ok: z.literal(true), resume: resumeSchema });
const openResponseSchema = z.object({
  ok: z.literal(true),
  artifactId: identity,
  sha256: z.string().length(64),
  status: z.literal("requested"),
});

export type ResumeArtifactSource = z.infer<typeof resumeSchema>;
export type ResumeArtifactRevision = z.infer<typeof revisionSchema>;
export type ResumeArtifactLocale = z.infer<typeof localeSchema>;
export type ResumeArtifactRender = z.infer<typeof renderSchema>;
export type ResumeArtifactStatus =
  | "accepted"
  | "accepted_history"
  | "candidate"
  | "history"
  | "accepted_translation";
export interface ResumeArtifact {
  readonly artifactId: string;
  readonly resumeId: string;
  readonly jobId: string;
  readonly sourceRevisionId: string;
  readonly title: string;
  readonly company: string | null;
  readonly status: ResumeArtifactStatus;
  readonly renderedAt: string | null;
  readonly acceptedAt: string | null;
  readonly render: ResumeArtifactRender;
  readonly revision: ResumeArtifactRevision;
  readonly locale: ResumeArtifactLocale | null;
  readonly resume: ResumeArtifactSource;
  readonly acceptances: readonly z.infer<typeof acceptanceSchema>[];
}
export interface ResumeArtifactCatalog {
  readonly artifacts: readonly ResumeArtifact[];
  readonly resumes: readonly ResumeArtifactSource[];
}

export const resumeArtifactKeys = {
  catalog: (tenant: string) =>
    [...resumeKeys.all(tenant), "artifact-catalog"] as const,
  owner: (tenant: string, resumeId: string) =>
    [...resumeKeys.all(tenant), "artifact-owner", resumeId] as const,
};

/** Join only recorded render, revision and acceptance identities; never judge content. */
export function resumeArtifacts(
  resumes: readonly ResumeArtifactSource[],
): ResumeArtifact[] {
  const result = new Map<string, ResumeArtifact>();
  const owners = new Set<string>();
  for (const resume of resumes) {
    if (owners.has(resume.resume_id))
      throw new Error("The artifact catalog repeats a resume identity.");
    owners.add(resume.resume_id);
    const revisionIds = new Set(resume.revisions.map((row) => row.revision_id));
    if (
      revisionIds.size !== resume.revisions.length ||
      !revisionIds.has(resume.current_revision)
    )
      throw new Error("The saved resume revision identities are inconsistent.");
    const currentAcceptance = [...resume.acceptances]
      .reverse()
      .find((row) => row.revision_id === resume.accepted_revision_id);
    if (
      resume.accepted_revision_id &&
      (!revisionIds.has(resume.accepted_revision_id) || !currentAcceptance)
    )
      throw new Error(
        "The accepted artifact has no recorded acceptance authority.",
      );
    const add = (
      render: ResumeArtifactRender,
      revision: ResumeArtifactRevision,
      locale: ResumeArtifactLocale | null,
    ) => {
      const sourceRevisionId = locale?.locale_id ?? revision.revision_id;
      if (
        render.resume_id !== resume.resume_id ||
        render.revision_id !== sourceRevisionId
      )
        throw new Error(
          "A recorded artifact has a conflicting source identity.",
        );
      const accepted = resume.acceptances.filter(
        (row) => row.pdf.artifact_id === render.artifact_id,
      );
      const latest =
        revision.renders.at(-1)?.artifact_id === render.artifact_id &&
        resume.current_revision === revision.revision_id;
      const latestLocale =
        locale?.renders.at(-1)?.artifact_id === render.artifact_id;
      const status: ResumeArtifactStatus = locale
        ? locale.status === "accepted" && latestLocale
          ? "accepted_translation"
          : "history"
        : currentAcceptance?.pdf.artifact_id === render.artifact_id
          ? "accepted"
          : accepted.length
            ? "accepted_history"
            : latest
              ? "candidate"
              : "history";
      const recorded = result.get(render.artifact_id);
      if (
        recorded &&
        (recorded.resumeId !== resume.resume_id ||
          recorded.sourceRevisionId !== sourceRevisionId ||
          recorded.render.sha256 !== render.sha256 ||
          recorded.render.size_bytes !== render.size_bytes)
      )
        throw new Error(
          "An artifact identifier belongs to conflicting recorded bytes.",
        );
      const attempt = revision.render_attempts.find(
        (row) => row.artifact_id === render.artifact_id,
      );
      result.set(render.artifact_id, {
        artifactId: render.artifact_id,
        resumeId: resume.resume_id,
        jobId: resume.job_id,
        sourceRevisionId,
        title: resume.job?.title ?? `Resume revision ${revision.number}`,
        company: resume.job?.company ?? null,
        status,
        renderedAt: attempt?.created_at ?? null,
        acceptedAt: locale
          ? latestLocale
            ? locale.accepted_at
            : null
          : (accepted.at(-1)?.accepted_at ?? null),
        render,
        revision,
        locale,
        resume,
        acceptances: accepted,
      });
    };
    for (const revision of resume.revisions)
      for (const render of revision.renders) add(render, revision, null);
    // Acceptance snapshots pin their original bytes even after another render.
    for (const acceptance of resume.acceptances) {
      const revision = resume.revisions.find(
        (row) => row.revision_id === acceptance.revision_id,
      );
      if (!revision)
        throw new Error(
          "An accepted artifact has no recorded source revision.",
        );
      add(acceptance.pdf, revision, null);
    }
    for (const locale of resume.locales) {
      const revision = resume.revisions.find(
        (row) => row.revision_id === locale.source_revision_id,
      );
      if (!revision)
        throw new Error(
          "A translated artifact has no recorded source revision.",
        );
      for (const render of locale.renders) add(render, revision, locale);
    }
  }
  return [...result.values()];
}

async function readCatalog(http: HttpPort) {
  const parsed = listSchema.safeParse(
    await http.json<unknown>("GET", "/v1/resumes"),
  );
  if (!parsed.success)
    throw new Error(
      "The saved resume artifact catalog is invalid. Retained artifacts have not been replaced.",
    );
  return {
    artifacts: resumeArtifacts(parsed.data.resumes),
    resumes: parsed.data.resumes,
  } satisfies ResumeArtifactCatalog;
}
function catalogOptions(tenant: string, http: HttpPort) {
  return {
    queryKey: resumeArtifactKeys.catalog(tenant),
    queryFn: () => readCatalog(http),
    structuralSharing: (previous: unknown, incoming: unknown) => {
      const current = previous as ResumeArtifactCatalog | undefined;
      const next = incoming as ResumeArtifactCatalog;
      if (!current) return next;
      const prior = new Map(current.resumes.map((row) => [row.resume_id, row]));
      const resumes = next.resumes.map((row) => {
        const saved = prior.get(row.resume_id);
        return saved && saved.version > row.version ? saved : row;
      });
      return {
        resumes,
        artifacts: resumeArtifacts(resumes),
      } satisfies ResumeArtifactCatalog;
    },
    meta: { suppressGlobalErrorToast: true },
  };
}
async function readOwner(
  http: HttpPort,
  resumeId: string,
  artifactId?: string,
) {
  const parsed = detailSchema.safeParse(
    await http.json<unknown>(
      "GET",
      `/v1/resumes/${encodeURIComponent(resumeId)}`,
    ),
  );
  if (!parsed.success || parsed.data.resume.resume_id !== resumeId)
    throw new Error(
      "The saved artifact owner is invalid. Retained history remains available.",
    );
  const artifacts = resumeArtifacts([parsed.data.resume]);
  if (artifactId && !artifacts.some((row) => row.artifactId === artifactId))
    throw new Error(
      "The refreshed resume does not retain this registered artifact identity. Previous evidence remains inspectable.",
    );
  return parsed.data.resume;
}
function ownerOptions(
  tenant: string,
  http: HttpPort,
  resumeId: string,
  artifactId?: string,
) {
  return {
    queryKey: resumeArtifactKeys.owner(tenant, resumeId),
    queryFn: () => readOwner(http, resumeId, artifactId),
    structuralSharing: (previous: unknown, incoming: unknown) => {
      const current = previous as ResumeArtifactSource | undefined;
      const next = incoming as ResumeArtifactSource;
      return current && current.version > next.version ? current : next;
    },
    enabled: Boolean(resumeId),
    meta: { suppressGlobalErrorToast: true },
  };
}

export function useResumeArtifactCatalog() {
  const tenant = useTenantId();
  const { http } = usePorts();
  return useQuery(catalogOptions(tenant, http));
}
export function useResumeArtifactDetail(artifactId: string) {
  const tenant = useTenantId();
  const { http } = usePorts();
  const catalog = useResumeArtifactCatalog();
  const retained = catalog.data?.artifacts.find(
    (row) => row.artifactId === artifactId,
  );
  const owner = useQuery(
    ownerOptions(tenant, http, retained?.resumeId ?? "", artifactId),
  );
  const artifact = owner.data
    ? (resumeArtifacts([owner.data]).find(
        (row) => row.artifactId === artifactId,
      ) ?? retained)
    : retained;
  return { artifact, catalog, owner };
}
export function prefetchResumeArtifactCatalog(context: HttpLoaderReadContext) {
  return context.queryClient.prefetchQuery(
    catalogOptions(context.tenantId, context.ports.http),
  );
}
export async function prefetchResumeArtifactDetail(
  context: HttpLoaderReadContext,
  artifactId: string,
) {
  const catalog = await context.queryClient.ensureQueryData(
    catalogOptions(context.tenantId, context.ports.http),
  );
  const artifact = catalog.artifacts.find(
    (row) => row.artifactId === artifactId,
  );
  if (artifact)
    await context.queryClient.prefetchQuery(
      ownerOptions(
        context.tenantId,
        context.ports.http,
        artifact.resumeId,
        artifactId,
      ),
    );
}

function pdfRequest(artifact: ResumeArtifact) {
  return {
    path: `/v1/resumes/${encodeURIComponent(artifact.resumeId)}/export`,
    query: {
      format: "pdf",
      artifact_id: artifact.artifactId,
      revision_id: artifact.sourceRevisionId,
    },
  } as const;
}
export function useResumeArtifactHtml(artifact: ResumeArtifact) {
  const tenant = useTenantId();
  const { http } = usePorts();
  const path = artifact.locale
    ? `/v1/resumes/${encodeURIComponent(artifact.resumeId)}/locales/${encodeURIComponent(artifact.locale.locale_id)}/export`
    : `/v1/resumes/${encodeURIComponent(artifact.resumeId)}/export`;
  return useQuery({
    queryKey: [
      ...resumeArtifactKeys.owner(tenant, artifact.resumeId),
      "html",
      artifact.sourceRevisionId,
    ],
    queryFn: () =>
      http.text("GET", path, {
        query: {
          format: "html",
          revision_id: artifact.revision.revision_id,
          accepted: artifact.acceptances.length > 0,
        },
      }),
    meta: { suppressGlobalErrorToast: true },
  });
}
export function useResumeArtifactFiles(artifact: ResumeArtifact | null) {
  const { http, blobDownload, requestIdentity } = usePorts();
  const tenant = useTenantId();
  const loadPdf = useCallback(async () => {
    if (!artifact) throw new Error("Select a saved artifact.");
    const request = pdfRequest(artifact);
    return http.blob("GET", request.path, { query: request.query });
  }, [
    http,
    artifact?.resumeId,
    artifact?.artifactId,
    artifact?.sourceRevisionId,
  ]);
  const download = useMutation({
    mutationKey: [
      ...resumeArtifactKeys.owner(tenant, artifact?.resumeId ?? ""),
      artifact?.artifactId ?? "",
      "download",
    ],
    mutationFn: async (format: "pdf" | "html" | "txt" | "docx") => {
      if (!artifact) throw new Error("Select a saved artifact.");
      const request = pdfRequest(artifact);
      const path =
        artifact.locale && format !== "pdf"
          ? `/v1/resumes/${encodeURIComponent(artifact.resumeId)}/locales/${encodeURIComponent(artifact.locale.locale_id)}/export`
          : request.path;
      const query =
        format === "pdf"
          ? request.query
          : {
              format,
              revision_id: artifact.revision.revision_id,
              accepted: artifact.acceptances.length > 0,
            };
      const blob = await http.blob("GET", path, { query });
      blobDownload.save(
        blob,
        format === "pdf"
          ? artifact.render.filename
          : `resume-revision-${artifact.revision.number}${artifact.locale ? `-${artifact.locale.target_locale}` : ""}.${format}`,
      );
    },
    meta: { suppressGlobalErrorToast: true },
  });
  const open = useMutation({
    mutationKey: [
      ...resumeArtifactKeys.owner(tenant, artifact?.resumeId ?? ""),
      artifact?.artifactId ?? "",
      "open",
    ],
    mutationFn: async () => {
      if (!artifact) throw new Error("Select a saved artifact.");
      const path = `/v1/resumes/${encodeURIComponent(artifact.resumeId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/open`;
      const parsed = openResponseSchema.safeParse(
        await http.json<unknown>("POST", path, {
          body: {},
          idempotencyKey: requestIdentity.create(),
        }),
      );
      if (
        !parsed.success ||
        parsed.data.artifactId !== artifact.artifactId ||
        parsed.data.sha256 !== artifact.render.sha256
      )
        throw createUnconfirmedWriteError(
          "POST",
          path,
          new Error(
            "The file-open acknowledgement does not match this registered artifact.",
          ),
        );
      return parsed.data;
    },
    meta: { suppressGlobalErrorToast: true },
  });
  return {
    loadPdf,
    download,
    open,
    openOutcomeUnknown: isUnconfirmedWrite(open.error),
  };
}
