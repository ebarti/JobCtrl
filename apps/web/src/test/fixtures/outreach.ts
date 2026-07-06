import type {
  OutreachClaimProvenanceDto,
  OutreachDraftDto,
  OutreachDraftGateResults,
  OutreachDraftStatus,
  OutreachThreadDetail,
  OutreachThreadResponse,
} from "@jobhunter/contracts";

export function makeGateResultsPassing(
  overrides: Partial<OutreachDraftGateResults> = {},
): OutreachDraftGateResults {
  return {
    passed: true,
    computedAgainst: "draft:generated-body",
    fabrications: [],
    validation: { passed: true, errors: [], warnings: [] },
    judge: {
      approved: true,
      score: 0.92,
      criterionScores: { truthfulness: 0.95, tone: 0.9, specificity: 0.9 },
      issues: [],
      notes: "Grounded in confirmed contact facts and profile evidence.",
    },
    ...overrides,
  };
}

export function makeGateResultsBlocked(
  overrides: Partial<OutreachDraftGateResults> = {},
): OutreachDraftGateResults {
  return {
    passed: false,
    computedAgainst: "draft:generated-body",
    fabrications: [
      {
        section: "opening",
        kind: "unverified_metric",
        token: "40% faster",
        control: "never_fabricate_metrics",
        generatedText: "I led a project that made the pipeline 40% faster.",
      },
    ],
    validation: {
      passed: false,
      errors: ["Claim not grounded in any confirmed fact."],
      warnings: ["Tone is slightly informal."],
    },
    judge: {
      approved: false,
      score: 0.41,
      criterionScores: { truthfulness: 0.2, tone: 0.7 },
      issues: ["Fabricated performance metric.", "Unverifiable seniority claim."],
      notes: "Blocked: contains a metric with no supporting evidence.",
    },
    ...overrides,
  };
}

export function makeClaimProvenance(): OutreachClaimProvenanceDto[] {
  return [
    {
      claimId: "claim-1",
      section: "opening",
      generatedText: "I noticed you lead the platform team at Acme.",
      contactFactIds: ["attr-title", "attr-name"],
      profileGrounded: false,
      rationale: "Bound to the contact's confirmed title and name.",
    },
    {
      claimId: "claim-2",
      section: "body",
      generatedText: "I have shipped incident-response tooling at scale.",
      contactFactIds: [],
      profileGrounded: true,
      rationale: "Grounded in the user's profile experience; no contact fact required.",
    },
  ];
}

export function makeOutreachDraft(overrides: Partial<OutreachDraftDto> = {}): OutreachDraftDto {
  return {
    draftId: "draft-1",
    threadId: "thread-1",
    generation: 1,
    kind: "intro_request",
    status: "candidate",
    bodyText: "Hi Dana,\n\nI noticed you lead the platform team at Acme and wanted to introduce myself.\n\nBest,\nJordan",
    gateResults: makeGateResultsPassing(),
    provenance: makeClaimProvenance(),
    createdAt: "2026-07-06T00:00:00+00:00",
    approvedAt: null,
    rejectedAt: null,
    reason: "",
    ...overrides,
  };
}

function latestStatusOf(drafts: readonly OutreachDraftDto[]): OutreachDraftStatus | null {
  if (drafts.length === 0) {
    return null;
  }
  return drafts.reduce((latest, draft) =>
    draft.generation >= latest.generation ? draft : latest,
  ).status;
}

// The default thread demonstrates INV-5: a superseded prior generation, the
// current approved draft, and a fresh candidate under review — the approved draft
// is retained while a re-draft is reviewed, never destroyed.
export function makeOutreachThreadDetail(
  overrides: Partial<OutreachThreadDetail> = {},
): OutreachThreadDetail {
  const drafts = overrides.drafts ?? [
    makeOutreachDraft({
      draftId: "draft-1",
      generation: 1,
      status: "superseded",
      approvedAt: "2026-07-06T00:01:00+00:00",
      createdAt: "2026-07-06T00:00:00+00:00",
      bodyText: "Hi Dana,\n\nFirst approved intro, later superseded.\n\nBest,\nJordan",
    }),
    makeOutreachDraft({
      draftId: "draft-2",
      generation: 2,
      status: "approved",
      approvedAt: "2026-07-06T00:05:00+00:00",
      createdAt: "2026-07-06T00:04:00+00:00",
      bodyText: "Hi Dana,\n\nCurrent approved intro to the platform team.\n\nBest,\nJordan",
    }),
    makeOutreachDraft({
      draftId: "draft-3",
      generation: 3,
      status: "candidate",
      createdAt: "2026-07-06T00:10:00+00:00",
      bodyText: "Hi Dana,\n\nA fresh re-draft under review.\n\nBest,\nJordan",
    }),
  ];
  const approved = drafts.find((draft) => draft.status === "approved");
  return {
    threadId: "thread-1",
    contactId: "contact-1",
    jobId: null,
    draftCount: drafts.length,
    latestGeneration: drafts.reduce((max, draft) => Math.max(max, draft.generation), 0),
    hasApprovedDraft: Boolean(approved),
    approvedDraftId: approved?.draftId ?? null,
    latestStatus: latestStatusOf(drafts),
    createdAt: "2026-07-06T00:00:00+00:00",
    updatedAt: "2026-07-06T00:10:00+00:00",
    ...overrides,
    drafts,
  };
}

export function makeOutreachThreadResponse(
  thread: OutreachThreadDetail | null = makeOutreachThreadDetail(),
): OutreachThreadResponse {
  return { ok: true, thread };
}

export const sampleOutreachThreadDetail = makeOutreachThreadDetail();

// A single candidate under review with PASSING gates — for the "candidate" state.
export function makeCandidateThread(): OutreachThreadDetail {
  return makeOutreachThreadDetail({
    drafts: [makeOutreachDraft({ draftId: "draft-1", generation: 1, status: "candidate" })],
  });
}

// A single candidate blocked by a deterministic never-fabricate finding — for the
// blocked story/test where approval must be disabled.
export function makeBlockedCandidateThread(): OutreachThreadDetail {
  return makeOutreachThreadDetail({
    drafts: [
      makeOutreachDraft({
        draftId: "draft-blocked",
        generation: 1,
        status: "candidate",
        gateResults: makeGateResultsBlocked(),
        bodyText: "Hi Dana,\n\nI led a project that made the pipeline 40% faster.\n\nBest,\nJordan",
      }),
    ],
  });
}

// An approved draft kept while a later candidate was rejected (INV-5: rejecting a
// re-draft leaves the approved message untouched) — for the "rejected" state.
export function makeRejectedCandidateThread(): OutreachThreadDetail {
  return makeOutreachThreadDetail({
    drafts: [
      makeOutreachDraft({
        draftId: "draft-1",
        generation: 1,
        status: "approved",
        approvedAt: "2026-07-06T00:05:00+00:00",
      }),
      makeOutreachDraft({
        draftId: "draft-2",
        generation: 2,
        status: "rejected",
        rejectedAt: "2026-07-06T00:12:00+00:00",
        reason: "Too informal.",
        createdAt: "2026-07-06T00:11:00+00:00",
      }),
    ],
  });
}
