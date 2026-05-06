import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { createDomainEvent } from "../src/events/base.js";
import { createJobDiscovered } from "../src/events/discovery.js";
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
