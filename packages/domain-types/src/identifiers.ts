/**
 * Domain identity types.
 *
 * JobId is a system-generated stable identifier for a job,
 * replacing URL-as-primary-key from the legacy schema.
 */

declare const __jobIdBrand: unique symbol;

/** Branded string type for compile-time job identity safety. */
export type JobId = string & { readonly [__jobIdBrand]: "JobId" };

/** Create a JobId from a raw string. Throws if empty. */
export function createJobId(value: string): JobId {
  if (!value || value.trim().length === 0) {
    throw new Error("JobId cannot be empty");
  }
  return value as JobId;
}

/** Generate a new random JobId using the platform crypto API. */
export function generateJobId(): JobId {
  return crypto.randomUUID() as JobId;
}

declare const __contactIdBrand: unique symbol;

/** Branded string type for compile-time contact identity safety. */
export type ContactId = string & { readonly [__contactIdBrand]: "ContactId" };

/** Create a ContactId from a raw string. Throws if empty. */
export function createContactId(value: string): ContactId {
  if (!value || value.trim().length === 0) {
    throw new Error("ContactId cannot be empty");
  }
  return value as ContactId;
}

/** Generate a new random ContactId using the platform crypto API. */
export function generateContactId(): ContactId {
  return crypto.randomUUID() as ContactId;
}

declare const __researchTaskIdBrand: unique symbol;

/** Branded string type for compile-time contact-research task identity safety. */
export type ResearchTaskId = string & { readonly [__researchTaskIdBrand]: "ResearchTaskId" };

/** Create a ResearchTaskId from a raw string. Throws if empty. */
export function createResearchTaskId(value: string): ResearchTaskId {
  if (!value || value.trim().length === 0) {
    throw new Error("ResearchTaskId cannot be empty");
  }
  return value as ResearchTaskId;
}

/** Generate a new random ResearchTaskId using the platform crypto API. */
export function generateResearchTaskId(): ResearchTaskId {
  return crypto.randomUUID() as ResearchTaskId;
}

declare const __outreachThreadIdBrand: unique symbol;

/** Branded string type for compile-time outreach-thread identity safety. */
export type OutreachThreadId = string & {
  readonly [__outreachThreadIdBrand]: "OutreachThreadId";
};

/** Create an OutreachThreadId from a raw string. Throws if empty. */
export function createOutreachThreadId(value: string): OutreachThreadId {
  if (!value || value.trim().length === 0) {
    throw new Error("OutreachThreadId cannot be empty");
  }
  return value as OutreachThreadId;
}

/** Generate a new random OutreachThreadId using the platform crypto API. */
export function generateOutreachThreadId(): OutreachThreadId {
  return crypto.randomUUID() as OutreachThreadId;
}
