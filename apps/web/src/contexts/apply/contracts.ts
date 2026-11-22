import { z } from "zod";

const metadata = z.record(z.string(), z.unknown());
const identity = z.string().min(1);
const nullableIdentity = identity.nullable();
const hash = z.string().length(64);

const decisionSchema = z
  .object({
    decisionId: identity,
    jobId: identity,
    decision: z.enum([
      "approve_submit",
      "approve_dry_run",
      "defer",
      "decline",
      "reset",
    ]),
    decidedAt: z.string(),
    reason: z.string().nullable().optional(),
    payloadId: nullableIdentity.optional(),
    payloadSha256: hash.nullable().optional(),
    rehearsalId: nullableIdentity.optional(),
    partialOverrideRunId: nullableIdentity.optional(),
  })
  .passthrough();
const inspectionSchema = z
  .object({
    status: z.enum([
      "ready",
      "expired",
      "captcha",
      "login_required",
      "email_only",
      "manual",
      "failed",
      "uncertain",
    ]),
    findings: z.array(z.string()),
    citations: z.array(z.object({ source_id: z.string(), quote: z.string() })),
    emailCandidate: z
      .object({
        recipient: z.string(),
        subject: z.string(),
        body: z.string(),
        attachmentArtifactId: z.string().nullable(),
        attachmentName: z.string(),
        requiresNewPayloadAndApproval: z.literal(true),
      })
      .nullable(),
    rationale: z.string(),
    determinationId: identity,
  })
  .passthrough();
const rehearsalSchema = z
  .object({
    rehearsalId: identity,
    runId: identity,
    jobId: identity,
    payloadId: identity,
    payloadSha256: hash,
    status: z.string(),
    coverage: z.enum(["full", "partial"]),
    checks: z.array(z.string()),
    blockedMutationCount: z.number().int().nonnegative(),
    finishedAt: z.string(),
    inspection: inspectionSchema.nullable(),
  })
  .passthrough();
const runSchema = z
  .object({
    runId: identity,
    jobId: identity,
    payloadId: identity,
    payloadSha256: hash,
    approvalId: identity,
    mode: z.enum(["browser", "email"]),
    status: z.string(),
    startedAt: z.string(),
  })
  .passthrough();
const screeningPayloadSchema = z.object({
  questionId: identity,
  revision: z.number().int().nonnegative(),
  snapshotId: identity,
  reviewId: identity,
  answerId: identity,
  question: z.string(),
  text: z.string(),
});
const resumeBindingSchema = z
  .object({
    resumeId: identity,
    revisionId: identity,
    acceptanceId: identity,
    profileRevision: z.number().int(),
    reviewStatus: z.string(),
    reviewOverride: z.boolean(),
    pdf: z
      .object({
        artifactId: z.string().nullable(),
        sha256: hash,
        sizeBytes: z.number().int(),
      })
      .passthrough(),
  })
  .passthrough();
const payloadSchema = z
  .object({
    payloadId: identity,
    jobId: identity,
    payloadSha256: hash,
    mode: z.enum(["browser", "email"]),
    applicationUrl: z.string(),
    createdAt: z.string(),
    attachmentName: z.string(),
    recipient: z.string().nullable(),
    subject: z.string().nullable(),
    body: z.string().nullable(),
    fields: z.array(
      z.object({
        path: z.string(),
        label: z.string(),
        value: z.string(),
        source: metadata,
      }),
    ),
    screeningAnswers: z.array(screeningPayloadSchema),
    sources: z
      .object({
        profile: z
          .object({
            profileId: identity,
            revision: z.number().int(),
            fingerprint: z.string(),
          })
          .passthrough(),
        job: z
          .object({
            jobId: identity,
            revision: z.number().int(),
            applicationUrl: z.string(),
            sourceHash: z.string(),
          })
          .passthrough(),
        resume: resumeBindingSchema,
      })
      .passthrough(),
  })
  .passthrough();
export const applicationSchema = z.object({
  jobId: identity,
  version: z.number().int().nonnegative(),
  status: z.string(),
  payloadId: nullableIdentity,
  runId: nullableIdentity,
  latestDecision: decisionSchema.nullable(),
  stopped: z.boolean(),
  updatedAt: z.string().nullable(),
  payload: payloadSchema.nullable(),
  decisions: z.array(decisionSchema),
  rehearsals: z.array(rehearsalSchema),
  runs: z.array(runSchema),
  intent: z
    .object({
      intentId: identity,
      runId: identity,
      payloadId: identity,
      payloadSha256: hash,
      createdAt: z.string(),
    })
    .nullable(),
  receipt: z
    .object({
      runId: identity,
      recordedAt: z.string(),
      confirmed: z.literal(true),
    })
    .nullable(),
  job: z.object({
    jobId: identity,
    title: z.string().nullable(),
    employer: z.string().nullable(),
    source: z.string().nullable(),
    applicationUrl: z.string().nullable(),
    postingUrl: z.string().nullable(),
    activeState: z.string().nullable(),
  }),
  approvalCurrent: z.boolean(),
  approvalBlockReason: z.string().nullable(),
  confirmedApplication: z.boolean(),
  canExecute: z.boolean(),
  attemptCount: z.number().int().nonnegative().optional(),
});
export const repeatApplicationSchema = z.object({
  ok: z.literal(true),
  jobId: identity,
  status: z.enum([
    "clear",
    "same_opening",
    "check_required",
    "same_employer_equivalent_role",
    "uncertain",
  ]),
  evidenceSha256: hash,
  checkId: nullableIdentity,
  matchedApplications: z.array(identity),
  blockReason: z.string().nullable(),
  override: z
    .object({
      overrideId: identity,
      createdAt: z.string(),
      usedByRunId: nullableIdentity,
      usedAt: z.string().nullable(),
    })
    .nullable(),
  determinationIds: z.array(identity).optional(),
  recordedAt: z.string().optional(),
});
export type RepeatApplication = z.infer<typeof repeatApplicationSchema>;
export const applicationResponseSchema = z.object({
  ok: z.literal(true),
  application: applicationSchema,
});
export const applicationQueueSchema = z.object({
  ok: z.literal(true),
  items: z.array(applicationSchema),
});
export const actionReceiptSchema = z.object({
  runId: identity,
  workflowId: identity,
  status: z.string(),
});
export const actionRunSchema = actionReceiptSchema
  .extend({
    action: z.string(),
    result: z.unknown().nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    cancellationRequested: z.boolean(),
    temporalRunId: z.string().nullable(),
  })
  .passthrough();

export type Application = z.infer<typeof applicationSchema>;
export type ApplicationPayload = z.infer<typeof payloadSchema>;
export type ApplicationRehearsal = z.infer<typeof rehearsalSchema>;
export type ApplicationDecision = z.infer<typeof decisionSchema>;
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export type ApplicationActionRun = z.infer<typeof actionRunSchema>;
export interface PrepareApplication {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly mode: "browser" | "email";
  readonly recipient?: string;
  readonly subject?: string;
  readonly body?: string;
}
export interface ReviewApplication {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly decision: ApplicationDecision["decision"];
  readonly payloadId?: string;
  readonly payloadSha256?: string;
  readonly rehearsalId?: string;
  readonly partialOverrideRunId?: string;
  readonly reason?: string;
}
export interface ControlApplication {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly action: "skip" | "cancel" | "reset";
}
export type ApplicationCommand =
  | { readonly kind: "prepare"; readonly body: PrepareApplication }
  | { readonly kind: "review"; readonly body: ReviewApplication }
  | { readonly kind: "control"; readonly body: ControlApplication }
  | {
      readonly kind: "rehearse";
      readonly payloadId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "execute";
      readonly payloadId: string;
      readonly approvalId: string;
      readonly idempotencyKey: string;
    }
  | { readonly kind: "repeat_check"; readonly idempotencyKey: string }
  | {
      readonly kind: "repeat_override";
      readonly body: {
        readonly idempotencyKey: string;
        readonly expectedCheckId: string;
        readonly evidenceSha256: string;
        readonly reason: string;
      };
    }
  | {
      readonly kind: "cancelRun";
      readonly runId: string;
      readonly idempotencyKey: string;
    };

const answerSchema = z
  .object({
    answerId: identity,
    text: z.string(),
    uncertainty: z.string(),
    question: z.string(),
    context: z.string(),
    binding: metadata,
    determinationIds: z.array(identity),
    reviewId: identity.optional(),
    staleReason: z.string().nullable().optional(),
  })
  .passthrough();
export const screeningQuestionSchema = z
  .object({
    questionId: identity,
    jobId: identity,
    applicationId: identity,
    revision: z.number().int().nonnegative(),
    question: z.string(),
    context: z.string(),
    draft: answerSchema.nullable(),
    accepted: answerSchema.nullable(),
    captureBinding: metadata,
    snapshotId: identity,
    recordedAt: z.string(),
    action: z.string(),
    selection: z
      .object({
        factIds: z.array(identity),
        sensitiveFactIds: z.array(identity),
      })
      .optional(),
    manualUse: z
      .object({
        text: z.string(),
        changed: z.boolean(),
        attested: z.literal(true),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const screeningReadSchema = z.object({
  ok: z.literal(true),
  jobId: identity,
  questions: z.array(screeningQuestionSchema),
  history: z.array(screeningQuestionSchema),
  library: z.array(
    z
      .object({
        libraryId: identity,
        answer: answerSchema,
        applicationId: identity,
      })
      .passthrough(),
  ),
  facts: z.array(
    z.object({ id: identity, text: z.string(), sensitive: z.boolean() }),
  ),
  sourceBinding: metadata.nullable(),
  sourceFailure: z.string().nullable(),
  failures: z.array(
    z.object({
      questionId: z.string().nullable(),
      action: z.string(),
      code: z.string(),
      recordedAt: z.string(),
    }),
  ),
  determinations: z.array(metadata),
});
export const screeningResponseSchema = z.object({
  ok: z.literal(true),
  jobId: identity,
  state: screeningQuestionSchema,
});
export type ScreeningRead = z.infer<typeof screeningReadSchema>;
export type ScreeningQuestion = z.infer<typeof screeningQuestionSchema>;
export interface ScreeningCommand {
  readonly action: "capture" | "draft" | "edit" | "review" | "reuse" | "use";
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly questionId?: string;
  readonly applicationId?: string;
  readonly question?: string;
  readonly context?: string;
  readonly selectedFactIds: string[];
  readonly sensitiveFactIds: string[];
  readonly text?: string;
  readonly decision?: "approved" | "rejected";
  readonly libraryId?: string;
  readonly attested: boolean;
}
