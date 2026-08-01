import {
  LOCAL_TENANT,
  createJobActiveStateChanged,
  createResumeApproved,
  type TenantId,
} from "@jobctrl/domain-types";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  makeArtifactDetail,
  makeArtifactsPage,
  makeJobDetail,
  makeJobsPage,
  sampleDraftResumeArtifact,
  sampleJob,
} from "../../test/fixtures/projections.js";
import { artifactsKeys } from "./artifactsKeys.js";
import { invalidationRouter } from "./invalidation-router.js";
import { jobsKeys } from "./jobsKeys.js";
import {
  patchJobActiveState,
  patchResumeApproved,
} from "./realtimePatches.js";

const NOW = "2026-08-01T14:00:00Z";
const OTHER_TENANT = "other" as TenantId;

describe("realtime cache patches", () => {
  it("patches active state on one cached detail without replacing its audit data", () => {
    const current = makeJobDetail(sampleJob);
    const patched = patchJobActiveState(current, {
      jobId: sampleJob.jobKey,
      activeState: "closed",
    }) as typeof current;

    expect(patched.job.activeState).toBe("closed");
    expect(patched.auditHistory).toBe(current.auditHistory);
    expect(patched.stages).toBe(current.stages);
  });

  it("approves only registered cached artifact rows and never synthesizes one", () => {
    const candidate = { ...sampleDraftResumeArtifact, artifactId: "artifact-1" };
    const detail = makeArtifactDetail(candidate);
    const job = makeJobDetail(sampleJob, { artifacts: [candidate] });
    const payload = { jobId: sampleJob.jobKey, artifactId: candidate.artifactId };

    expect((patchResumeApproved(detail, payload) as typeof detail).artifact.status).toBe(
      "approved",
    );
    expect((patchResumeApproved(job, payload) as typeof job).artifacts[0]?.status).toBe(
      "approved",
    );

    const missing = makeArtifactDetail({ ...candidate, artifactId: "artifact-other" });
    const unchanged = patchResumeApproved(missing, payload) as typeof missing;
    expect(unchanged).toBe(missing);
    expect(unchanged.artifact.artifactId).toBe("artifact-other");
  });

  it("patches tenant-scoped details while preserving filtered list state", () => {
    const queryClient = new QueryClient();
    const listKey = jobsKeys.list(LOCAL_TENANT, {
      page: 3,
      q: "platform",
      normalizedScoreKeyword: "kubernetes",
    });
    const listBefore = makeJobsPage([sampleJob]);
    queryClient.setQueryData(listKey, listBefore);
    queryClient.setQueryData(
      jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey),
      makeJobDetail(sampleJob),
    );
    queryClient.setQueryData(
      jobsKeys.detail(OTHER_TENANT, sampleJob.jobKey),
      makeJobDetail(sampleJob),
    );

    invalidationRouter.handle(
      createJobActiveStateChanged(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        activeState: "closed",
        previousState: "active",
        verificationMethod: "snapshot",
        verifiedAt: NOW,
      }),
      queryClient,
    );

    const list = queryClient.getQueryData<ReturnType<typeof makeJobsPage>>(listKey);
    const detail = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
      jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey),
    );
    expect(list?.items[0]?.activeState).toBe("active");
    expect(list).toBe(listBefore);
    expect(detail?.job.activeState).toBe("closed");
    expect(
      queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
        jobsKeys.detail(OTHER_TENANT, sampleJob.jobKey),
      )?.job.activeState,
    ).toBe("active");
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("routes active-state and approval events through their exact cached records", () => {
    const queryClient = new QueryClient();
    const candidate = { ...sampleDraftResumeArtifact, artifactId: "artifact-1" };
    const jobsListKey = jobsKeys.list(LOCAL_TENANT, { page: 2, deleted: "all" });
    const artifactsListKey = artifactsKeys.list(LOCAL_TENANT, {
      page: 2,
      status: "candidate",
    });
    queryClient.setQueryData(jobsListKey, makeJobsPage([sampleJob]));
    queryClient.setQueryData(
      jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey),
      makeJobDetail(sampleJob, { artifacts: [candidate] }),
    );
    queryClient.setQueryData(artifactsListKey, makeArtifactsPage([candidate]));
    queryClient.setQueryData(
      artifactsKeys.detail(LOCAL_TENANT, candidate.artifactId),
      makeArtifactDetail(candidate),
    );

    invalidationRouter.handle(
      createJobActiveStateChanged(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        activeState: "closed",
        previousState: "active",
        verificationMethod: "snapshot",
        verifiedAt: NOW,
      }),
      queryClient,
    );
    invalidationRouter.handle(
      createResumeApproved(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        artifactId: candidate.artifactId,
        generation: 2,
        approvedAt: NOW,
      }),
      queryClient,
    );

    expect(
      queryClient.getQueryData<ReturnType<typeof makeJobsPage>>(jobsListKey)?.items[0]
        ?.activeState,
    ).toBe("active");
    expect(
      queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
        jobsKeys.detail(LOCAL_TENANT, sampleJob.jobKey),
      )?.artifacts[0]?.status,
    ).toBe("approved");
    expect(
      queryClient.getQueryData<{ items: typeof candidate[] }>(artifactsListKey)?.items[0]
        ?.status,
    ).toBe("candidate");
    expect(
      queryClient.getQueryData<ReturnType<typeof makeArtifactDetail>>(
        artifactsKeys.detail(LOCAL_TENANT, candidate.artifactId),
      )?.artifact.status,
    ).toBe("approved");
    expect(queryClient.getQueryState(jobsListKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(artifactsListKey)?.isInvalidated).toBe(true);
  });
});
