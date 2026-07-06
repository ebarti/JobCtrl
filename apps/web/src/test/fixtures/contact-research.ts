import type {
  ConfirmContactCandidateResponse,
  ContactCandidateDto,
  ContactResearchDetailResponse,
  ContactResearchListResponse,
  ContactResearchSourceAttempt,
  ContactResearchTaskDetail,
  ContactResearchTaskSummary,
} from "@jobhunter/contracts";

import { makeContactDetail } from "./contacts.js";

export const sampleCandidate: ContactCandidateDto = {
  candidateId: "cand-1",
  taskId: "task-1",
  role: "hiring_manager",
  status: "needs_review",
  confidence: 0.8,
  provenance: {
    sourceKind: "public_web_page",
    sourceRef: "https://acme.example/team",
    captureMethod: "llm_assisted",
    capturedAt: "2026-07-06T00:00:00+00:00",
    confidence: 0.8,
    userConfirmed: false,
  },
  attributes: [
    {
      attributeId: "attr-1",
      kind: "name",
      value: "Dana Hiring-Manager",
      provenance: {
        sourceKind: "public_web_page",
        sourceRef: "https://acme.example/team",
        captureMethod: "llm_assisted",
        capturedAt: "2026-07-06T00:00:00+00:00",
        confidence: 0.8,
        userConfirmed: false,
      },
    },
    {
      attributeId: "attr-2",
      kind: "email",
      value: "dana@acme.example",
      provenance: {
        sourceKind: "public_web_page",
        sourceRef: "https://acme.example/team",
        captureMethod: "llm_assisted",
        capturedAt: "2026-07-06T00:00:00+00:00",
        confidence: 0.8,
        userConfirmed: false,
      },
    },
  ],
  confirmedContactId: null,
  confirmedAt: null,
};

export const sampleSourceAttempts: ContactResearchSourceAttempt[] = [
  {
    sourceKind: "public_web_page",
    sourceRef: "https://acme.example/team",
    outcome: "allowed",
    attemptedAt: "2026-07-06T00:00:00+00:00",
    detail: "proposed:1",
  },
  {
    sourceKind: "public_web_page",
    sourceRef: "https://acme.example/login",
    outcome: "manual_capture_required",
    attemptedAt: "2026-07-06T00:00:01+00:00",
    detail: "login_required",
  },
];

export function makeResearchTaskSummary(
  overrides: Partial<ContactResearchTaskSummary> = {},
): ContactResearchTaskSummary {
  return {
    taskId: "task-1",
    employer: "Acme",
    jobId: "job-1",
    status: "needs_review",
    candidateCount: 1,
    needsReviewCount: 1,
    confirmedCount: 0,
    startedAt: "2026-07-06T00:00:00+00:00",
    updatedAt: "2026-07-06T00:00:02+00:00",
    needsReviewAt: "2026-07-06T00:00:02+00:00",
    completedAt: null,
    failedAt: null,
    errorClass: null,
    ...overrides,
  };
}

export function makeResearchTaskDetail(
  overrides: Partial<ContactResearchTaskDetail> = {},
): ContactResearchTaskDetail {
  return {
    ...makeResearchTaskSummary(),
    sourceAttempts: sampleSourceAttempts,
    candidates: [sampleCandidate],
    ...overrides,
  };
}

export const sampleResearchTaskSummary = makeResearchTaskSummary();
export const sampleResearchTaskDetail = makeResearchTaskDetail();

export function makeResearchListResponse(
  items: readonly ContactResearchTaskSummary[] = [sampleResearchTaskSummary],
): ContactResearchListResponse {
  return { ok: true, items: [...items] };
}

export function makeResearchDetailResponse(
  task: ContactResearchTaskDetail = sampleResearchTaskDetail,
): ContactResearchDetailResponse {
  return { ok: true, task };
}

export function makeConfirmCandidateResponse(): ConfirmContactCandidateResponse {
  return {
    ok: true,
    contact: makeContactDetail(),
    task: makeResearchTaskSummary({ status: "completed", needsReviewCount: 0, confirmedCount: 1 }),
  };
}
