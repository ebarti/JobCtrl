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
