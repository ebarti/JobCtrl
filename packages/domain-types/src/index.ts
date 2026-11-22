/**
 * @jobctrl/domain-types — shared domain vocabulary.
 *
 * Shared vocabulary for client-side data and event consumers.
 */

export { type TenantId, createTenantId, LOCAL_TENANT } from "./tenant.js";

export {
  type JobId,
  createJobId,
  generateJobId,
  type ContactId,
  createContactId,
  generateContactId,
  type ResearchTaskId,
  createResearchTaskId,
  generateResearchTaskId,
  type OutreachThreadId,
  createOutreachThreadId,
  generateOutreachThreadId,
} from "./identifiers.js";

export * from "./contact.js";

export * from "./interview/index.js";

export * from "./apply/index.js";
