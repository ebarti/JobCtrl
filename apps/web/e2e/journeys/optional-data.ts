/** Shapes used for public responses in the synthetic optional-feature journeys. */
export type Contact = {
  contactId: string;
  fingerprint: string;
  revision: number;
  displayName: string;
  attributes: {
    attributeId: string;
    kind: string;
    value: string;
    provenance: { userConfirmed: boolean };
  }[];
};

export type Thread = {
  threadId: string;
  fingerprint: string;
  revision: number;
  approvedDraftId: string | null;
  drafts: {
    draftId: string;
    status: string;
    bodyText: string;
    sourcesCurrent: boolean;
    reviewAuthorityVerified: boolean;
    gateResults: { passed: boolean; determinationIds: string[] };
  }[];
  sendLogs: SendLog[];
  followUp: { state: string; dueAt: string } | null;
};

export type SendLog = {
  sendLogId: string;
  threadId: string;
  draftId: string;
  channel: string;
  sentAt: string;
  loggedAt: string;
};

export type Learning = {
  preview: { fingerprint: string; analyzedCount: number } | null;
  cohorts: {
    cohortId: string;
    revision: number;
    determinationId: string;
    comparison: { demands: { demand_id: string; capability: string }[] };
  }[];
  milestones: {
    milestoneId: string;
    revision: number;
    status: string;
    completionEvidence: string;
    history: { revision: number; status: string }[];
  }[];
};

export type Offer = {
  currentTerms: {
    revisionId: string;
    terms: {
      cash: { amount: number }[];
      equity: unknown;
      benefits: unknown;
      decisionDeadline: unknown;
    };
  } | null;
  termsHistory: { revisionId: string; terms: { cash: { amount: number }[] } }[];
  currentDecision: {
    decisionId: string;
    decision: string;
    correctionReason?: string;
  } | null;
  decisions: { decisionId: string; decision: string }[];
};

export type Source = { source_id: string; text: string };

export type DeterminationAudit = {
  complete: boolean;
  authorityVerified: boolean;
  records: {
    determinationId: string;
    available: boolean;
    verified: boolean;
    accepted?: boolean;
    operation: string;
    instructions: string;
    responseSchema: unknown;
    context: unknown;
    sources: Source[];
    result: unknown;
    provenance: {
      receipt_id: string;
      provider: string;
      model: string;
      lane: string;
    };
  }[];
};

/** Read only the actual sources supplied at the external model boundary. */
export function sources(body: Record<string, unknown>): Source[] {
  if (!Array.isArray(body["sources"]))
    throw new Error("The model request did not include sources");
  return body["sources"] as Source[];
}
