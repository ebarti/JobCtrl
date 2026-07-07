import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { act } from "react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import {
  useApplyReviewDecisionMutation,
  useCreateResumeReviewDraftMutation,
  useOutcomeSuggestionDecisionMutation,
  useRecordManualApplicationOutcomeMutation,
  useRenderResumeReviewDraftMutation,
  useSaveResumeReviewDraftRevisionMutation,
  useSeedResumeReviewCommentThreadsMutation,
} from "./useApplyReviewMutations.js";

describe("apply review mutations", () => {
  it("records review decisions and invalidates review surfaces", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useApplyReviewDecisionMutation());
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: {
          decision: "approve_submit",
          reason: "approved",
          decidedBy: "user",
          materialsGeneration: 1,
          profileVersion: 3,
          applicationUrl: "https://example.com/apply",
        },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.decision.decision).toBe("approve_submit");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: applyReviewKeys.queue(LOCAL_TENANT),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.detail(LOCAL_TENANT, "job-2"),
    });
  });

  it("leaves cache data intact when review decisions fail", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/apply-review/decision", () =>
        HttpResponse.json({ ok: false, error: "failed" }, { status: 500 }),
      ),
    );
    const initialQueue = { ok: true, items: [] };
    const { result, queryClient } = renderHookWithProviders(() => useApplyReviewDecisionMutation());
    queryClient.setQueryData(applyReviewKeys.queue(LOCAL_TENANT), initialQueue);

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: { decision: "defer", reason: "later", decidedBy: "user" },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(applyReviewKeys.queue(LOCAL_TENANT))).toEqual(initialQueue);
  });

  it("records manual outcomes and invalidates outcome surfaces", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useRecordManualApplicationOutcomeMutation(),
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: {
          kind: "interview",
          occurredAt: "2026-05-06T08:35:00.000Z",
          note: "Local note",
        },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.outcome.kind).toBe("interview");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.detail(LOCAL_TENANT, "job-2"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.list(LOCAL_TENANT),
    });
  });

  it("leaves outcome cache data intact when manual outcome recording fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/outcomes", () =>
        HttpResponse.json({ ok: false, error: "failed" }, { status: 500 }),
      ),
    );
    const initialOutcomes = { ok: true, jobKey: "job-2", outcomes: [], suggestions: [] };
    const { result, queryClient } = renderHookWithProviders(() =>
      useRecordManualApplicationOutcomeMutation(),
    );
    queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"), initialOutcomes);

    await act(async () => {
      result.current.mutate({
        jobId: "job-2",
        body: {
          kind: "interview",
          occurredAt: "2026-05-06T08:35:00.000Z",
        },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"))).toEqual(
      initialOutcomes,
    );
  });

  it("decides outcome suggestions and invalidates job outcome surfaces", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useOutcomeSuggestionDecisionMutation(),
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        suggestionId: "suggestion-1",
        jobId: "job-2",
        body: { decision: "accept", reason: "accepted" },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.suggestion.status).toBe("accepted");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: outcomesKeys.detail(LOCAL_TENANT, "job-2"),
    });
  });

  it("leaves outcome cache data intact when suggestion decisions fail", async () => {
    server.use(
      http.post("*/v1/outcome-suggestions/:suggestionId/decision", () =>
        HttpResponse.json({ ok: false, error: "failed" }, { status: 500 }),
      ),
    );
    const initialOutcomes = { ok: true, jobKey: "job-2", outcomes: [], suggestions: [] };
    const { result, queryClient } = renderHookWithProviders(() =>
      useOutcomeSuggestionDecisionMutation(),
    );
    queryClient.setQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"), initialOutcomes);

    await act(async () => {
      result.current.mutate({
        suggestionId: "suggestion-1",
        jobId: "job-2",
        body: { decision: "ignore", reason: "not useful" },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(outcomesKeys.detail(LOCAL_TENANT, "job-2"))).toEqual(
      initialOutcomes,
    );
  });

  it("creates and manually saves resume review draft revisions", async () => {
    const createdDraft = {
      draftId: "draft-job-2",
      jobKey: "job-2",
      baseGeneration: 1,
      baseResumeTextArtifactId: "resume-text-2",
      baseResumePdfArtifactId: "resume-pdf-2",
      rendererFormat: "html_css",
      state: "active",
      currentRevisionId: null,
      latestRevisionNumber: 0,
      createdAt: "2026-06-24T09:45:00.000Z",
      updatedAt: "2026-06-24T09:45:00.000Z",
      latestRevision: null,
      commentThreads: [],
      feedbackSignals: [],
    };
    const savedRevision = {
      revisionId: "revision-1",
      draftId: "draft-job-2",
      jobKey: "job-2",
      revisionNumber: 1,
      editedText: "Edited resume text",
      plateDocument: [{ type: "resume_block", tagName: "main", children: [{ text: "Edited resume text" }] }],
      editDeltas: [],
      createdAt: "2026-06-24T10:00:00.000Z",
    };
    const savedDraft = {
      ...createdDraft,
      currentRevisionId: savedRevision.revisionId,
      latestRevisionNumber: 1,
      updatedAt: savedRevision.createdAt,
      latestRevision: savedRevision,
    };
    server.use(
      http.post("*/v1/jobs/:jobKey/resume-review/draft", async ({ params, request }) => {
        expect(String(params["jobKey"])).toBe("job-2");
        expect(await request.json()).toMatchObject({
          rendererFormat: "html_css",
          resumePdfArtifactId: "resume-pdf-2",
          resumeTextArtifactId: "resume-text-2",
        });
        return HttpResponse.json({ ok: true, draft: createdDraft });
      }),
      http.post("*/v1/resume-review/drafts/:draftId/revisions", async ({ params, request }) => {
        expect(String(params["draftId"])).toBe("draft-job-2");
        expect(await request.json()).toMatchObject({
          editedText: "Edited resume text",
          plateDocument: savedRevision.plateDocument,
        });
        return HttpResponse.json({ ok: true, draft: savedDraft, revision: savedRevision });
      }),
    );
    const { result, queryClient } = renderHookWithProviders(() => ({
      create: useCreateResumeReviewDraftMutation(),
      save: useSaveResumeReviewDraftRevisionMutation(),
    }));
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.create.mutate({
        jobId: "job-2",
        body: {
          rendererFormat: "html_css",
          resumePdfArtifactId: "resume-pdf-2",
          resumeTextArtifactId: "resume-text-2",
        },
      });
    });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    expect(queryClient.getQueryData(applyReviewKeys.draft(LOCAL_TENANT, "job-2"))).toEqual({
      ok: true,
      draft: createdDraft,
    });

    await act(async () => {
      result.current.save.mutate({
        jobId: "job-2",
        draftId: "draft-job-2",
        body: {
          editedText: "Edited resume text",
          editDeltas: [],
          plateDocument: savedRevision.plateDocument,
        },
      });
    });

    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    expect(result.current.save.data?.revision.editedText).toBe("Edited resume text");
    expect(queryClient.getQueryData(applyReviewKeys.draft(LOCAL_TENANT, "job-2"))).toEqual({
      ok: true,
      draft: savedDraft,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: applyReviewKeys.draft(LOCAL_TENANT, "job-2"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: applyReviewKeys.feedback(LOCAL_TENANT, "job-2"),
    });
  });

  it("seeds resume comment threads and renders promoted draft replacements", async () => {
    const draft = {
      draftId: "draft-job-2",
      jobKey: "job-2",
      baseGeneration: 1,
      baseResumeTextArtifactId: "resume-text-2",
      baseResumePdfArtifactId: "resume-pdf-2",
      rendererFormat: "html_css",
      state: "active",
      currentRevisionId: "revision-1",
      latestRevisionNumber: 1,
      createdAt: "2026-06-24T09:45:00.000Z",
      updatedAt: "2026-06-24T10:00:00.000Z",
      latestRevision: {
        revisionId: "revision-1",
        draftId: "draft-job-2",
        jobKey: "job-2",
        revisionNumber: 1,
        editedText: "Edited resume text",
        plateDocument: null,
        editDeltas: [],
        createdAt: "2026-06-24T10:00:00.000Z",
      },
      commentThreads: [],
      feedbackSignals: [],
    };
    const seededDraft = {
      ...draft,
      commentThreads: [
        {
          threadId: "thread-1",
          draftId: "draft-job-2",
          jobKey: "job-2",
          baseArtifactId: "resume-text-2",
          semanticId: "experience:line:1",
          lineAnchor: {
            semanticId: "experience:line:1",
            lineNumber: 1,
            pageNumber: 1,
            textHash: null,
          },
          sourcePinId: "pin-1",
          riskLabel: "claim risk",
          commentBody: "Check this line.",
          state: "open",
          anchorResolved: true,
          createdAt: "2026-06-24T10:01:00.000Z",
          updatedAt: "2026-06-24T10:01:00.000Z",
          replies: [],
        },
      ],
    };
    const promotedDraft = {
      ...seededDraft,
      state: "promoted",
      updatedAt: "2026-06-24T10:05:00.000Z",
    };
    server.use(
      http.post("*/v1/resume-review/drafts/:draftId/comment-threads", async ({ params, request }) => {
        expect(String(params["draftId"])).toBe("draft-job-2");
        expect(await request.json()).toMatchObject({
          threads: [
            {
              sourcePinId: "pin-1",
              commentBody: "Check this line.",
            },
          ],
        });
        return HttpResponse.json({
          ok: true,
          draft: seededDraft,
          commentThreads: seededDraft.commentThreads,
          seededCount: 1,
          updatedCount: 0,
        });
      }),
      http.post("*/v1/resume-review/drafts/:draftId/render", async ({ params, request }) => {
        expect(String(params["draftId"])).toBe("draft-job-2");
        expect(await request.json()).toEqual({ draftRevisionId: "revision-1" });
        return HttpResponse.json({
          ok: true,
          draft: promotedDraft,
          validation: { passed: true, errors: [], warnings: [] },
          artifacts: {
            resumeText: {
              artifactId: "resume-review-text",
              artifactType: "tailored_resume",
              generation: 3,
              renderFormat: "text",
            },
            resumePdf: {
              artifactId: "resume-review-pdf",
              artifactType: "resume_pdf",
              generation: 3,
              renderFormat: "html_pdf",
            },
          },
          layoutBoxCount: 3,
        });
      }),
    );
    const { result, queryClient } = renderHookWithProviders(() => ({
      seed: useSeedResumeReviewCommentThreadsMutation(),
      render: useRenderResumeReviewDraftMutation(),
    }));

    await act(async () => {
      result.current.seed.mutate({
        jobId: "job-2",
        draftId: "draft-job-2",
        body: {
          threads: [
            {
              sourcePinId: "pin-1",
              semanticId: "experience:line:1",
              commentBody: "Check this line.",
            },
          ],
        },
      });
    });

    await waitFor(() => expect(result.current.seed.isSuccess).toBe(true));
    expect(queryClient.getQueryData(applyReviewKeys.draft(LOCAL_TENANT, "job-2"))).toEqual({
      ok: true,
      draft: seededDraft,
    });

    await act(async () => {
      result.current.render.mutate({
        jobId: "job-2",
        draftId: "draft-job-2",
        body: { draftRevisionId: "revision-1" },
      });
    });

    await waitFor(() => expect(result.current.render.isSuccess).toBe(true));
    expect(queryClient.getQueryData(applyReviewKeys.draft(LOCAL_TENANT, "job-2"))).toEqual({
      ok: true,
      draft: promotedDraft,
    });
  });
});
