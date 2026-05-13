import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { createDomainEvent } from "../src/events/base.js";
import { DOMAIN_EVENT_TYPES } from "../src/events/index.js";
import {
  createCanonicalJobIdentityResolved,
  createDuplicateJobLinked,
  createDuplicateJobLinkRejected,
  createJobDiscovered,
  createJobSourceObserved,
  createSourceLocationCandidateDiscovered,
  createSourceLocationCandidatePromoted,
  createSourceRegistryEntryCreated,
  createSourceRegistryEntryUpdated,
  createSourceStateChanged,
} from "../src/events/discovery.js";
import { createJobEnriched } from "../src/events/enrichment.js";
import { createJobScored } from "../src/events/scoring.js";
import { createResumeApproved, createMaterialsExhausted } from "../src/events/materials.js";
import { createApplicationSubmitted, createApplyRunStarted } from "../src/events/apply.js";
import { createStageStarted, createStageCompleted } from "../src/events/orchestration.js";
import { createProfileUpdated, createProfileImported } from "../src/events/profile.js";

describe("DomainEvent base", () => {
  it("createDomainEvent sets envelope fields", () => {
    const event = createDomainEvent("TestEvent", LOCAL_TENANT, { foo: "bar" });
    expect(event.eventType).toBe("TestEvent");
    expect(event.tenantId).toBe("local");
    expect(event.occurredAt).toBeTruthy();
    expect(event.payload).toEqual({ foo: "bar" });
  });

  it("createDomainEvent accepts custom occurredAt", () => {
    const ts = "2025-01-01T12:00:00Z";
    const event = createDomainEvent("X", LOCAL_TENANT, {}, ts);
    expect(event.occurredAt).toBe(ts);
  });
});

describe("Discovery events", () => {
  it("JobDiscovered carries tenantId and all payload fields", () => {
    const event = createJobDiscovered(LOCAL_TENANT, {
      jobId: "j1",
      postingUrl: "https://example.com/job",
      source: "linkedin",
      employer: "Acme",
      metadata: { title: "Engineer" },
      discoveredAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("JobDiscovered");
    expect(event.tenantId).toBe("local");
    expect(event.payload.jobId).toBe("j1");
    expect(event.payload.source).toBe("linkedin");
  });

  it("SourceLocationCandidateDiscovered carries locator fields", () => {
    const event = createSourceLocationCandidateDiscovered(LOCAL_TENANT, {
      candidateId: "candidate-1",
      candidateUrl: "https://example.com/careers",
      sourceKind: "employer_careers_page",
      confidence: 0.82,
      evidenceRef: "evidence:candidate-1",
      discoveredAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("SourceLocationCandidateDiscovered");
    expect(event.payload.sourceKind).toBe("employer_careers_page");
  });

  it("SourceRegistryEntryCreated carries source state", () => {
    const event = createSourceRegistryEntryCreated(LOCAL_TENANT, {
      sourceId: "smart_extract:remoteok",
      kind: "smart_extract",
      policyId: "smart_extract_experimental",
      state: "experimental",
      createdAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("SourceRegistryEntryCreated");
    expect(event.payload.state).toBe("experimental");
  });

  it("JobSourceObserved carries observation attribution", () => {
    const event = createJobSourceObserved(LOCAL_TENANT, {
      jobId: "j1",
      sourceObservationId: "observation-1",
      sourceId: "greenhouse:acme",
      sourceNativeId: "123456",
      observedUrl: "https://boards.greenhouse.io/acme/jobs/123456",
      runId: "run-1",
      observedAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("JobSourceObserved");
    expect(event.payload.sourceObservationId).toBe("observation-1");
    expect(event.payload.runId).toBe("run-1");
  });

  it("CanonicalJobIdentityResolved carries ATS identity fields", () => {
    const event = createCanonicalJobIdentityResolved(LOCAL_TENANT, {
      jobId: "j1",
      canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123456",
      atsKind: "greenhouse",
      sourceNativeId: "123456",
      confidence: 0.98,
    });
    expect(event.eventType).toBe("CanonicalJobIdentityResolved");
    expect(event.payload.atsKind).toBe("greenhouse");
    expect(event.payload.confidence).toBe(0.98);
  });

  it("DuplicateJobLinked carries the survivor and superseded ids", () => {
    const event = createDuplicateJobLinked(LOCAL_TENANT, {
      duplicateLinkId: "duplicate-link-1",
      survivingJobId: "j1",
      supersededJobOrObservationId: "observation-2",
      reason: "ats_identity_match",
      confidence: 0.96,
    });
    expect(event.eventType).toBe("DuplicateJobLinked");
    expect(event.payload.survivingJobId).toBe("j1");
    expect(event.payload.supersededJobOrObservationId).toBe("observation-2");
  });

  it("DuplicateJobLinkRejected carries rejected duplicate candidates", () => {
    const event = createDuplicateJobLinkRejected(LOCAL_TENANT, {
      duplicateLinkId: "duplicate-link-rejected-1",
      candidateIds: ["j1", "j2"],
      reason: "low_confidence",
      rejectedAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("DuplicateJobLinkRejected");
    expect(event.payload.candidateIds).toEqual(["j1", "j2"]);
  });
});

describe("Enrichment events", () => {
  it("JobEnriched has required fields", () => {
    const event = createJobEnriched(LOCAL_TENANT, {
      jobId: "j1",
      fullDescription: "Full desc",
      applicationUrl: "https://apply.example.com",
      extractionTier: "json_ld",
      enrichedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("JobEnriched");
    expect(event.tenantId).toBe("local");
    expect(event.payload.extractionTier).toBe("json_ld");
  });
});

describe("Scoring events", () => {
  it("JobScored has required fields", () => {
    const event = createJobScored(LOCAL_TENANT, {
      jobId: "j1",
      fitScore: 8,
      breakdown: { technicalFit: 9 },
      keywords: ["python", "react"],
      version: 1,
      scoredAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("JobScored");
    expect(event.tenantId).toBe("local");
    expect(event.payload.fitScore).toBe(8);
    expect(event.payload.keywords).toEqual(["python", "react"]);
  });
});

describe("Materials events", () => {
  it("ResumeApproved has required fields", () => {
    const event = createResumeApproved(LOCAL_TENANT, {
      jobId: "j1",
      artifactId: "a1",
      generation: 1,
      approvedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ResumeApproved");
    expect(event.tenantId).toBe("local");
  });

  it("MaterialsExhausted has required fields", () => {
    const event = createMaterialsExhausted(LOCAL_TENANT, {
      jobId: "j1",
      stage: "tailor",
      attemptCount: 3,
      maxAttempts: 3,
    });
    expect(event.eventType).toBe("MaterialsExhausted");
    expect(event.payload.attemptCount).toBe(3);
  });
});

describe("Apply events", () => {
  it("ApplicationSubmitted has required fields", () => {
    const event = createApplicationSubmitted(LOCAL_TENANT, {
      jobId: "j1",
      runId: "r1",
      appliedAt: "2025-01-01T00:00:00Z",
      verificationConfidence: 0.95,
    });
    expect(event.eventType).toBe("ApplicationSubmitted");
    expect(event.tenantId).toBe("local");
    expect(event.payload.verificationConfidence).toBe(0.95);
  });

  it("ApplyRunStarted has required fields", () => {
    const event = createApplyRunStarted(LOCAL_TENANT, {
      jobId: "j1",
      runId: "r1",
      workerId: "w1",
      model: "haiku",
      dryRun: false,
      startedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ApplyRunStarted");
    expect(event.payload.dryRun).toBe(false);
  });
});

describe("Orchestration events", () => {
  it("StageStarted has required fields", () => {
    const event = createStageStarted(LOCAL_TENANT, {
      jobId: "j1",
      stage: "enrich",
      attemptNumber: 1,
      startedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("StageStarted");
    expect(event.tenantId).toBe("local");
    expect(event.payload.stage).toBe("enrich");
  });

  it("StageCompleted has required fields", () => {
    const event = createStageCompleted(LOCAL_TENANT, {
      jobId: "j1",
      stage: "score",
      finishedAt: "2025-01-01T00:00:00Z",
      durationMs: 5000,
    });
    expect(event.eventType).toBe("StageCompleted");
    expect(event.payload.durationMs).toBe(5000);
  });
});

describe("Profile events", () => {
  it("ProfileUpdated has required fields", () => {
    const event = createProfileUpdated(LOCAL_TENANT, {
      changedSections: ["experience", "skills"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ProfileUpdated");
    expect(event.tenantId).toBe("local");
    expect(event.payload.changedSections).toEqual(["experience", "skills"]);
  });

  it("ProfileImported has required fields", () => {
    const event = createProfileImported(LOCAL_TENANT, {
      source: "resume.pdf",
      importedSections: ["experience", "education"],
      importedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ProfileImported");
    expect(event.payload.source).toBe("resume.pdf");
  });
});

describe("All events carry tenantId", () => {
  const factories = [
    () =>
      createJobDiscovered(LOCAL_TENANT, {
        jobId: "j1",
        postingUrl: "u",
        source: "s",
        employer: "e",
        metadata: {},
        discoveredAt: "t",
      }),
    () =>
      createSourceRegistryEntryCreated(LOCAL_TENANT, {
        sourceId: "source-1",
        kind: "smart_extract",
        policyId: "smart_extract_experimental",
        state: "experimental",
        createdAt: "t",
      }),
    () =>
      createJobSourceObserved(LOCAL_TENANT, {
        jobId: "j1",
        sourceObservationId: "observation-1",
        sourceId: "greenhouse:acme",
        sourceNativeId: "123456",
        observedUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        runId: "run-1",
        observedAt: "t",
      }),
    () =>
      createJobEnriched(LOCAL_TENANT, {
        jobId: "j1",
        fullDescription: "d",
        applicationUrl: "u",
        extractionTier: "t",
        enrichedAt: "t",
      }),
    () =>
      createJobScored(LOCAL_TENANT, {
        jobId: "j1",
        fitScore: 5,
        breakdown: {},
        keywords: [],
        version: 1,
        scoredAt: "t",
      }),
    () =>
      createResumeApproved(LOCAL_TENANT, {
        jobId: "j1",
        artifactId: "a1",
        generation: 1,
        approvedAt: "t",
      }),
    () =>
      createApplicationSubmitted(LOCAL_TENANT, {
        jobId: "j1",
        runId: "r1",
        appliedAt: "t",
        verificationConfidence: 0.9,
      }),
    () =>
      createStageStarted(LOCAL_TENANT, {
        jobId: "j1",
        stage: "enrich",
        attemptNumber: 1,
        startedAt: "t",
      }),
    () =>
      createProfileUpdated(LOCAL_TENANT, {
        changedSections: [],
        updatedAt: "t",
      }),
  ];

  for (const factory of factories) {
    const event = factory();
    it(`${event.eventType} has tenantId`, () => {
      expect(event.tenantId).toBe("local");
    });
  }
});

describe("DOMAIN_EVENT_TYPES enumeration", () => {
  it("lists every variant of DomainEventUnion exactly once", () => {
    expect(DOMAIN_EVENT_TYPES).toHaveLength(36);
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
  });

  it("matches the names emitted by every event creator factory", () => {
    const fromFactories = new Set([
      createJobDiscovered(LOCAL_TENANT, {
        jobId: "j",
        postingUrl: "u",
        source: "s",
        employer: "e",
        metadata: {},
        discoveredAt: "t",
      }).eventType,
      createSourceLocationCandidateDiscovered(LOCAL_TENANT, {
        candidateId: "candidate-1",
        candidateUrl: "https://example.com/careers",
        sourceKind: "employer_careers_page",
        confidence: 0.8,
        evidenceRef: "evidence:candidate-1",
        discoveredAt: "t",
      }).eventType,
      createSourceLocationCandidatePromoted(LOCAL_TENANT, {
        candidateId: "candidate-1",
        sourceId: "source-1",
        promotedAt: "t",
      }).eventType,
      createSourceRegistryEntryCreated(LOCAL_TENANT, {
        sourceId: "source-1",
        kind: "smart_extract",
        policyId: "smart_extract_experimental",
        state: "experimental",
        createdAt: "t",
      }).eventType,
      createSourceRegistryEntryUpdated(LOCAL_TENANT, {
        sourceId: "source-1",
        changedFields: ["state"],
        updatedAt: "t",
      }).eventType,
      createSourceStateChanged(LOCAL_TENANT, {
        sourceId: "source-1",
        fromState: "experimental",
        toState: "active",
        reason: "validated",
        changedAt: "t",
      }).eventType,
      createJobSourceObserved(LOCAL_TENANT, {
        jobId: "j",
        sourceObservationId: "observation-1",
        sourceId: "greenhouse:acme",
        sourceNativeId: "123456",
        observedUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        runId: "run-1",
        observedAt: "t",
      }).eventType,
      createCanonicalJobIdentityResolved(LOCAL_TENANT, {
        jobId: "j",
        canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        atsKind: "greenhouse",
        sourceNativeId: "123456",
        confidence: 0.98,
      }).eventType,
      createDuplicateJobLinked(LOCAL_TENANT, {
        duplicateLinkId: "duplicate-link-1",
        survivingJobId: "j",
        supersededJobOrObservationId: "observation-2",
        reason: "ats_identity_match",
        confidence: 0.96,
      }).eventType,
      createDuplicateJobLinkRejected(LOCAL_TENANT, {
        duplicateLinkId: "duplicate-link-rejected-1",
        candidateIds: ["j", "j2"],
        reason: "low_confidence",
        rejectedAt: "t",
      }).eventType,
      createJobEnriched(LOCAL_TENANT, {
        jobId: "j",
        fullDescription: "d",
        applicationUrl: "u",
        extractionTier: "t",
        enrichedAt: "t",
      }).eventType,
      createJobScored(LOCAL_TENANT, {
        jobId: "j",
        fitScore: 1,
        breakdown: {},
        keywords: [],
        version: 1,
        scoredAt: "t",
      }).eventType,
      createResumeApproved(LOCAL_TENANT, {
        jobId: "j",
        artifactId: "a",
        generation: 1,
        approvedAt: "t",
      }).eventType,
      createMaterialsExhausted(LOCAL_TENANT, {
        jobId: "j",
        stage: "tailor",
        attemptCount: 1,
        maxAttempts: 1,
      }).eventType,
      createApplicationSubmitted(LOCAL_TENANT, {
        jobId: "j",
        runId: "r",
        appliedAt: "t",
        verificationConfidence: 0.5,
      }).eventType,
      createApplyRunStarted(LOCAL_TENANT, {
        jobId: "j",
        runId: "r",
        workerId: "w",
        model: "m",
        dryRun: false,
        startedAt: "t",
      }).eventType,
      createStageStarted(LOCAL_TENANT, {
        jobId: "j",
        stage: "enrich",
        attemptNumber: 1,
        startedAt: "t",
      }).eventType,
      createStageCompleted(LOCAL_TENANT, {
        jobId: "j",
        stage: "enrich",
        finishedAt: "t",
        durationMs: 1,
      }).eventType,
      createProfileUpdated(LOCAL_TENANT, {
        changedSections: [],
        updatedAt: "t",
      }).eventType,
      createProfileImported(LOCAL_TENANT, {
        source: "x",
        importedSections: [],
        importedAt: "t",
      }).eventType,
    ]);
    for (const eventType of fromFactories) {
      expect(DOMAIN_EVENT_TYPES).toContain(eventType);
    }
  });
});
